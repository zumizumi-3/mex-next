## Storage & Schema migration

> **対象読者**: src/account-state/ を直す developer
> **前提**: zod、JSON Schema の概念
> **読了時間**: 約 9 分

account.json / state.json の形式と、Python 版からの schema migration を扱います。

## 1. ファイル構成

```text
<account>-x-ops/
├── account.json          # 永続設定
├── state.json            # runtime state
└── content/
    └── <content-id>/
        ├── content.json  # 投稿本体 (final)
        └── draft.json    # draft 履歴
```

`<account>-x-ops` は GitHub の private repo (例: `zumi-x-x-ops`)。

## 2. zod schema

`src/account-state/account-schema.ts`:

```typescript
import { z } from 'zod';

export const cadenceProfileSchema = z.enum(['light', 'standard', 'aggressive']);

export const hotZoneSchema = z.object({
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
});

export const targetSchema = z.object({
  handle: z.string(),
  user_id: z.string().optional(),
  added_at: z.string(),
});

export const accountSchema = z.object({
  account_id: z.string(),
  persona: z.string(),
  brand: z.object({
    voice: z.string(),
    tone: z.string(),
  }),
  cadence: z.object({
    profile: cadenceProfileSchema.default('light'),
    hot_zones: z.array(hotZoneSchema).default([]),
  }),
  targets: z.array(targetSchema).default([]),
  active_window: z.string().default(''),
  goal_stack: z.array(z.string()).default([]),
  half_focus: z.string().default(''),
  customer_channel_id: z.string(),
  operator_channel_id: z.string(),
  approval_policy: z.object({
    auto_approve_after_hours: z.number().default(24),
  }).default({}),
});

export type Account = z.infer<typeof accountSchema>;
```

`state-schema.ts` も同様に zod で定義。`PostingSession`, `PublishQueueItem`, `InboundReactionSession`, `RateLimitState` 等を持つ。

## 3. atomic write + flock

```typescript
import { lock } from 'proper-lockfile';
import { promises as fs } from 'fs';

export async function writeStateAtomic(
  path: string,
  next: AccountState,
): Promise<void> {
  const release = await lock(path, { retries: { retries: 5, minTimeout: 100 } });
  try {
    const tmp = `${path}.tmp.${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(next, null, 2));
    await fs.rename(tmp, path);  // atomic on POSIX
  } finally {
    await release();
  }
}
```

- **flock**: 同 host の複数 process / timer triggered run の race 回避
- **tmp file → rename**: write 中の crash で half-written file を残さない

## 4. read flow

```typescript
export async function readState(path: string): Promise<AccountState> {
  const raw = await fs.readFile(path, 'utf-8');
  const json = JSON.parse(raw);
  const migrated = migrateState(json);  // default-inject
  return stateSchema.parse(migrated);
}
```

zod の `parse` で型保証。`migrateState` で古い field の補完。

## 5. schema migration (default injection)

Python 版 → mex-next で schema が前方互換に拡張される時、欠けた field に default を inject:

```typescript
const STATE_DEFAULTS: Partial<AccountState> = {
  posting_sessions: [],
  publish_queue: [],
  interaction_queue: [],
  inbound_reaction_sessions: [],
  skip_dates: [],
  x_api_rate_limit: {
    POST: { used_this_month: 0, limit_per_month: 3000, reset_at: null },
    GET: { used_this_month: 0, limit_per_month: 10000, reset_at: null },
  },
  plan_writeback_history: [],
  last_retrospective_at: { daily: null, weekly: null, monthly: null, quarterly: null, half: null },
};

