# MeX Next — Design Document

> Python 実装 (`zumizumi-3/mex`) で確立した設計と方向性を保持しつつ、Node.js + TypeScript で再構築する。
> 移植時に **守る**べきもの / **捨てる**べきものを明示する。

## 1. 不変の方向性

### 1.1 X 運用 OS であって投稿生成機ではない

- repo が正本 (account.json / state.json が唯一の真実)
- core が頭脳 (LLM 呼出を集約)
- Discord は control plane (顧客の唯一の窓)
- 朝 1 本投稿 (light cadence default) → 反応判断 → 振り返りの **OS としての一日**

### 1.2 1 顧客 = 1 VPS = 1 Discord bot

- multi-tenant にしない (混線リスク回避)
- account-id ごとに systemd unit / Doppler project を分ける
- bot token / X API key は account ごとに独立

### 1.3 顧客は Discord しか触らない

- Doppler / X Developer Portal / GitHub に顧客はアクセスしない
- operator が install 時に全部用意
- 顧客は **自然文で話しかける** か、補助的に /mex slash command を使う

### 1.4 自然言語 primary、slash secondary

- 自然文で操作できる (intent_router 経由)
- slash command は power user / operator 用に並行
- 顧客には「話しかけて」と onboard、slash は教えない

## 2. 業務ロジック (言語に依存しない、Python から TS に忠実移植)

### 2.1 Posting v2 状態機械

```
created
  → indexing_context  (LLM 用 context 構築)
  → generating        (LLM で draft 生成)
  → validating        (5-axis 品質 judge)
  → repairing         (修正生成、最大 2 回)
  → awaiting_decision (顧客承認待ち)
  → revising          (顧客指示で修正)
  → scheduled         (publish_queue に投入)
  → published / failed_terminal / expired (24h TTL)
```

- TERMINAL_STATES = {published, failed_terminal, expired}
- session TTL = 24h、過ぎたら expired

### 2.2 5-axis 品質 judge (hard gate)

```
stop_power      ─ 最初の 1 行で読者を止められるか
specificity     ─ 抽象論で逃げてないか
progression     ─ 起承転結 / 流れがあるか
voice_match     ─ 顧客の声に合っているか
length_fit      ─ 280 文字制限で破綻してないか
```

- 各 0-5 点、3 点以上 = pass、合計 3 軸 pass で hard gate 通過
- fail なら repairing に戻る、2 回失敗で awaiting_decision (人間判断)

### 2.3 Cadence

- profile: light (default) / standard / aggressive
- light = 1 本/日、朝 06:00-09:00 JST のみ
- hot_zones で時間帯指定、各 zone で random offset (max ±30min)
- 同時刻 ±30min 衝突回避 + 5 回失敗で翌日 fallback
- skip_today で当日キャンセル

### 2.4 Dedup

- 同 topic は過去 7 日 + 未来 7 日でチェック
- 本文先頭 80 文字 prefix 完全一致を block (`too_similar_recent`)
- LLM プロンプトに「直近で書いた topic / 本文 prefix」を注入

### 2.5 Edit-diff 学習ループ

- 顧客の修正前後 (original → final) を `compute_edit_diff` で記録
- exemplar として state に蓄積、以降の draft 生成で「過去にこういう修正をされた」を参照

### 2.6 Periodic retrospective (horizon-parameterized)

| horizon | 頻度 | LLM 入力 | writeback 対象 |
|---|---|---|---|
| daily | 毎日 19:00 JST | 当日の投稿 + reactions | (なし) |
| weekly | 月曜 07:00 JST | 当週 7 日 | (なし) |
| monthly | 月初 | 当月 | active_window |
| quarterly | 四半期初 | 当四半期 | goal_stack / brand |
| half | 半期初 | 当半期 | half_focus |

- 確定 = 顧客が button 押す or 24h 自動確定
- horizon 遷移は state.last_retrospective_at で管理

### 2.7 Plan writeback

- monthly → active_window (今月の主軸 topic / 役割 / 配分)
- quarterly → goal_stack / brand (3 ヶ月の方向)
- half → half_focus (半期の柱)
- diff カードを Discord で見せて「適用 / ロールバック」button

### 2.8 Inbound 反応の処理

