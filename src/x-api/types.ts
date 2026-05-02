/**
 * Public types for the X API client.
 *
 * Kept in a dedicated module so collectors / tests can import them
 * without pulling in the twitter-api-v2 client implementation.
 *
 * The shapes are intentionally narrow — only the fields the rest of
 * mex-next consumes. Keeping them small protects callers from
 * upstream library changes.
 */

export interface XApiCredentials {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

export interface PostOptions {
  inReplyTo?: string;
  quoteTweetId?: string;
}

export interface PostResult {
  id: string;
}

export interface XAuthor {
  id: string;
  handle: string;
  name?: string;
}

export interface MentionEvent {
  id: string;
  text: string;
  author: XAuthor;
  createdAt: string;
  conversationId?: string;
  inReplyToUserId?: string;
  referencedTweetId?: string;
}

export interface TweetEvent {
  id: string;
  text: string;
  authorId: string;
  createdAt: string;
  conversationId?: string;
  referencedTweetId?: string;
  referencedTweetType?: 'replied_to' | 'quoted' | 'retweeted';
}

export interface XUser {
  id: string;
  name: string;
  handle: string;
}

export interface PaginationOptions {
  sinceId?: string;
  max?: number;
}

/**
 * Minimal surface every X API call must satisfy.
 * Useful so collectors can depend on a narrow contract instead of
 * the concrete `XApiClient` class — easier to mock in tests.
 */
export interface XApiSurface {
  post(text: string, opts?: PostOptions): Promise<PostResult>;
  getMentions(opts?: PaginationOptions): Promise<MentionEvent[]>;
  searchRecent(query: string, opts?: PaginationOptions): Promise<TweetEvent[]>;
  getUserTweets(userId: string, opts?: PaginationOptions): Promise<TweetEvent[]>;
  getUserByHandle(handle: string): Promise<XUser>;
  deleteTweet(id: string): Promise<void>;
  /** Like a tweet on behalf of the authenticated user. */
  likeTweet(tweetId: string): Promise<void>;
}

export class XApiError extends Error {
  readonly kind: string;
  readonly status?: number;
  readonly cause?: unknown;

  constructor(kind: string, message: string, opts?: { status?: number; cause?: unknown }) {
    super(`[x-api:${kind}] ${message}`);
    this.name = 'XApiError';
    this.kind = kind;
    if (opts?.status !== undefined) {
      this.status = opts.status;
    }
    if (opts?.cause !== undefined) {
      this.cause = opts.cause;
    }
  }
}
