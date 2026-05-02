import { describe, expect, it } from 'vitest';
import {
  computeNextSlot,
  ensureMinGap,
  getExistingPublishTimes,
  hasConflictWithin,
} from '../../../src/posting/scheduler.js';
import { CADENCE_PROFILES } from '../../../src/settings/cadence.js';
import type { PublishItem, StateJson } from '../../../src/account-state/types.js';

describe('hasConflictWithin', () => {
  it('detects conflict within ±gap window (UTC)', () => {
    const candidate = new Date('2026-05-02T07:00:00Z');
    const existing = [new Date('2026-05-02T06:45:00Z')];
    expect(hasConflictWithin(candidate, existing, 30)).toBe(true);
  });
  it('returns false outside gap window', () => {
    const candidate = new Date('2026-05-02T07:00:00Z');
    const existing = [new Date('2026-05-02T06:25:00Z')];
    expect(hasConflictWithin(candidate, existing, 30)).toBe(false);
  });
  it('returns false on empty existing', () => {
    expect(hasConflictWithin(new Date(), [], 30)).toBe(false);
  });
});

describe('ensureMinGap', () => {
  it('returns same candidate when no conflict', () => {
    const candidate = new Date('2026-05-02T07:00:00Z');
    const result = ensureMinGap({
      candidate,
      existing: [new Date('2026-05-02T03:00:00Z')],
      gapMinutes: 30,
    });
    expect(result.toISOString()).toBe(candidate.toISOString());
  });

  it('shifts +30min when one conflict, then clears', () => {
    const candidate = new Date('2026-05-02T07:00:00Z');
    const existing = [new Date('2026-05-02T07:00:00Z')];
    const result = ensureMinGap({ candidate, existing, gapMinutes: 30 });
    // After +30min, the original 07:00 is exactly 30min away (boundary inclusive),
    // so still in conflict per `hasConflictWithin`. Push another +30min → 08:00 → clear.
    expect(result.toISOString()).toBe('2026-05-02T08:00:00.000Z');
  });

  it('falls back to +1 day after maxIter failures', () => {
    const candidate = new Date('2026-05-02T07:00:00Z');
    // Pack existing every 30 minutes for 6 hours so 5 retries can't escape.
    const existing: Date[] = [];
    for (let i = 0; i < 12; i++) {
      existing.push(new Date(candidate.getTime() + i * 30 * 60_000));
    }
    const result = ensureMinGap({
      candidate,
      existing,
      gapMinutes: 30,
      maxIter: 5,
    });
    // After 5 failed retries we add one full day from the last candidate.
    // Final candidate before fallback was 07:00 + 5*30 = 09:30.
    // +24h → 2026-05-03T09:30:00Z
    expect(result.toISOString()).toBe('2026-05-03T09:30:00.000Z');
  });
});

describe('getExistingPublishTimes', () => {
  it('returns scheduled / held items only, parsed as Date', () => {
    const state: StateJson = {
      publish_queue: [
        publishItem({ scheduled_at: '2026-05-02T07:00:00Z', status: 'scheduled' }),
        publishItem({ scheduled_at: '2026-05-02T08:00:00Z', status: 'held' }),
        publishItem({ scheduled_at: '2026-05-02T09:00:00Z', status: 'published' }),
        publishItem({ scheduled_at: '2026-05-02T10:00:00Z', status: 'cancelled_by_user' }),
        publishItem({ scheduled_at: 'not-a-date', status: 'scheduled' }),
      ],
    };
    const out = getExistingPublishTimes(state);
    expect(out.map((d) => d.toISOString())).toEqual([
      '2026-05-02T07:00:00.000Z',
      '2026-05-02T08:00:00.000Z',
    ]);
  });
});