```
X API poll (mex-reactions-poll.timer, 30min)
  ↓
mentions / quotes / retweets を取得
  ↓
risk 判定 (LLM)
  ├─ low_risk     → customer channel に thread (顧客判断)
  ├─ medium_risk  → operator channel に escalate + customer に notice
  └─ high_risk    → operator channel only + customer に notice (本文非表示)
  ↓
顧客 button or 自然文で「下のやつ」「スキップ」
```

### 2.9 Operator escalation pipeline

- automation preflight (10 hard gate) → fail で operator に DM
- publish 失敗 → 1 回目 + 3 回目で escalate (2/4 absorb)
- channel 解決失敗 → silent return しない、必ず operator に届ける

## 3. Discord 対話エンジン (wah-office-v2 から移植)

### 3.1 移植するパターン

| パターン | wah-office-v2 ファイル | mex-next 対応 |
|---|---|---|
| Message handler | `src/discord-message-handler.js` | `src/discord/message-handler.ts` |
| Conversation lock | `src/conversation-locks.js` | `src/discord/conversation-locks.ts` |
| Pending turn store | `src/pending-turn-store.js` | `src/conversation/pending-turn-store.ts` |
| Turn orchestrator | `src/turn-orchestrator.js` | `src/conversation/turn-orchestrator.ts` |
| Progress indicator | `src/discord-status.js` | `src/discord/progress-indicator.ts` |
| Approval store | `src/approval-store.js` | `src/discord/approval.ts` |
| Reaction confirmation | `src/discord-confirmation.js` | `src/discord/confirmation.ts` |
| Thread lifecycle | `src/discord-thread-lifecycle.js` | `src/discord/thread-lifecycle.ts` |
| Auto-unarchive | `src/discord/auto-unarchive.js` | `src/discord/thread-lifecycle.ts` |
| Session store | `src/session-store.js` | `src/conversation/session-store.ts` |
| Judgment events | `src/judgment-events.js` | `src/observability/judgment-events.ts` |
| Operator allowlist | (config) | `src/config.ts` |

### 3.2 自然言語 → intent

```
1. message 受信
2. shouldHandleMessage で filter (DM or @mention or operator allowlist)
3. shouldRouteAsCommand なら slash と同じ handler に dispatch
4. それ以外 = 自然文 → conversation/intent-router.ts
5. Claude で intent + args + confirmation_needed を抽出
6. confirmation_needed なら button (はい/いいえ) + ephemeral 確認
7. handler 実行 → progress indicator が ⏳ → ✅/❌ で更新
```

### 3.3 destructive intent ホワイトリスト

LLM hallucination で破壊的操作が無確認実行されるのを防ぐ:

```
DESTRUCTIVE_INTENTS = {
  schedule.cancel, schedule.publish_now,
  target.remove, automation.enable_all,
  cadence.skip_today, cadence.set_*
}
```

これらは LLM 出力に関わらず confirmation を強制。

## 4. ストレージ

### 4.1 Account repo

- `<account>-x-ops/` (顧客側 GitHub)
- `account.json` (永続設定: persona / cadence / targets / approval_policy / brand / goal_stack)
- `state.json` (runtime: posting_sessions / publish_queue / interaction_queue / inbound_reaction_sessions / skip_dates)
- `content/<content-id>/content.json + draft.json`
- atomic write + flock (concurrent run 安全)

### 4.2 Schema (zod)

`src/account-state/schema.ts` で zod schema を一元管理。
Python 版の schema_migration の挙動 (古い state.json でも欠けてれば default を inject) を保つ。

### 4.3 Doppler

- secrets (X API key, Anthropic key, Discord bot token, GitHub token) は **Doppler 一元**
- env file (`/etc/mex/<account>.env`) には DOPPLER_TOKEN だけ

## 5. LLM Bridge

### 5.1 Provider

- claude_code (CLI subprocess、思考重い系: 5-axis judge / draft 生成 / 振り返り)
- anthropic (SDK 直接、軽量系: intent classify / risk classify / suggestion)

### 5.2 Kinds (ログ追跡用)

```
post_v2_generate, post_v2_quality_judge, post_v2_repair, post_v2_revise
intent_classify, intent_classify_confirmation
inbound_risk_classify, inbound_reply_draft, quote_v2_generate, quote_v2_edit
periodic_retrospective_generate, periodic_retrospective_apply
plan_writeback_diff, plan_writeback_apply
```

