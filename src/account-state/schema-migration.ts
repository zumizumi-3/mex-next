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
 */
const SESSION_DICT_TO_ARRAY_FIELDS = [
  'posting_sessions',
  'inbound_reaction_sessions',
  'inbound_reply_sessions',
  'weekly_retro_sessions',
  'periodic_retro_sessions',
  'inbound_quote_sessions',
  'engagement_campaign_sessions',
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
  working = normalizePublishQueue(working, changes);
  working = ensureRuntimeFields(working, changes);

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

  const preKeys = new Set(Object.keys(working));
  const value = AccountJsonSchema.parse(working);
  for (const key of Object.keys(value)) {
    if (!preKeys.has(key)) changes.push(`${key}: filled by zod default`);
  }

  return { value, changes };
}
