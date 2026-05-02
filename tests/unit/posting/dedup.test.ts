import { describe, expect, it } from 'vitest';
import {
  PREFIX_LENGTH,
  findDuplicateInQueue,
  isDuplicateByPrefix,
  normalizeForPrefix,
  recentAndScheduledTextPrefixes,
  textPrefix,
} from '../../../src/posting/dedup.js';
import { InMemoryAccountRepo } from '../fixtures/in-memory-repo.js';
import type { PublishItem } from '../../../src/account-state/types.js';

describe('normalizeForPrefix', () => {
  it('collapses any whitespace run to single space', () => {
    expect(normalizeForPrefix('  foo\n\nbar\t baz  ')).toBe('foo bar baz');
  });
  it('returns empty for whitespace-only input', () => {
    expect(normalizeForPrefix('   \n\t  ')).toBe('');
  });
  it('handles null / undefined', () => {
    expect(normalizeForPrefix(null)).toBe('');
    expect(normalizeForPrefix(undefined)).toBe('');
  });
});

describe('textPrefix', () => {
  it('takes first PREFIX_LENGTH chars after normalize', () => {
    const long = 'a'.repeat(200);
    expect(textPrefix(long).length).toBe(PREFIX_LENGTH);
  });
  it('absorbs whitespace differences', () => {
    expect(textPrefix('hello\nworld')).toBe(textPrefix('hello world'));
    expect(textPrefix('  hello world  ')).toBe(textPrefix('hello\tworld'));
  });
});

describe('isDuplicateByPrefix', () => {
  it('returns true when both share an identical 80-char prefix', () => {
    const head = 'a'.repeat(80);
    expect(isDuplicateByPrefix(head + ' tail-1', [head + ' tail-2'])).toBe(true);
  });
  it('absorbs whitespace differences before comparing', () => {
    const head = 'shared prefix block ' + 'x'.repeat(60);
    expect(isDuplicateByPrefix(head, ['shared\tprefix\nblock ' + 'x'.repeat(60)])).toBe(true);
  });
  it('returns false when prefix differs', () => {
    expect(isDuplicateByPrefix('hello', ['goodbye'])).toBe(false);
  });
  it('returns false on empty input', () => {
    expect(isDuplicateByPrefix('', ['anything'])).toBe(false);
  });
});

