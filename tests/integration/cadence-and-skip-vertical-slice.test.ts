/**
 * Cadence + skip vertical-slice integration test.
 *
 * Exercises:
 *   - applyCadenceProfile('light')          → account.json updated
 *   - enqueuePublish for today + tomorrow  → publish_queue
 *   - skipToday                             → today items → cancelled_by_user
 *                                            → state.skip_dates updated
 *   - unskipToday                           → skip_dates returns to []
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  applyCadenceProfile,
  CADENCE_PROFILES,
  getCadenceFromAccount,
} from '../../src/settings/cadence.js';
import {
  isSkipped,
  skipToday,
  unskipToday,
} from '../../src/settings/skip.js';
import { enqueuePublish } from '../../src/posting/queue.js';
import type { AccountJson, AccountRepo, PublishItem } from '../../src/account-state/types.js';
import { jstDateString } from '../../src/utils/jst.js';
import { prepareTempRepoDir, IntegrationRepo, type TempRepo } from './_helpers.js';

let temp: TempRepo;
let repo: IntegrationRepo;

beforeEach(async () => {
  temp = await prepareTempRepoDir({
    accountOverride: {
      operating_cadence: { profile: 'standard' },
    },
  });
  repo = new IntegrationRepo(temp.path);
});

afterEach(async () => {
  await temp.cleanup();
});

describe('cadence + skip vertical slice', () => {
  it('applyCadenceProfile(light) writes through to account.json', async () => {
    await applyCadenceProfile({
      repo: repo as unknown as AccountRepo,
      profile: 'light',
    });
    const account = (await repo.loadAccount()) as AccountJson;
    expect(account.operating_cadence?.profile).toBe('light');
    const cadence = getCadenceFromAccount(account);
    expect(cadence.profile).toBe('light');
    expect(cadence.postsPerDay).toEqual(CADENCE_PROFILES.light.postsPerDay);
  });

  it('skipToday cancels only today (JST) items, leaves tomorrow alone', async () => {
    // 2026-05-02 02:00 UTC = 11:00 JST 2026-05-02
    const nowUtc = new Date('2026-05-02T02:00:00Z');
    const todayJst = jstDateString(nowUtc); // '2026-05-02'

    // Enqueue today's item: 16:00 JST 2026-05-02 (= 07:00 UTC)
    const todayItem = await enqueuePublish({
      repo: repo as unknown as AccountRepo,
      contentId: 'c-today',
      scheduledAt: new Date('2026-05-02T07:00:00Z'),
      text: 'today post body',
    });

    // Enqueue tomorrow's item: 16:00 JST 2026-05-03 (= 07:00 UTC next day)
    const tomorrowItem = await enqueuePublish({
      repo: repo as unknown as AccountRepo,
      contentId: 'c-tomorrow',
      scheduledAt: new Date('2026-05-03T07:00:00Z'),
      text: 'tomorrow post body',
    });

    // skipToday on 2026-05-02
    const skipResult = await skipToday({
      repo: repo as unknown as AccountRepo,
      now: nowUtc,
    });
    expect(skipResult.skipDate).toBe(todayJst);
    expect(skipResult.cancelledPublishIds).toContain(todayItem.publish_id);
    expect(skipResult.cancelledPublishIds).not.toContain(tomorrowItem.publish_id);

    // state.skip_dates updated
    const persisted = await repo.loadState();
    expect(persisted.skip_dates).toContain(todayJst);

    // today item is cancelled_by_user; tomorrow item still scheduled
    const queue = persisted.publish_queue as PublishItem[];
    const byId = (id: string) =>
      queue.find((q) => q.publish_id === id) as PublishItem;
    expect(byId(todayItem.publish_id).status).toBe('cancelled_by_user');
    expect(byId(todayItem.publish_id).last_error).toBe('skipped_by_user');
    expect(byId(tomorrowItem.publish_id).status).toBe('scheduled');

    // isSkipped returns true for today
    expect(
      await isSkipped({ repo: repo as unknown as AccountRepo, date: todayJst }),
    ).toBe(true);

    // unskipToday removes the date but does NOT un-cancel items
    await unskipToday({ repo: repo as unknown as AccountRepo, now: nowUtc });
    const afterUnskip = await repo.loadState();
    expect(afterUnskip.skip_dates).not.toContain(todayJst);
    const afterQueue = afterUnskip.publish_queue as PublishItem[];
    expect(
      (afterQueue.find((q) => q.publish_id === todayItem.publish_id) as PublishItem).status,
    ).toBe('cancelled_by_user');
  });

  it('skipToday is idempotent across two consecutive calls', async () => {
    const now = new Date('2026-05-02T00:00:00Z');
    await skipToday({ repo: repo as unknown as AccountRepo, now });
    await skipToday({ repo: repo as unknown as AccountRepo, now });
    const state = await repo.loadState();
    const skipDates = state.skip_dates as string[];
    expect(skipDates.filter((d) => d === '2026-05-02')).toHaveLength(1);
  });
});
