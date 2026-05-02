/**
 * Launch wizard — the operator-side bring-up of a new account repo.
 *
 * Responsibilities:
 *   1. Create `account.json` with a starter skeleton (validated via
 *      AccountJsonSchema) for the given account_id.
 *   2. Create an empty `state.json`.
 *   3. Append the account to a registry file (`accounts-registry.json`)
 *      stored at the parent directory.
 *   4. (Optional) seed an OnboardingCollector session so the operator can
 *      paste a Discord invite to the customer.
 *
 * Used both as a library (for tests / Discord-driven launches) and as a
 * thin CLI in `bin/launch-wizard.ts`.
 *
 * Idempotent: re-running `launchAccount` with the same target dir returns
 * the existing account.json (no overwrite). The registry is updated only
 * when the entry is new.
 */

import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Logger } from 'pino';
import { AccountJsonSchema, type AccountJson } from '../account-state/account-schema.js';
import { StateJsonSchema, type StateJson } from '../account-state/state-schema.js';
import { writeJsonAtomic } from '../account-state/io.js';

export interface LaunchWizardOptions {
  /** Account id (kebab-case, e.g. "zumi-x"). Required. */
  readonly accountId: string;
  /** Absolute path to the target directory (created if missing). */
  readonly targetDir: string;
  /** Optional display name (falls back to accountId). */
  readonly displayName?: string;
  /** Optional registry path; defaults to `<parent>/accounts-registry.json`. */
  readonly registryPath?: string;
  /** Optional logger. */
  readonly logger?: Logger;
  /** Optional clock for tests. */
  readonly clock?: () => number;
}

export interface LaunchWizardResult {
  readonly accountDir: string;
  readonly accountJson: AccountJson;
  readonly stateJson: StateJson;
  readonly registryPath: string;
  readonly registryUpdated: boolean;
  readonly created: boolean;
}

const ACCOUNT_ID_RE = /^[a-z][a-z0-9-]{2,30}$/;

/**
 * Create / re-load the skeleton AccountJson for `accountId`. Pure
 * function; useful in tests and CLI flows where IO is mocked.
 */
export function buildStarterAccount(opts: {
  accountId: string;
  displayName?: string;
}): AccountJson {
  if (!ACCOUNT_ID_RE.test(opts.accountId)) {
    throw new Error(
      `account_id "${opts.accountId}" must match ${ACCOUNT_ID_RE} (kebab-case, 3-31 chars)`,
    );
  }
  const skeleton = {
    account_id: opts.accountId,
    display_name: opts.displayName ?? opts.accountId,
    persona: '',
    voice_profile: {
      first_person: '',
      gender_presentation: '',
      character_palette: [],
      default_character: '',
      distance_to_reader: 'balanced',
      assertiveness: 'balanced',
      warmth: 'balanced',
      humor: '',
      emoji_policy: '',
      line_break_density: '',
      forbidden_tones: [],
    },
    half_focus: '',
    brand: {},
    goal_stack: {},
    active_window: { status: 'needs_definition' },
    operating_cadence: {
      profile: 'light',
      content_targets: {
        original_posts_per_day: { min: 1, max: 1 },
        reply_sessions_per_day: 0,
        reply_count_per_day: { min: 0, max: 0 },
        quotes_per_day: { min: 0, max: 0 },
        follow_up_review_hours: [24],
      },
      review_targets: {
        rolling_review_every_days: 7,
        monthly_review_every_months: 1,
        quarterly_review_every_months: 3,
      },
      scheduler: {},
      hot_zones: [{ start: '06:00', end: '09:00', label: '朝' }],
      timezone: 'Asia/Tokyo',
      daily_targets: {},
    },
    x_action_system: {
      ingestion_mode: 'manual',
      default_mode: 'semi_auto',
      polling: {},
      actions: {},
      tracked_targets: { usernames: [], keywords: [], tweet_ids: [] },
      risk_rules: {},
      reply_generation: {},
    },
    engagement_policy: {},
    approval_policy: {
      low_risk_owner: 'director',
      high_risk_owner: 'account-owner',
      publish_requires_approval: false,
      reply_requires_approval: false,
      quote_requires_approval: false,
      like_requires_approval: false,
      tracked_reply_requires_approval: false,
      reply_mode: {},
    },
    trigger_policy: {},
  };
  // Run through the zod schema so missing fields receive defaults and
  // shape mismatches are caught early.
  return AccountJsonSchema.parse(skeleton);
}

