/**
 * X API client wrapping twitter-api-v2.
 *
 * Why this wrapper exists:
 *  - normalize twitter-api-v2 responses into mex-next's narrow event types
 *  - centralize 429 backoff + 401 surfacing
 *  - make the rest of the codebase trivially mockable in tests
 *    (`TwitterApi` is constructor-injected; collector tests pass a stub)
 *
 * The Python reference (runtime/scripts/x_api_common.py) hand-rolled
 * OAuth1; here we delegate to twitter-api-v2 which handles signing
 * and pagination tokens. We keep the same logical surface so
 * downstream collectors translate 1:1 from the Python version.
 */

import { TwitterApi, type TweetV2, type UserV2, type ApiResponseError } from 'twitter-api-v2';
import { CircuitBreaker, CircuitOpenError } from '../utils/circuit-breaker.js';
import { retryWithBackoff } from '../utils/retry.js';
import {
  type MentionEvent,
  type PaginationOptions,
  type PostOptions,
  type PostResult,
  type TweetEvent,
  type XApiCredentials,
  type XApiSurface,
  type XUser,
  XApiError,
} from './types.js';

const DEFAULT_MAX_RESULTS = 25;
const MIN_TWITTER_MAX_RESULTS = 5;
const MAX_TWITTER_MAX_RESULTS = 100;

const TWEET_FIELDS = ['created_at', 'author_id', 'conversation_id', 'referenced_tweets'] as const;
const USER_FIELDS = ['id', 'name', 'username'] as const;

/**
 * Constructor-injected client factory. Tests substitute a fake.
 */
export type TwitterApiFactory = (creds: XApiCredentials) => TwitterApi;

const defaultFactory: TwitterApiFactory = (creds) =>
  new TwitterApi({
    appKey: creds.consumerKey,
    appSecret: creds.consumerSecret,
    accessToken: creds.accessToken,
    accessSecret: creds.accessTokenSecret,
  });

export interface XApiClientOptions {
  /** Optional override for tests. */
  factory?: TwitterApiFactory;
  /** Max retries on 429 / 5xx. Default 2 (so 3 total attempts). */
  maxRetries?: number;
  /** Initial backoff in ms on transient errors. Default 1000. */
  initialBackoffMs?: number;
  /** Max backoff in ms (cap). Default 30s. */
  maxBackoffMs?: number;
  /**
   * Circuit-breaker config. Pass `null` (or omit) to disable. Defaults
   * trip after 5 consecutive non-recoverable failures and open the
   * circuit for 60s.
   */
  circuit?: { failureThreshold: number; resetTimeoutMs: number; halfOpenAttempts?: number } | null;
  /** Fired when the X API circuit opens — operator escalation hook. */
  onCircuitOpen?: (error: CircuitOpenError) => void;
}

/**
 * Concrete X API client. Holds a single TwitterApi instance and
 * exposes a small, mockable surface.
 */
export class XApiClient implements XApiSurface {
  private readonly api: TwitterApi;
  private readonly maxRetries: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly breaker: CircuitBreaker | null;
  private readonly onCircuitOpen: ((error: CircuitOpenError) => void) | undefined;

  constructor(creds: XApiCredentials, opts: XApiClientOptions = {}) {
    const factory = opts.factory ?? defaultFactory;
    this.api = factory(creds);
    this.maxRetries = opts.maxRetries ?? 2;
    this.initialBackoffMs = opts.initialBackoffMs ?? 1000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    if (opts.circuit === null) {
      this.breaker = null;
    } else {
      const cfg = opts.circuit ?? { failureThreshold: 5, resetTimeoutMs: 60_000, halfOpenAttempts: 1 };
      this.breaker = new CircuitBreaker({
        failureThreshold: cfg.failureThreshold,
        resetTimeoutMs: cfg.resetTimeoutMs,
        halfOpenAttempts: cfg.halfOpenAttempts ?? 1,
      });
    }
    this.onCircuitOpen = opts.onCircuitOpen;
  }

  /** Inspect circuit state — used by health endpoint / observability. */
  get circuitState(): 'closed' | 'open' | 'half-open' | 'disabled' {
    return this.breaker ? this.breaker.getState() : 'disabled';
  }

  /** Reset circuit (e.g. operator-driven recovery). */
  resetCircuit(): void {
    this.breaker?.reset();
  }