各 kind に timeout / max_tokens を定義。

### 5.3 Prompt キャッシュ

Anthropic SDK の prompt caching を全 kind で活用 (5min TTL)。
- system prompt = persona + brand = キャッシュ
- user 入力のみ可変

## 6. デプロイ

### 6.1 systemd

- `mex-bot.service` ─ メイン bot (long-running)
- `mex-self-update.timer` ─ 30min 間隔で git pull + restart
- `mex-reactions-poll-<account>.timer` ─ 30min 間隔で反応収集
- `mex-daily-<account>.timer` ─ 朝 07:00 JST で daily_auto_post
- `mex-weekly-retro-<account>.timer` ─ 月曜 07:00 JST で weekly retro
- `mex-publish-<account>.timer` ─ 5min 間隔で scheduled publish (failsafe)

### 6.2 self-update

```
git pull origin main → npm install → npm run build → systemctl restart mex-bot
```

`deploy/mex-core-desired.json` で account 別の ref pin (default `main`)。

### 6.3 install

```
scripts/install.sh   ─ Node 20 + Doppler CLI + gh CLI + Claude Code 等の tools
scripts/bootstrap.sh ─ account 単位で Doppler / Discord / systemd 整備
```

## 7. テスト

### 7.1 vitest

- src と同じ階層に `*.test.ts`
- 80%+ coverage 目標
- LLM 呼出は mock (claude_code subprocess も execa で stub)

### 7.2 統合テスト

- `tests/integration/` で account.json + state.json fixture を使った E2E
- 1 投稿 → schedule → publish の vertical slice
- inbound reply → risk classify → customer thread の vertical slice

## 8. 移行 (Python MeX → mex-next)

### 8.1 ステップ

1. account.json / state.json は **互換** (zod schema が両方を読める)
2. `scripts/migrate-from-python.ts` で sanity check
3. mex-bot.service の ExecStart を node に切替
4. systemd timer は **同名** で job だけ TS 実装に差替え

### 8.2 並行運用しない

- 同じ account に Python bot と mex-next を同時起動 = race
- 1 account = 1 bot を維持、bot だけ swap

## 9. やらないこと (明示的に捨てる)

### 9.1 multi-tenant 1 bot

- 1 bot で複数 account 扱う構造にはしない
- Python 版の `accounts-registry.json` は維持するが「同一 VPS で複数 account」は最小限

### 9.2 Web UI / dashboard

- Discord 内で完結
- 別 web フロントエンドは作らない (顧客の前提を増やさない)

### 9.3 GraphQL / REST API

- 内部だけ (主に LLM bridge と X API client)
- 顧客向け / operator 向けの公開 API は出さない

### 9.4 SaaS 化

- multi-tenant SaaS にはしない
- 1 顧客 1 VPS の self-hosted モデル

## 10. 段階的ロールアウト

### Phase 1 (this session): 骨組み + Discord engine
- foundation (このファイル + package.json + tsconfig + 構造)
- Discord 対話エンジン (wah-office-v2 移植)
- LLM bridge + intent router (TS 版)
- 1 vertical slice (投稿 1 本作成 → 確認 → 予約 → 仮 publish)

### Phase 2: domain modules
- account-state IO + zod schema
- posting state machine 完全移植
- scheduler + dedup + cadence
- X API client (twitter-api-v2)

### Phase 3: 周辺
- periodic retrospective + plan writeback
- inbound collectors
- automation preflight + operator escalation
- self-update + timers
- 顧客 docs / operator docs

### Phase 4: deploy + 移行
- install.sh / bootstrap.sh
- 既存 Python MeX 顧客の移行 (zumi-x が pilot)
- 安定運用 1 週間 → cut-over

## 11. 命名規則

- TypeScript: camelCase, PascalCase for types/classes
- ファイル名: kebab-case (`message-handler.ts`)
- Discord channel role: snake_case (`conversation_digest` etc、Python 互換)
- LLM kind: snake_case (Python 互換)
- account-id: kebab-case (`zumi-x`)

## 12. ライセンス / 著作

- private
- wah-office-v2 から移植したコードは元の著作者を保持
- Python MeX から移植したロジックは内製