export function migrateState(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return STATE_DEFAULTS;
  return { ...STATE_DEFAULTS, ...(raw as Partial<AccountState>) };
}
```

zod の `.default()` も使うが、ネスト構造には migrateState が必要。

## 6. immutable update pattern

```typescript
export interface AccountRepo {
  readState(): Promise<AccountState>;
  updateState(updater: (state: AccountState) => AccountState): Promise<AccountState>;
  readAccount(): Promise<Account>;
  updateAccount(updater: (account: Account) => Account): Promise<Account>;
}
```

`updater` は **必ず新しい object を返す** こと。元の引数を mutate しない:

```typescript
// WRONG
await repo.updateState(state => {
  state.publish_queue.push(item);  // mutation!
  return state;
});

// CORRECT
await repo.updateState(state => ({
  ...state,
  publish_queue: [...state.publish_queue, item],
}));
```

## 7. content/<id>/

publish 済みの本体は `content/<content-id>/content.json` に保存:

```json
{
  "content_id": "c-abc123",
  "topic": "副業を続けるための定点",
  "text": "ぼくは数字を毎週同じ時間に見る...",
  "tweet_id": "1234567890",
  "published_at": "2026-04-21T03:18:00Z",
  "engagement": { "likes": 42, "retweets": 5, "replies": 3 }
}
```

`draft.json` は draft 履歴 (rev 1, 2, 3, ..., final) を保持。dedup の分析や edit-diff 学習に使う。

## 8. git commit / push

`<account>-x-ops` は GitHub private repo。bot は変更ごとに commit + push:

```typescript
async function commitState(repo: AccountRepo, message: string): Promise<void> {
  await execa('git', ['-C', repo.path, 'add', 'state.json', 'account.json'], { stdio: 'inherit' });
  await execa('git', ['-C', repo.path, 'commit', '-m', message], { stdio: 'inherit' });
  await execa('git', ['-C', repo.path, 'push'], { stdio: 'inherit' });
}
```

commit message format:

```text
<event-type>: <short description>

例:
publish: c-abc123 (12:18 JST)
schedule: c-def456 publish_at=15:30
retrospective: weekly wk17 generated
writeback: monthly active_window updated
```

push 失敗時は retry 3 回 (network / transient)。3 回 fail で operator escalate。

## 9. Python 版との互換

Python 版の schema は基本そのまま読める。詳細は [../operator/30-migration-from-python.md](../operator/30-migration-from-python.md)。

差分:

| field | Python | mex-next | 備考 |
| --- | --- | --- | --- |
| `account.legacy_voice_samples` | あり | 無視 | edit-diff で代替 |
| `state.py_internal_cache` | あり | 無視 | mex-next 側で再構築 |
| `state.x_api_rate_limit` | (一部) | 拡張 | endpoint 別 |
| `state.plan_writeback_history` | なし | 追加 | rollback 用 |

`migrate-from-python.ts` で diff を表示。

## 10. concurrent run の防止

1 account に対して bot process は 1 つまで。systemd で `Restart=on-failure` で常時 1 つ保証。

複数 process が同時に書こうとしたら proper-lockfile が retry → timeout で error。

## 11. テスト

`tests/unit/account-state/io.test.ts`:

```typescript
test('atomic write does not leave .tmp on crash', async () => {
  const path = await tmpFile();
  // simulate crash mid-write: write to tmp, kill process before rename
  // → on next run, .tmp should be ignored, original intact
});

test('schema migration injects defaults', () => {
  const oldState = { posting_sessions: [{ id: 's-1', state: 'created' }] };
  const migrated = migrateState(oldState);
  expect(migrated.publish_queue).toEqual([]);
  expect(migrated.skip_dates).toEqual([]);
});

test('repo.updateState is immutable', async () => {
  const repo = makeInMemoryRepo();
  const before = await repo.readState();
  await repo.updateState(s => ({ ...s, skip_dates: [...s.skip_dates, '2026-05-02'] }));
  expect(before.skip_dates).toEqual([]);  // 元の参照は変わらない
});
```

## 12. 関連 docs

- [00-architecture.md](./00-architecture.md)
- [22-retrospective-and-writeback.md](./22-retrospective-and-writeback.md)
- [../operator/30-migration-from-python.md](../operator/30-migration-from-python.md)