  async post(text: string, opts: PostOptions = {}): Promise<PostResult> {
    return this.runWithRetry('post', async () => {
      const payload: Record<string, unknown> = { text };
      if (opts.inReplyTo) {
        payload['reply'] = { in_reply_to_tweet_id: opts.inReplyTo };
      }
      if (opts.quoteTweetId) {
        payload['quote_tweet_id'] = opts.quoteTweetId;
      }
      const response = await this.api.v2.tweet(payload as never);
      const id = response?.data?.id;
      if (!id) {
        throw new XApiError('post', 'tweet succeeded but id missing');
      }
      return { id };
    });
  }

  async getMentions(opts: PaginationOptions = {}): Promise<MentionEvent[]> {
    return this.runWithRetry('mentions', async () => {
      const me = await this.api.v2.me();
      const userId = me?.data?.id;
      if (!userId) {
        throw new XApiError('mentions', 'failed to resolve authenticated user id');
      }
      const params: Record<string, unknown> = {
        max_results: clampMaxResults(opts.max),
        'tweet.fields': [...TWEET_FIELDS],
        expansions: ['author_id', 'referenced_tweets.id'],
        'user.fields': [...USER_FIELDS],
      };
      if (opts.sinceId) {
        params['since_id'] = opts.sinceId;
      }
      const result = await this.api.v2.userMentionTimeline(userId, params as never);
      return parseMentionPayload(extractRawData(result));
    });
  }

  async searchRecent(query: string, opts: PaginationOptions = {}): Promise<TweetEvent[]> {
    return this.runWithRetry('search', async () => {
      const params: Record<string, unknown> = {
        max_results: clampMaxResults(opts.max),
        'tweet.fields': [...TWEET_FIELDS],
        expansions: ['author_id', 'referenced_tweets.id'],
        'user.fields': [...USER_FIELDS],
      };
      if (opts.sinceId) {
        params['since_id'] = opts.sinceId;
      }
      const result = await this.api.v2.search(query, params as never);
      return parseTweetPayload(extractRawData(result));
    });
  }

  async getUserTweets(userId: string, opts: PaginationOptions = {}): Promise<TweetEvent[]> {
    return this.runWithRetry('user_tweets', async () => {
      const params: Record<string, unknown> = {
        max_results: clampMaxResults(opts.max),
        exclude: ['retweets', 'replies'],
        'tweet.fields': [...TWEET_FIELDS],
      };
      if (opts.sinceId) {
        params['since_id'] = opts.sinceId;
      }
      const result = await this.api.v2.userTimeline(userId, params as never);
      return parseTweetPayload(extractRawData(result));
    });
  }

  async getUserByHandle(handle: string): Promise<XUser> {
    return this.runWithRetry('user_lookup', async () => {
      const cleanHandle = handle.trim().replace(/^@/, '');
      if (!cleanHandle) {
        throw new XApiError('user_lookup', 'handle is required');
      }
      const result = await this.api.v2.userByUsername(cleanHandle, {
        'user.fields': [...USER_FIELDS],
      } as never);
      const user = (result?.data ?? null) as UserV2 | null;
      if (!user || !user.id) {
        throw new XApiError('user_lookup', `user not found: ${cleanHandle}`);
      }
      return {
        id: user.id,
        name: user.name ?? '',
        handle: user.username ?? cleanHandle,
      };
    });
  }

  async deleteTweet(id: string): Promise<void> {
    await this.runWithRetry('delete', async () => {
      await this.api.v2.deleteTweet(id);
      return null;
    });
  }

  private async runWithRetry<T>(kind: string, fn: () => Promise<T>): Promise<T> {
    const guarded = (): Promise<T> =>
      retryWithBackoff(
        async () => {
          try {
            return await fn();
          } catch (error: unknown) {
            // Wrap into XApiError once we KNOW we won't retry further.
            // We need the raw status visible to `shouldRetry` so we
            // re-throw the original error here; the outer catch below
            // wraps the final / non-retriable case.
            throw error;
          }
        },
        {
          attempts: this.maxRetries + 1,
          initialDelayMs: this.initialBackoffMs,
          maxDelayMs: this.maxBackoffMs,
          backoffFactor: 2,
          shouldRetry: (error) => {
            // Already-wrapped XApiError = don't retry (already final).
            if (error instanceof XApiError) return false;
            const status = extractStatus(error);
            // 401 / 403 / 4xx (except 429) → don't retry.
            if (status === 401 || status === 403) return false;
            if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
              return false;
            }
            return true;
          },
        },
      );

    const breaker = this.breaker;
    const exec = (): Promise<T> => {
      if (!breaker) return guarded();
      // The breaker is shared across calls; per-call result type is T.
      return breaker.execute(guarded) as Promise<T>;
    };

