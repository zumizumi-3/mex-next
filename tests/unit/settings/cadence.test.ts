import { describe, expect, it } from 'vitest';
import {
  CADENCE_PROFILES,
  applyCadenceProfile,
  buildCadence,
  getCadenceFromAccount,
} from '../../../src/settings/cadence.js';
import { InMemoryAccountRepo } from '../fixtures/in-memory-repo.js';

describe('CADENCE_PROFILES', () => {
  it('light has 1 hot zone + 1 post/day', () => {
    expect(CADENCE_PROFILES.light.hotZones).toHaveLength(1);
    expect(CADENCE_PROFILES.light.postsPerDay).toEqual({ min: 1, max: 1 });
  });
  it('standard has 3 hot zones', () => {
    expect(CADENCE_PROFILES.standard.hotZones).toHaveLength(3);
  });
  it('aggressive has 5 hot zones + 3-5 posts/day', () => {
    expect(CADENCE_PROFILES.aggressive.hotZones.length).toBe(5);
    expect(CADENCE_PROFILES.aggressive.postsPerDay).toEqual({ min: 3, max: 5 });
  });
});

describe('buildCadence', () => {
  it('returns deep clone — mutation does not leak into preset', () => {
    const c = buildCadence('light');
    c.hotZones.push({ start: '23:00', end: '23:59' });
    expect(CADENCE_PROFILES.light.hotZones).toHaveLength(1);
  });
});

describe('getCadenceFromAccount', () => {
  it('returns light defaults for empty account', () => {
    const c = getCadenceFromAccount({});
    expect(c.profile).toBe('light');
    expect(c.hotZones).toEqual(CADENCE_PROFILES.light.hotZones);
  });

  it('reads operating_cadence.profile when present', () => {
    const c = getCadenceFromAccount({
      operating_cadence: { profile: 'standard' },
    });
    expect(c.profile).toBe('standard');
    expect(c.hotZones).toHaveLength(3);
  });

  it('reads operating_cadence.hot_zones override', () => {
    const c = getCadenceFromAccount({
      operating_cadence: {
        profile: 'light',
        hot_zones: [{ start: '20:00', end: '23:00', label: '夜' }],
      },
    });
    expect(c.hotZones).toEqual([{ start: '20:00', end: '23:00', label: '夜' }]);
  });
});

describe('applyCadenceProfile', () => {
  it('writes operating_cadence + cadence + trigger_policy.time_based', async () => {
    const repo = new InMemoryAccountRepo({ account: { account_id: 'zumi-x' } });
    const cadence = await applyCadenceProfile({ repo, profile: 'standard' });
    expect(cadence.profile).toBe('standard');
    const account = repo.peekAccount();
    expect(account.operating_cadence?.profile).toBe('standard');
    expect(account.operating_cadence?.hot_zones).toHaveLength(3);
    expect(account.cadence?.preset).toBe('standard');
    expect(account.cadence?.daily_targets?.original_posts).toBe(3);
    expect(account.trigger_policy?.time_based?.post_24h_review).toBe(true);
  });

  it('changing profile rewrites hot_zones', async () => {
    const repo = new InMemoryAccountRepo();
    await applyCadenceProfile({ repo, profile: 'light' });
    expect(repo.peekAccount().operating_cadence?.hot_zones).toHaveLength(1);
    await applyCadenceProfile({ repo, profile: 'aggressive' });
    expect(repo.peekAccount().operating_cadence?.hot_zones).toHaveLength(5);
  });

  it('rejects "custom" profile', async () => {
    const repo = new InMemoryAccountRepo();
    await expect(
      applyCadenceProfile({ repo, profile: 'custom' }),
    ).rejects.toThrow(/custom/);
  });
});