describe('recentAndScheduledTextPrefixes', () => {
  it('walks queue + drafts, dedupes, respects time window', async () => {
    const now = new Date('2026-05-02T00:00:00Z');
    const repo = new InMemoryAccountRepo({
      drafts: {
        c_old: { text: 'older post body to keep' }, // outside window
        c_pub: { text: 'recent published body within window' },
        c_sch: { text: 'future scheduled body' },
        c_dup: { text: 'recent published body within window' }, // dup prefix
      },
      state: {
        publish_queue: [
          item({
            content_id: 'c_old',
            status: 'published',
            executed_at: '2026-04-20T07:00:00Z', // > 7 days ago
          }),
          item({
            content_id: 'c_pub',
            status: 'published',
            executed_at: '2026-04-30T07:00:00Z', // 2 days ago
            text_prefix: '',
          }),
          item({
            content_id: 'c_sch',
            status: 'scheduled',
            scheduled_at: '2026-05-04T07:00:00Z',
            text_prefix: '',
          }),
          item({
            content_id: 'c_dup',
            status: 'scheduled',
            scheduled_at: '2026-05-05T07:00:00Z',
            text_prefix: '',
          }),
        ],
      },
    });
    const out = await recentAndScheduledTextPrefixes({
      repo,
      daysBack: 7,
      daysForward: 7,
      now,
    });
    expect(out).toHaveLength(2); // duplicate prefix collapsed; old item out of window
    expect(out).toContain(textPrefix('recent published body within window'));
    expect(out).toContain(textPrefix('future scheduled body'));
  });

  it('keeps items that fall exactly on the daysBack / daysForward boundary (inclusive)', async () => {
    // now = 2026-05-08T00:00Z. daysBack=7 → earliest = 2026-05-01T00:00Z.
    // daysForward=7 → latest = 2026-05-15T00:00Z. Both edges should be
    // kept (inclusive).
    const now = new Date('2026-05-08T00:00:00Z');
    const repo = new InMemoryAccountRepo({
      state: {
        publish_queue: [
          item({
            content_id: 'c_edge_published',
            status: 'published',
            executed_at: '2026-05-01T00:00:00Z', // exactly 7 days ago
            text_prefix: 'edge published prefix',
          }),
          item({
            content_id: 'c_edge_scheduled',
            status: 'scheduled',
            scheduled_at: '2026-05-15T00:00:00Z', // exactly 7 days ahead
            text_prefix: 'edge scheduled prefix',
          }),
          item({
            content_id: 'c_edge_held',
            status: 'held',
            scheduled_at: '2026-05-15T00:00:00Z', // exactly 7 days ahead, held
            text_prefix: 'edge held prefix',
          }),
        ],
      },
    });
    const out = await recentAndScheduledTextPrefixes({
      repo,
      daysBack: 7,
      daysForward: 7,
      now,
    });
    expect(out).toContain(textPrefix('edge published prefix'));
    expect(out).toContain(textPrefix('edge scheduled prefix'));
    expect(out).toContain(textPrefix('edge held prefix'));
  });

  it('uses item.text_prefix when present without reading draft', async () => {
    const now = new Date('2026-05-02T00:00:00Z');
    const repo = new InMemoryAccountRepo({
      // no drafts deliberately
      state: {
        publish_queue: [
          item({
            content_id: 'cX',
            status: 'scheduled',
            scheduled_at: '2026-05-03T07:00:00Z',
            text_prefix: 'cached prefix value',
          }),
        ],
      },
    });
    const out = await recentAndScheduledTextPrefixes({ repo, now });
    expect(out).toEqual([textPrefix('cached prefix value')]);
  });
});

describe('findDuplicateInQueue', () => {
  it('detects same content_id + scheduled_at', async () => {
    const at = new Date('2026-05-02T07:00:00Z');
    const repo = new InMemoryAccountRepo({
      state: {
        publish_queue: [
          item({
            content_id: 'c1',
            scheduled_at: at.toISOString(),
            text_prefix: 'aaa',
          }),
        ],
      },
    });
    const r = await findDuplicateInQueue({
      repo,
      contentId: 'c1',
      scheduledAt: at,
      text: 'totally different',
    });
    expect(r.duplicate).toBe(true);
    expect(r.reason).toBe('same_content_and_time');
  });

  it('detects prefix collision on a different content_id', async () => {
    const head = 'a'.repeat(80);
    const repo = new InMemoryAccountRepo({
      state: {
        publish_queue: [
          item({
            content_id: 'c_other',
            status: 'scheduled',
            text_prefix: head,
          }),
        ],
      },
    });
    const r = await findDuplicateInQueue({
      repo,
      contentId: 'c_new',
      text: head + ' tail differs',
    });
    expect(r.duplicate).toBe(true);
    expect(r.reason).toBe('too_similar_recent');
  });

  it('returns false when no match', async () => {
    const repo = new InMemoryAccountRepo({ state: { publish_queue: [] } });
    const r = await findDuplicateInQueue({ repo, text: 'whatever' });
    expect(r.duplicate).toBe(false);
  });
});

function item(overrides: Partial<PublishItem>): PublishItem {
  return {
    publish_id: `pub_${Math.random().toString(36).slice(2, 10)}`,
    content_id: 'c0',
    variant: 'primary',
    scheduled_at: '2026-05-02T07:00:00Z',
    status: 'scheduled',
    queued_at: '2026-05-01T00:00:00Z',
    executed_at: '',
    last_error: '',
    text_prefix: '',
    ...overrides,
  };
}
