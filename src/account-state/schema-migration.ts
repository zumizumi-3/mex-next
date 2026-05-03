/**
 * Schema migration.
 *
 * Python 版 `runtime/scripts/schema_migration.py` の TS 移植。
 * - 欠けている field を default で埋める
 * - 古い field 名 / 形 (object) を新形 (array) に rename / convert
 * - 不正な値を fix (空 array / 空 object に)
 * - migration log を返す (何を変えたか) — operator 確認用
 *
 * `migrateAccount` / `migrateState` は **元 object を mutate せず** 新 object を返す
 * (CLAUDE.md の immutability 規則に従う)。
 */

import {
  AccountJsonSchema,
  type AccountJson,
} from './account-schema.js';
import { StateJsonSchema, type StateJson } from './state-schema.js';

export interface MigrationResult<T> {
  value: T;
  changes: ReadonlyArray<string>;
}

/**
 * Python 版 `STATE_DEFAULTS` で dict<id, session> として持たれていた field を、
 * 配列に変換する (forward 互換のため受け入れる、内部表現は配列に統一)。
 *
 * `inbound_reply_sessions` / `inbound_reaction_sessions` は collector が
 * `Record<event_id, session>` として書き戻すので、ここでは array→dict 方向に
 * 正規化する (legacy array shape のみ救済)。
 */
const SESSION_DICT_TO_ARRAY_FIELDS = [
  'posting_sessions',
  'weekly_retro_sessions',
  'periodic_retro_sessions',
  'inbound_quote_sessions',
  'engagement_campaign_sessions',
  'onboarding_sessions',
  'first_window_sessions',
] as const;

/**
 * Inbound session dict-shaped field. Collector writes a
 * `Record<event_id, session>`; legacy state.json may still be array.
 */
const SESSION_ARRAY_TO_DICT_FIELDS = [
  'inbound_reply_sessions',
  'inbound_reaction_sessions',
] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function convertSessionDictToArray(
  state: Record<string, unknown>,
  changes: string[]
): Record<string, unknown> {
  const next = { ...state };
  for (const field of SESSION_DICT_TO_ARRAY_FIELDS) {
    const current = next[field];
    if (isPlainObject(current)) {
      // dict<id, session> → array<session> (id を session.id として注入)
      const arr = Object.entries(current).map(([id, session]) => {
        if (isPlainObject(session)) {
          return { id, ...session };
        }
        return { id, value: session };
      });
      next[field] = arr;
      changes.push(`${field}: dict→array (${arr.length} items)`);
    } else if (current === undefined) {
      next[field] = [];
      changes.push(`${field}: missing → []`);
    } else if (!Array.isArray(current)) {
      // 不正値 (string/number) → 空配列
      next[field] = [];
      changes.push(`${field}: invalid type → []`);
    }
  }
  return next;
}

/**
 * Inbound reply / reaction sessions: collector keys by `event_id`.
 * Convert legacy `array<session>` shape to `Record<event_id, session>`.
 * Sessions without a usable key are dropped (cannot dedupe).
 */
function convertInboundSessionsArrayToDict(
  state: Record<string, unknown>,
  changes: string[]
): Record<string, unknown> {
  const next = { ...state };
  for (const field of SESSION_ARRAY_TO_DICT_FIELDS) {
    const current = next[field];
    if (Array.isArray(current)) {
      const map: Record<string, unknown> = {};
      let dropped = 0;
      for (const entry of current) {
        if (!isPlainObject(entry)) {
          dropped += 1;
          continue;
        }
        const key =
          (typeof entry['event_id'] === 'string' && entry['event_id']) ||
          (typeof entry['id'] === 'string' && entry['id']) ||
          '';
        if (!key) {
          dropped += 1;
          continue;
        }
        map[key] = entry;
      }
      next[field] = map;
      changes.push(
        `${field}: array→dict (${Object.keys(map).length} items${dropped ? `, ${dropped} dropped` : ''})`,
      );
    } else if (current === undefined) {
      next[field] = {};
      changes.push(`${field}: missing → {}`);
    } else if (!isPlainObject(current)) {
      next[field] = {};
      changes.push(`${field}: invalid type → {}`);
    }
  }
  return next;
}

/**
 * Python 版にはあって mex-next では廃止された posting state を、最も近い
 * 新 state にマップする。`last_error` が object のときは文字列化する。
 */
