/**
 * Unit tests for XApiClient.
 *
 * The TwitterApi instance is fully mocked via the constructor-injected
 * factory, so these tests never touch the network.
 */

import { describe, expect, it, vi } from 'vitest';
import { XApiClient } from '../../../src/x-api/client.js';
import { XApiError } from '../../../src/x-api/types.js';

interface FakeApi {
  v2: {
    me: ReturnType<typeof vi.fn>;
    tweet: ReturnType<typeof vi.fn>;
    userMentionTimeline: ReturnType<typeof vi.fn>;
    search: ReturnType<typeof vi.fn>;
    userTimeline: ReturnType<typeof vi.fn>;
    userByUsername: ReturnType<typeof vi.fn>;
    deleteTweet: ReturnType<typeof vi.fn>;
  };
}

function makeFakeApi(overrides: Partial<FakeApi['v2']> = {}): FakeApi {
  return {
    v2: {
      me: vi.fn().mockResolvedValue({ data: { id: 'me-1' } }),
      tweet: vi.fn().mockResolvedValue({ data: { id: 'tw-1' } }),
      userMentionTimeline: vi.fn().mockResolvedValue({ data: [], includes: { users: [] } }),
      search: vi.fn().mockResolvedValue({ data: [], includes: { users: [] } }),
      userTimeline: vi.fn().mockResolvedValue({ data: [] }),
      userByUsername: vi.fn().mockResolvedValue({ data: { id: 'u-1', username: 'foo', name: 'Foo' } }),
      deleteTweet: vi.fn().mockResolvedValue({}),
      ...overrides,
    },
  };
}

const CREDS = {
  consumerKey: 'ck',
  consumerSecret: 'cs',
  accessToken: 'at',
  accessTokenSecret: 'ats',
};

function makeClient(api: FakeApi, opts: { maxRetries?: number; initialBackoffMs?: number } = {}) {
  return new XApiClient(CREDS, {
    factory: () => api as unknown as ReturnType<typeof Object>,
    maxRetries: opts.maxRetries ?? 0,
    initialBackoffMs: opts.initialBackoffMs ?? 1,
  } as never);
}

describe('XApiClient.post', () => {
  it('returns the new tweet id', async () => {
    const api = makeFakeApi();
    const client = makeClient(api);
    const result = await client.post('hello');
    expect(result).toEqual({ id: 'tw-1' });
    expect(api.v2.tweet).toHaveBeenCalledWith({ text: 'hello' });
  });

  it('passes reply / quote options through to v2.tweet', async () => {
    const api = makeFakeApi();
    const client = makeClient(api);
    await client.post('reply text', { inReplyTo: '99', quoteTweetId: '88' });
    expect(api.v2.tweet).toHaveBeenCalledWith({
      text: 'reply text',
      reply: { in_reply_to_tweet_id: '99' },
      quote_tweet_id: '88',
    });
  });

  it('raises XApiError when tweet response is missing id', async () => {
    const api = makeFakeApi({ tweet: vi.fn().mockResolvedValue({ data: {} }) });
    const client = makeClient(api);
    await expect(client.post('x')).rejects.toBeInstanceOf(XApiError);
  });
});

describe('XApiClient.getMentions', () => {
  it('parses tweets and joins author info from includes', async () => {
    const api = makeFakeApi({
      userMentionTimeline: vi.fn().mockResolvedValue({
        data: [
          {
            id: '101',
            text: '@me hi',
            author_id: 'u-101',
            created_at: '2026-01-01T00:00:00Z',
            conversation_id: 'c-1',
            referenced_tweets: [{ id: 'src-1', type: 'replied_to' }],
          },
        ],
        includes: {
          users: [{ id: 'u-101', username: 'alice', name: 'Alice' }],
        },
      }),
    });
    const client = makeClient(api);
    const events = await client.getMentions({ sinceId: '50', max: 25 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: '101',
      text: '@me hi',
      conversationId: 'c-1',
      referencedTweetId: 'src-1',
      author: { id: 'u-101', handle: 'alice', name: 'Alice' },
    });
    expect(api.v2.userMentionTimeline).toHaveBeenCalledWith(
      'me-1',
      expect.objectContaining({ since_id: '50', max_results: 25 }),
    );
  });

  it('handles paginator-style payload via _realData', async () => {
    const api = makeFakeApi({
      userMentionTimeline: vi.fn().mockResolvedValue({
        _realData: {
          data: [{ id: '1', text: 't', author_id: 'u', created_at: 'now' }],
          includes: { users: [] },
        },
      }),
    });
    const client = makeClient(api);
    const events = await client.getMentions();
    expect(events.map((e) => e.id)).toEqual(['1']);
  });

  it('raises when authenticated user lookup fails', async () => {
    const api = makeFakeApi({ me: vi.fn().mockResolvedValue({ data: {} }) });
    const client = makeClient(api);
    await expect(client.getMentions()).rejects.toBeInstanceOf(XApiError);
  });
});