describe('computeNextSlot', () => {
  const cadence = CADENCE_PROFILES.light;

  it('places publishIndex=0 in the morning hot zone (JST)', () => {
    // now = 2026-05-02 00:00 UTC = 09:00 JST (still inside 06-09 zone).
    const now = new Date('2026-05-02T00:00:00Z');
    const slot = computeNextSlot({
      cadence,
      publishIndex: 0,
      existingTimes: [],
      now,
    });
    // light hot_zone start = 06:00 JST → +18min offset = 06:18 JST = 21:18 UTC (prev day).
    // But that's < now+5min, so push +1day → 2026-05-02T21:18:00Z.
    expect(slot.toISOString()).toBe('2026-05-02T21:18:00.000Z');
  });

  it('publishIndex=1 advances at least to tomorrow morning JST', () => {
    // now = 2026-05-02T00:00Z = 09:00 JST (already past the morning hot zone).
    // slot0: idx=0 → JST 2026-05-02 06:18 = 21:18Z prev day, < now+5min,
    //                so the algorithm pushes +1day → 2026-05-02T21:18:00Z.
    // slot1: idx=1 → JST 2026-05-03 06:25 = 2026-05-02T21:25:00Z, already in future,
    //                so no day-shift is applied.
    // The two slots end up only 7 minutes apart on the UTC timeline;
    // what matters is that slot1 is later and the JST date is the next day.
    const now = new Date('2026-05-02T00:00:00Z');
    const slot0 = computeNextSlot({
      cadence,
      publishIndex: 0,
      existingTimes: [],
      now,
    });
    const slot1 = computeNextSlot({
      cadence,
      publishIndex: 1,
      existingTimes: [],
      now,
    });
    expect(slot1.getTime()).toBeGreaterThan(slot0.getTime());
    expect(slot1.toISOString()).toBe('2026-05-02T21:25:00.000Z');
  });

  it('shifts away from a conflicting existing time', () => {
    const now = new Date('2026-05-02T00:00:00Z');
    // First compute the natural slot.
    const natural = computeNextSlot({
      cadence,
      publishIndex: 0,
      existingTimes: [],
      now,
    });
    // Plant existing at exactly that slot; expect a shift.
    const slot = computeNextSlot({
      cadence,
      publishIndex: 0,
      existingTimes: [natural],
      now,
    });
    expect(slot.toISOString()).not.toBe(natural.toISOString());
    expect(Math.abs(slot.getTime() - natural.getTime())).toBeGreaterThanOrEqual(30 * 60_000);
  });

  it('rolls month boundary correctly: 2026-04-30 +1 day → 2026-05-01 (JST)', () => {
    // now = 2026-04-30 22:00 JST = 2026-04-30 13:00 UTC. light hot zone
    // start = 06:00 JST. publishIndex=1 → "tomorrow JST 06:18". Tomorrow
    // JST is 2026-05-01, so the slot must land on 2026-04-30T21:18Z
    // (= 2026-05-01 06:18 JST). A naive `setDate(date+1)` on a UTC view
    // would wrongly produce 2026-04-31 → corrupt date.
    const now = new Date('2026-04-30T13:00:00Z'); // 2026-04-30 22:00 JST
    const slot = computeNextSlot({
      cadence,
      publishIndex: 1,
      existingTimes: [],
      now,
    });
    // 2026-05-01 06:25 JST (offset for idx=1 = 25min) = 2026-04-30 21:25 UTC.
    expect(slot.toISOString()).toBe('2026-04-30T21:25:00.000Z');
  });

  it('rolls year boundary correctly: 2026-12-31 +1 day → 2027-01-01 (JST)', () => {
    // now = 2026-12-31 22:00 JST = 2026-12-31 13:00 UTC.
    // publishIndex=1 → JST 2027-01-01 06:25 = 2026-12-31 21:25 UTC.
    const now = new Date('2026-12-31T13:00:00Z');
    const slot = computeNextSlot({
      cadence,
      publishIndex: 1,
      existingTimes: [],
      now,
    });
    expect(slot.toISOString()).toBe('2026-12-31T21:25:00.000Z');
    // Sanity: that ISO ms maps to JST 2027-01-01.
    const jstView = new Date(slot.getTime() + 9 * 60 * 60_000);
    expect(jstView.getUTCFullYear()).toBe(2027);
    expect(jstView.getUTCMonth() + 1).toBe(1);
    expect(jstView.getUTCDate()).toBe(1);
  });

  it('does not produce malformed dates when crossing month-end during the +1d push loop', () => {
    // now = 2026-04-30 21:30 UTC = 2026-05-01 06:30 JST. publishIndex=0
    // would naturally place at JST 2026-05-01 06:18 = 2026-04-30T21:18Z,
    // which is < now+5min, so the loop pushes +1 day → JST 2026-05-02
    // 06:18 = 2026-05-01T21:18Z. Confirms no Apr-31-style corruption.
    const now = new Date('2026-04-30T21:30:00Z');
    const slot = computeNextSlot({
      cadence,
      publishIndex: 0,
      existingTimes: [],
      now,
    });
    expect(slot.toISOString()).toBe('2026-05-01T21:18:00.000Z');
  });

  it('falls back to +1 day after 5 failed gap attempts', () => {
    const now = new Date('2026-05-02T00:00:00Z');
    const natural = computeNextSlot({
      cadence,
      publishIndex: 0,
      existingTimes: [],
      now,
    });
    const existing: Date[] = [];
    for (let i = 0; i < 12; i++) {
      existing.push(new Date(natural.getTime() + i * 30 * 60_000));
    }
    const slot = computeNextSlot({
      cadence,
      publishIndex: 0,
      existingTimes: existing,
      now,
      gapMinutes: 30,
      maxIter: 5,
    });
    // Should be roughly natural + 5 * 30min + 24h.
    const expectedMs = natural.getTime() + 5 * 30 * 60_000 + 24 * 60 * 60_000;
    expect(slot.getTime()).toBe(expectedMs);
  });
});

function publishItem(overrides: Partial<PublishItem>): PublishItem {
  return {
    publish_id: 'pub_test',
    content_id: 'c1',
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