const POSTING_STATE_REMAP: Record<string, string> = {
  failed_recoverable: 'repairing',
  completed: 'published',
  failed: 'failed_terminal',
  cancelled: 'failed_terminal',
  cancelled_by_user: 'failed_terminal',
  // 既知の新 state は touch しない (恒等マップは不要)
};

function coercePostingSessionShape(
  state: Record<string, unknown>,
  changes: string[]
): Record<string, unknown> {
  const sessions = state['posting_sessions'];
  if (!Array.isArray(sessions)) return state;
  let mutated = false;
  const migrated = sessions.map((s, idx) => {
    if (!isPlainObject(s)) return s;
    let session = s;
    const stateValue = String(session['state'] ?? '');
    if (stateValue && POSTING_STATE_REMAP[stateValue]) {
      session = { ...session, state: POSTING_STATE_REMAP[stateValue] };
      changes.push(
        `posting_sessions[${idx}].state: "${stateValue}" → "${POSTING_STATE_REMAP[stateValue]}"`,
      );
      mutated = true;
    }
    const lastError = session['last_error'];
    if (lastError !== undefined && typeof lastError !== 'string') {
      session = {
        ...session,
        last_error: lastError === null ? '' : JSON.stringify(lastError),
      };
      changes.push(`posting_sessions[${idx}].last_error: object→string`);
      mutated = true;
    }
    return session;
  });
  if (!mutated) return state;
  return { ...state, posting_sessions: migrated };
}

const TARGET_DISCOVERY_STATUS_REMAP: Record<string, string> = {
  ready: 'open',
  pending: 'open',
  done: 'posted',
  posted: 'posted',
  open: 'open',
  skipped: 'skipped',
  error: 'error',
  failed: 'error',
};

function coerceTargetDiscoverySessions(
  state: Record<string, unknown>,
  changes: string[]
): Record<string, unknown> {
  const tgt = state['target_discovery_sessions'];
  if (!isPlainObject(tgt)) return state;
  let mutated = false;
  const migrated: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(tgt)) {
    if (!isPlainObject(value)) {
      migrated[key] = value;
      continue;
    }
    let session = value;
    if (!session['event_id']) {
      session = { ...session, event_id: key };
      changes.push(`target_discovery_sessions[${key}].event_id: filled from key`);
      mutated = true;
    }
    const statusValue = String(session['status'] ?? '');
    if (statusValue && TARGET_DISCOVERY_STATUS_REMAP[statusValue]) {
      const remapped = TARGET_DISCOVERY_STATUS_REMAP[statusValue];
      if (remapped !== statusValue) {
        session = { ...session, status: remapped };
        changes.push(
          `target_discovery_sessions[${key}].status: "${statusValue}" → "${remapped}"`,
        );
        mutated = true;
      }
    } else if (statusValue) {
      // 未知値は open に倒す
      session = { ...session, status: 'open' };
      changes.push(
        `target_discovery_sessions[${key}].status: unknown "${statusValue}" → "open"`,
      );
      mutated = true;
    }
    migrated[key] = session;
  }
  if (!mutated) return state;
  return { ...state, target_discovery_sessions: migrated };
}

/**
 * `publish_queue` が dict 形式の旧データを array に変換。
 */
function normalizePublishQueue(
  state: Record<string, unknown>,
  changes: string[]
): Record<string, unknown> {
  const queue = state['publish_queue'];
  if (isPlainObject(queue)) {
    const arr = Object.entries(queue).map(([publish_id, item]) => {
      if (isPlainObject(item)) return { publish_id, ...item };
      return { publish_id, value: item };
    });
    changes.push(`publish_queue: dict→array (${arr.length} items)`);
    return { ...state, publish_queue: arr };
  }
  if (queue === undefined) {
    changes.push('publish_queue: missing → []');
    return { ...state, publish_queue: [] };
  }
  return state;
}

/**
 * skip_dates / seen_event_ids が無ければ空配列で初期化。
 */
