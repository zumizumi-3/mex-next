/**
 * Cadence profiles + apply.
 *
 * Mirrors `runtime/scripts/cadence_defaults.py` (CADENCE_PRESETS) and
 * `cadence_apply.py` (apply_cadence_profile) from the Python implementation.
 *
 * Profile presets are immutable constants. `applyCadenceProfile` writes
 * the resolved cadence to account.json under `operating_cadence` and
 * mirrors the derived `daily_targets` / `trigger_policy.time_based`
 * fields the Python version maintains.
 */

import type {
  AccountJson,
  AccountRepo,
  HotZone,
  OperatingCadence,
} from '../account-state/types.js';

export type CadenceProfile = 'light' | 'standard' | 'aggressive' | 'custom';

export interface CadencePostsPerDay {
  min: number;
  max: number;
}

export interface CadenceConfig {
  profile: CadenceProfile;
  postsPerDay: CadencePostsPerDay;
  hotZones: HotZone[];
  dailyStartTime: string;
  followUpReviewHours: number[];
  rollingReviewEveryDays: number;
  interactionPollMinutes: number;
}

type PresetKey = Exclude<CadenceProfile, 'custom'>;

/**
 * Source-of-truth presets for the three named profiles.
 *
 * Numbers are kept identical to `cadence_defaults.py` so that
 * Python and TS callers produce the same scheduling decisions.
 */
export const CADENCE_PROFILES: Record<PresetKey, CadenceConfig> = {
  light: {
    profile: 'light',
    postsPerDay: { min: 1, max: 1 },
    hotZones: [{ start: '06:00', end: '09:00', label: '朝' }],
    dailyStartTime: '09:00',
    followUpReviewHours: [24],
    rollingReviewEveryDays: 7,
    interactionPollMinutes: 30,
  },
  standard: {
    profile: 'standard',
    postsPerDay: { min: 1, max: 3 },
    hotZones: [
      { start: '06:00', end: '09:00', label: '朝' },
      { start: '11:00', end: '13:00', label: '昼' },
      { start: '17:00', end: '22:00', label: '夕' },
    ],
    dailyStartTime: '09:00',
    followUpReviewHours: [2, 24],
    rollingReviewEveryDays: 3,
    interactionPollMinutes: 10,
  },
  aggressive: {
    profile: 'aggressive',
    postsPerDay: { min: 3, max: 5 },
    hotZones: [
      { start: '06:00', end: '09:00', label: '朝' },
      { start: '11:00', end: '12:00', label: '11時' },
      { start: '12:00', end: '13:00', label: '昼' },
      { start: '17:00', end: '18:00', label: '17時' },
      { start: '18:00', end: '22:00', label: '夕' },
    ],
    dailyStartTime: '08:00',
    followUpReviewHours: [2, 12, 24],
    rollingReviewEveryDays: 2,
    interactionPollMinutes: 5,
  },
};

/**
 * Return a deep clone so callers can't mutate the preset.
 */
export function buildCadence(profile: PresetKey): CadenceConfig {
  const preset = CADENCE_PROFILES[profile];
  return {
    ...preset,
    postsPerDay: { ...preset.postsPerDay },
    hotZones: preset.hotZones.map((zone) => ({ ...zone })),
    followUpReviewHours: [...preset.followUpReviewHours],
  };
}

/**
 * Read the effective cadence config from an `account.json`.
 *
 * Falls back to `light` defaults when the field is missing or malformed.
 */