    try {
      return await exec();
    } catch (error: unknown) {
      if (error instanceof CircuitOpenError) {
        this.onCircuitOpen?.(error);
        throw new XApiError(kind, 'x_api circuit open — upstream unhealthy', {
          cause: error,
        });
      }
      if (error instanceof XApiError) {
        throw error;
      }
      const status = extractStatus(error);
      if (status === 401) {
        throw new XApiError(kind, 'unauthorized — token may be expired or revoked', {
          status,
          cause: error,
        });
      }
      if (status === 403) {
        throw new XApiError(kind, 'forbidden — token lacks scope or account suspended', {
          status,
          cause: error,
        });
      }
      throw new XApiError(kind, extractMessage(error), {
        ...(status !== undefined ? { status } : {}),
        cause: error,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function clampMaxResults(max: number | undefined): number {
  const value = max ?? DEFAULT_MAX_RESULTS;
  if (value < MIN_TWITTER_MAX_RESULTS) {
    return MIN_TWITTER_MAX_RESULTS;
  }
  if (value > MAX_TWITTER_MAX_RESULTS) {
    return MAX_TWITTER_MAX_RESULTS;
  }
  return value;
}

interface RawListPayload {
  data?: TweetV2[] | TweetV2;
  includes?: { users?: UserV2[] };
}

/**
 * twitter-api-v2 returns either a paginator or a plain object.
 * Both expose `.data` and `.includes`. Normalize once.
 */
function extractRawData(result: unknown): RawListPayload {
  if (result === null || result === undefined) {
    return {};
  }
  // Paginator instances expose ._realData / .data
  const paginator = result as { _realData?: RawListPayload; data?: unknown; includes?: unknown };
  if (paginator._realData && typeof paginator._realData === 'object') {
    return paginator._realData;
  }
  if ('data' in paginator || 'includes' in paginator) {
    return {
      ...(paginator.data !== undefined ? { data: paginator.data as TweetV2[] | TweetV2 } : {}),
      ...(paginator.includes !== undefined ? { includes: paginator.includes as { users?: UserV2[] } } : {}),
    };
  }
  return {};
}

function parseMentionPayload(raw: RawListPayload): MentionEvent[] {
  const tweets = toArray(raw.data);
  const users = new Map<string, UserV2>();
  for (const user of raw.includes?.users ?? []) {
    if (user?.id) {
      users.set(user.id, user);
    }
  }
  const result: MentionEvent[] = [];
  for (const tweet of tweets) {
    if (!tweet?.id) continue;
    const author = (tweet.author_id ? users.get(tweet.author_id) : undefined) ?? null;
    const referenced = pickReferenced(tweet);
    const event: MentionEvent = {
      id: tweet.id,
      text: tweet.text ?? '',
      author: {
        id: tweet.author_id ?? '',
        handle: author?.username ?? '',
        name: author?.name ?? '',
      },
      createdAt: tweet.created_at ?? '',
    };
    if (tweet.conversation_id) {
      event.conversationId = tweet.conversation_id;
    }
    if (referenced?.id) {
      event.referencedTweetId = referenced.id;
    }
    result.push(event);
  }
  return result;
}

function parseTweetPayload(raw: RawListPayload): TweetEvent[] {
  const tweets = toArray(raw.data);
  const result: TweetEvent[] = [];
  for (const tweet of tweets) {
    if (!tweet?.id) continue;
    const referenced = pickReferenced(tweet);
    const event: TweetEvent = {
      id: tweet.id,
      text: tweet.text ?? '',
      authorId: tweet.author_id ?? '',
      createdAt: tweet.created_at ?? '',
    };
    if (tweet.conversation_id) {
      event.conversationId = tweet.conversation_id;
    }
    if (referenced?.id) {
      event.referencedTweetId = referenced.id;
    }
    if (referenced?.type) {
      event.referencedTweetType = referenced.type;
    }
    result.push(event);
  }
  return result;
}

function pickReferenced(tweet: TweetV2): { id?: string; type?: 'replied_to' | 'quoted' | 'retweeted' } | null {
  const refs = tweet.referenced_tweets;
  if (!Array.isArray(refs) || refs.length === 0) return null;
  const first = refs[0];
  if (!first) return null;
  const type = first.type as 'replied_to' | 'quoted' | 'retweeted' | undefined;
  return {
    ...(first.id !== undefined ? { id: first.id } : {}),
    ...(type !== undefined ? { type } : {}),
  };
}

function toArray<T>(value: T[] | T | undefined): T[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function extractStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const err = error as Partial<ApiResponseError> & { code?: number; status?: number };
  if (typeof err.code === 'number') return err.code;
  if (typeof err.status === 'number') return err.status;
  return undefined;
}

function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return 'unknown error';
  }
}