function ensureRuntimeFields(
  state: Record<string, unknown>,
  changes: string[]
): Record<string, unknown> {
  const next = { ...state };
  if (next['skip_dates'] === undefined) {
    next['skip_dates'] = [];
    changes.push('skip_dates: missing → []');
  }
  if (next['last_retrospective_at'] === undefined) {
    next['last_retrospective_at'] = {};
    changes.push('last_retrospective_at: missing → {}');
  }
  if (next['publish_failure_tracking'] === undefined) {
    next['publish_failure_tracking'] = {};
    changes.push('publish_failure_tracking: missing → {}');
  }
  if (next['seen_event_ids'] === undefined) {
    next['seen_event_ids'] = [];
    changes.push('seen_event_ids: missing → []');
  }
  // target discovery uses dict<event_id, session>
  const tgt = next['target_discovery_sessions'];
  if (tgt === undefined) {
    next['target_discovery_sessions'] = {};
    changes.push('target_discovery_sessions: missing → {}');
  } else if (Array.isArray(tgt)) {
    const map: Record<string, unknown> = {};
    for (const item of tgt) {
      if (isPlainObject(item)) {
        const key = String((item as Record<string, unknown>)['event_id'] ?? '').trim();
        if (key) map[key] = item;
      }
    }
    next['target_discovery_sessions'] = map;
    changes.push(
      `target_discovery_sessions: array→dict (${Object.keys(map).length} items)`,
    );
  } else if (!isPlainObject(tgt)) {
    next['target_discovery_sessions'] = {};
    changes.push('target_discovery_sessions: invalid type → {}');
  }
  if (next['daily_digest_history'] === undefined) {
    next['daily_digest_history'] = [];
    changes.push('daily_digest_history: missing → []');
  } else if (!Array.isArray(next['daily_digest_history'])) {
    next['daily_digest_history'] = [];
    changes.push('daily_digest_history: invalid type → []');
  }
  return next;
}

/**
 * state.json を migrate して `StateJson` 型に変換。
 */
export function migrateState(input: unknown): MigrationResult<StateJson> {
  const changes: string[] = [];
  let working: Record<string, unknown>;

  if (!isPlainObject(input)) {
    working = {};
    changes.push('root: invalid type → {}');
  } else {
    working = { ...input };
  }

  working = convertSessionDictToArray(working, changes);
  working = convertInboundSessionsArrayToDict(working, changes);
  working = normalizePublishQueue(working, changes);
  working = ensureRuntimeFields(working, changes);
  working = coercePostingSessionShape(working, changes);
  working = coerceTargetDiscoverySessions(working, changes);

  // zod の default が残りの field を埋める (parse 時に変更検出は難しいので、
  // pre/post の key 数で簡易的に追加 changes を出す)
  const preKeys = new Set(Object.keys(working));
  const value = StateJsonSchema.parse(working);
  for (const key of Object.keys(value)) {
    if (!preKeys.has(key)) changes.push(`${key}: filled by zod default`);
  }

  return { value, changes };
}

/**
 * account.json を migrate。Python 版 `ACCOUNT_DEFAULTS` 相当。
 */
export function migrateAccount(input: unknown): MigrationResult<AccountJson> {
  const changes: string[] = [];
  let working: Record<string, unknown>;

  if (!isPlainObject(input)) {
    working = {};
    changes.push('root: invalid type → {}');
  } else {
    working = { ...input };
  }

  // Python 版の external_reference_assets[] string → object 変換
  const sourceAssets = working['source_assets'];
  if (isPlainObject(sourceAssets)) {
    const refs = sourceAssets['external_reference_assets'];
    if (Array.isArray(refs)) {
      let mutated = false;
      const migrated = refs.map((asset, idx) => {
        if (typeof asset === 'string') {
          mutated = true;
          changes.push(
            `source_assets.external_reference_assets[${idx}]: string→object`
          );
          return { url: asset, label: '', source_type: '', tags: [] };
        }
        return asset;
      });
      if (mutated) {
        working = {
          ...working,
          source_assets: {
            ...sourceAssets,
            external_reference_assets: migrated,
          },
        };
      }
    }
  }

  const xActionSystem = working['x_action_system'];
  if (isPlainObject(xActionSystem) && xActionSystem['automation_level'] === undefined) {
    working = {
      ...working,
      x_action_system: {
        ...xActionSystem,
        automation_level: 'semi_auto',
      },
    };
    changes.push('x_action_system.automation_level: missing → semi_auto');
  }

  const preKeys = new Set(Object.keys(working));
  const value = AccountJsonSchema.parse(working);
  for (const key of Object.keys(value)) {
    if (!preKeys.has(key)) changes.push(`${key}: filled by zod default`);
  }

  return { value, changes };
}