export function getCadenceFromAccount(account: AccountJson): CadenceConfig {
  const oc = account.operating_cadence ?? {};
  const profileText = (oc.profile ?? account.cadence?.preset ?? '').toString();
  const profile: CadenceProfile = isPresetKey(profileText)
    ? profileText
    : profileText === 'custom'
      ? 'custom'
      : 'light';

  const fallback: CadenceConfig =
    profile === 'custom' ? CADENCE_PROFILES.standard : CADENCE_PROFILES[profile];

  const opd = oc.content_targets?.original_posts_per_day;
  const postsPerDay: CadencePostsPerDay =
    opd && Number.isFinite(opd.min) && Number.isFinite(opd.max)
      ? { min: Number(opd.min), max: Number(opd.max) }
      : { ...fallback.postsPerDay };

  const hotZones: HotZone[] = Array.isArray(oc.hot_zones) && oc.hot_zones.length > 0
    ? oc.hot_zones.map((z) => ({
        start: String(z.start ?? '06:00'),
        end: String(z.end ?? '09:00'),
        label: z.label,
      }))
    : fallback.hotZones.map((z) => ({ ...z }));

  const dailyStartTime = String(
    oc.scheduler?.daily_start_time ?? fallback.dailyStartTime,
  );

  const followUpReviewHours = Array.isArray(oc.content_targets?.follow_up_review_hours)
    ? oc.content_targets!.follow_up_review_hours!.filter((n): n is number =>
        Number.isFinite(n),
      )
    : [...fallback.followUpReviewHours];

  const rollingReviewEveryDays =
    Number.isFinite(oc.review_targets?.rolling_review_every_days)
      ? Number(oc.review_targets!.rolling_review_every_days)
      : fallback.rollingReviewEveryDays;

  const interactionPollMinutes = Number.isFinite(
    oc.scheduler?.interaction_poll_minutes,
  )
    ? Number(oc.scheduler!.interaction_poll_minutes)
    : fallback.interactionPollMinutes;

  return {
    profile,
    postsPerDay,
    hotZones,
    dailyStartTime,
    followUpReviewHours,
    rollingReviewEveryDays,
    interactionPollMinutes,
  };
}

function isPresetKey(value: string): value is PresetKey {
  return value === 'light' || value === 'standard' || value === 'aggressive';
}

/**
 * Render a `CadenceConfig` back into the `operating_cadence` shape
 * used in account.json (compatible with the Python writer).
 */
function toOperatingCadence(cadence: CadenceConfig): OperatingCadence {
  return {
    profile: cadence.profile,
    content_targets: {
      original_posts_per_day: { ...cadence.postsPerDay },
      follow_up_review_hours: [...cadence.followUpReviewHours],
    },
    review_targets: {
      rolling_review_every_days: cadence.rollingReviewEveryDays,
    },
    scheduler: {
      daily_start_time: cadence.dailyStartTime,
      interaction_poll_minutes: cadence.interactionPollMinutes,
    },
    hot_zones: cadence.hotZones.map((z) => ({ ...z })),
  };
}

/**
 * Apply a named profile to account.json, persisting the result.
 *
 * Returns the resolved `CadenceConfig` (so callers can render a
 * confirmation summary).
 */
export async function applyCadenceProfile(opts: {
  repo: AccountRepo;
  profile: CadenceProfile;
}): Promise<CadenceConfig> {
  const { repo, profile } = opts;
  if (profile === 'custom') {
    // 'custom' is not a preset; callers must edit operating_cadence directly.
    throw new Error('applyCadenceProfile does not support "custom" — edit operating_cadence manually');
  }
  const cadence = buildCadence(profile);
  const account = await repo.loadAccount();
  const next: AccountJson = {
    ...account,
    operating_cadence: toOperatingCadence(cadence),
    cadence: {
      ...(account.cadence ?? {}),
      preset: cadence.profile,
      daily_targets: {
        original_posts: cadence.postsPerDay.max,
        replies: 0,
        quote_replies: 0,
      },
    },
    trigger_policy: {
      ...(account.trigger_policy ?? {}),
      time_based: {
        ...(account.trigger_policy?.time_based ?? {}),
        post_review_hours: [...cadence.followUpReviewHours],
        post_2h_review: cadence.followUpReviewHours.includes(2),
        post_24h_review: cadence.followUpReviewHours.includes(24),
        rolling_review_days: cadence.rollingReviewEveryDays,
      },
    },
  };
  await repo.saveAccount(next);
  return cadence;
}