/**
 * Build the empty state.json (per-account, never shared).
 */
export function buildEmptyState(accountId: string): StateJson {
  return StateJsonSchema.parse({
    account_id: accountId,
    current_phase: 'needs_diagnosis',
  });
}

/**
 * Append (or update) an entry in the accounts-registry. The registry is
 * a JSON file with a top-level array of `{ account_id, dir, created_at }`.
 * Returns true when the entry was added/updated, false when no change.
 */
export async function updateRegistry(args: {
  registryPath: string;
  accountId: string;
  dir: string;
  nowIso: string;
}): Promise<boolean> {
  type RegistryEntry = {
    account_id: string;
    dir: string;
    created_at: string;
  };
  type Registry = { accounts: RegistryEntry[] };
  let registry: Registry;
  try {
    const raw = await fs.readFile(args.registryPath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as Registry).accounts)
    ) {
      registry = parsed as Registry;
    } else {
      registry = { accounts: [] };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    registry = { accounts: [] };
  }

  const idx = registry.accounts.findIndex(
    (e) => e.account_id === args.accountId,
  );
  if (idx >= 0) {
    const existing = registry.accounts[idx]!;
    if (existing.dir === args.dir) {
      return false;
    }
    registry.accounts[idx] = {
      ...existing,
      dir: args.dir,
    };
  } else {
    registry.accounts.push({
      account_id: args.accountId,
      dir: args.dir,
      created_at: args.nowIso,
    });
  }
  await fs.mkdir(dirname(args.registryPath), { recursive: true });
  const tmp = `${args.registryPath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(registry, null, 2)}\n`, 'utf-8');
  await fs.rename(tmp, args.registryPath);
  return true;
}

/**
 * Bring up a new account repository: create the directory, write the
 * skeleton account.json and empty state.json, and register it.
 */
export async function launchAccount(
  opts: LaunchWizardOptions,
): Promise<LaunchWizardResult> {
  const targetDir = resolve(opts.targetDir);
  const accountId = opts.accountId;
  const now = (opts.clock ?? Date.now)();
  const nowIso = new Date(now).toISOString();
  const registryPath =
    opts.registryPath ?? join(dirname(targetDir), 'accounts-registry.json');

  await fs.mkdir(targetDir, { recursive: true });

  const accountPath = join(targetDir, 'account.json');
  const statePath = join(targetDir, 'state.json');

  let accountJson: AccountJson;
  let created = false;
  try {
    const raw = await fs.readFile(accountPath, 'utf-8');
    accountJson = AccountJsonSchema.parse(JSON.parse(raw));
    opts.logger?.info?.(
      { accountId, accountPath },
      'launch_wizard_account_already_exists',
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    accountJson = buildStarterAccount({
      accountId,
      ...(opts.displayName !== undefined ? { displayName: opts.displayName } : {}),
    });
    await writeJsonAtomic(accountPath, accountJson, AccountJsonSchema);
    created = true;
    opts.logger?.info?.({ accountId, accountPath }, 'launch_wizard_account_created');
  }

  let stateJson: StateJson;
  try {
    const raw = await fs.readFile(statePath, 'utf-8');
    stateJson = StateJsonSchema.parse(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    stateJson = buildEmptyState(accountId);
    await writeJsonAtomic(statePath, stateJson, StateJsonSchema);
    opts.logger?.info?.({ accountId, statePath }, 'launch_wizard_state_created');
  }

  const registryUpdated = await updateRegistry({
    registryPath,
    accountId,
    dir: targetDir,
    nowIso,
  });

  return {
    accountDir: targetDir,
    accountJson,
    stateJson,
    registryPath,
    registryUpdated,
    created,
  };
}