describe('XApiClient.searchRecent', () => {
  it('parses tweet payload', async () => {
    const api = makeFakeApi({
      search: vi.fn().mockResolvedValue({
        data: [
          {
            id: '201',
            text: 'hi',
            author_id: 'u-1',
            created_at: 't',
            referenced_tweets: [{ id: 'q-src', type: 'quoted' }],
          },
        ],
      }),
    });
    const client = makeClient(api);
    const events = await client.searchRecent('url:foo is:quote');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: '201',
      authorId: 'u-1',
      referencedTweetId: 'q-src',
      referencedTweetType: 'quoted',
    });
  });
});

describe('XApiClient.getUserTweets', () => {
  it('clamps max_results into [5,100]', async () => {
    const api = makeFakeApi();
    const client = makeClient(api);
    await client.getUserTweets('u-1', { max: 1 });
    expect(api.v2.userTimeline).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({ max_results: 5 }),
    );

    await client.getUserTweets('u-1', { max: 999 });
    expect(api.v2.userTimeline).toHaveBeenLastCalledWith(
      'u-1',
      expect.objectContaining({ max_results: 100 }),
    );
  });
});

describe('XApiClient.getUserByHandle', () => {
  it('strips leading @ and returns normalized user', async () => {
    const api = makeFakeApi();
    const client = makeClient(api);
    const result = await client.getUserByHandle('@bob');
    expect(api.v2.userByUsername).toHaveBeenCalledWith('bob', expect.anything());
    expect(result).toEqual({ id: 'u-1', name: 'Foo', handle: 'foo' });
  });

  it('throws when handle is empty', async () => {
    const api = makeFakeApi();
    const client = makeClient(api);
    await expect(client.getUserByHandle('   ')).rejects.toBeInstanceOf(XApiError);
  });
});

describe('XApiClient retry behavior', () => {
  it('retries on 429 up to maxRetries', async () => {
    const tweetMock = vi
      .fn()
      .mockRejectedValueOnce({ code: 429, message: 'rate' })
      .mockRejectedValueOnce({ code: 429, message: 'rate' })
      .mockResolvedValueOnce({ data: { id: 'tw-x' } });
    const api = makeFakeApi({ tweet: tweetMock });
    const client = makeClient(api, { maxRetries: 2, initialBackoffMs: 1 });
    const result = await client.post('x');
    expect(result.id).toBe('tw-x');
    expect(tweetMock).toHaveBeenCalledTimes(3);
  });

  it('throws XApiError tagged with status 401 when token expired', async () => {
    const tweetMock = vi.fn().mockRejectedValue({ code: 401, message: 'expired' });
    const api = makeFakeApi({ tweet: tweetMock });
    const client = makeClient(api, { maxRetries: 0 });
    await expect(client.post('x')).rejects.toMatchObject({
      name: 'XApiError',
      kind: 'post',
      status: 401,
    });
  });

  it('gives up after exceeding maxRetries on persistent 429', async () => {
    const tweetMock = vi.fn().mockRejectedValue({ code: 429, message: 'rate' });
    const api = makeFakeApi({ tweet: tweetMock });
    const client = makeClient(api, { maxRetries: 1, initialBackoffMs: 1 });
    await expect(client.post('x')).rejects.toMatchObject({ name: 'XApiError', status: 429 });
    expect(tweetMock).toHaveBeenCalledTimes(2);
  });
});
