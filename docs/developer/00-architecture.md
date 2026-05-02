## Architecture Overview

> **対象読者**: developer (mex-next の中身を直す人)
> **前提**: TypeScript / Node.js / Discord bot 経験
> **読了時間**: 約 12 分

mex-next は X (Twitter) アカウントの運用 OS。投稿生成機ではなく、1 日中アカウントを回し続ける分散システムです。

## 1. High-level diagram

```mermaid
flowchart TB
    subgraph Discord [Discord Gateway]
        DM[message-handler]
        IX[interactions]
        TM[turn-orchestrator]
    end
    subgraph Core [core engine]
        IR[intent-router]
        PSM[posting state machine]
        SCH[scheduler]
        DDP[dedup]
        RS[retrospective]
        PWB[plan-writeback]
        AUTO[automation/preflight]
    end
    subgraph Bridge [LLM Bridge]
        ANT[anthropic SDK]
        CC[claude-code CLI]
    end
    subgraph Storage [account-state]
        AJ[account.json]
        SJ[state.json]
        CT[content/]
    end
    subgraph X [X API client]
        TC[twitter-api-v2]
        POL[poll-state]
    end

    DM --> TM
    TM --> IR
    IR -->|intent + args| PSM
    IR -->|intent + args| SCH
    PSM --> Bridge
    PSM --> Storage
    SCH --> Storage
    POL --> X
    POL --> Storage
    DDP --> Storage
    RS --> Bridge
    RS --> Storage
    PWB --> Bridge
    PWB --> Storage
    AUTO --> Storage
    AUTO --> DM
    PSM --> X
```

## 2. Module 構成

```text
src/
├── main.ts                       # bot entry, signal handling, DI wiring
├── config.ts                     # env / Doppler / argv parsing
├── account-state/                # repo I/O, zod schema, migration
│   ├── account-schema.ts
│   ├── state-schema.ts
│   ├── io.ts                     # read / atomic write / flock
│   ├── repo.ts                   # high-level repo facade (Repository pattern)
│   ├── schema-migration.ts       # default-injection for old state
│   └── plan-writeback.ts         # apply diff to account.json
├── automation/
│   ├── preflight.ts              # 10 hard gates
│   └── escalation.ts             # operator notify pipeline
├── conversation/
│   ├── turn-orchestrator.ts      # turn lock + cancel + recovery
│   ├── intent-router.ts          # natural-language → intent
│   ├── conversation-locks.ts
│   ├── pending-turn-store.ts
│   ├── session-store.ts
│   └── turn-cancellation.ts
├── discord/
│   ├── client.ts                 # discord.js v14 wrapper
│   ├── message-handler.ts        # filter + dispatch
│   ├── interactions.ts           # slash + button + select
│   ├── confirmation.ts           # button-based confirm
│   ├── approval.ts               # one-shot approval store
│   ├── progress-indicator.ts     # ⏳ → ✅/❌ live update
│   ├── thread-lifecycle.ts       # auto-archive + revive
│   └── templates.ts              # card layouts
├── llm/
│   ├── bridge.ts                 # provider router, timeout, retry
│   ├── anthropic-provider.ts
│   ├── claude-code-provider.ts
│   ├── kinds.ts                  # LlmKind ↔ provider/timeout/maxtokens
│   ├── prompts.ts                # all system prompts
│   └── types.ts
├── observability/
│   └── logger.ts                 # pino structured log
├── posting/
│   ├── states.ts                 # state-machine constants + transitions
│   ├── state-machine.ts          # session lifecycle
│   ├── candidate.ts              # draft candidate model
│   ├── context-index.ts          # pre-LLM context bundle
│   ├── draft-generation.ts       # post_v2_generate wrapper
│   ├── quality-judge.ts          # 5-axis hard gate
│   ├── edit-diff.ts              # original→final diff for learning
│   ├── dedup.ts                  # topic + prefix block
│   ├── scheduler.ts              # hot zones + random offset + collision
│   ├── queue.ts                  # publish_queue
│   └── retrospective.ts          # daily/weekly/monthly/quarterly/half
├── settings/
│   ├── cadence.ts                # light/standard/aggressive
│   └── skip.ts                   # skip_today
├── x-api/
│   ├── client.ts                 # twitter-api-v2 wrapper
│   ├── poll-state.ts             # rate limit tracking
│   └── types.ts
└── utils/
    └── jst.ts                    # JST (UTC+9) date helpers
```

各 module は 200-400 行を目処、800 行を超えたら split。

## 3. データフロー (1 投稿 vertical slice)

```mermaid
sequenceDiagram
    participant T as mex-daily timer
    participant Main as main.ts
    participant SM as state-machine
    participant CI as context-index
    participant DG as draft-generation
    participant QJ as quality-judge
    participant LLM as LLM Bridge
    participant SJ as state.json
    participant DC as Discord
    participant X
    T->>Main: trigger
    Main->>SM: createSession()
    SM->>SJ: persist state=created
    SM->>CI: build context
    CI-->>SM: bundle (persona/brand/recent_posts/targets)
    SM->>DG: generate(bundle)
    DG->>LLM: post_v2_generate
    LLM-->>DG: candidate
    SM->>QJ: judge(candidate)
    QJ->>LLM: post_v2_quality_judge
    LLM-->>QJ: scores
    alt 3軸以上 pass
        SM->>SJ: state=awaiting_decision
        SM->>DC: send draft card
    else fail (repair attempt < 2)
        SM->>LLM: post_v2_repair
        LLM-->>SM: repaired
        SM->>QJ: judge(repaired)
    else fail (2nd repair fail)
        SM->>SJ: state=awaiting_decision (force human)
        SM->>DC: card with "需要 review" notice
    end
    Note over DC: customer presses [予約]
    DC->>SM: button interaction
    SM->>SJ: state=scheduled, append publish_queue
    Note over T: mex-publish timer (5min interval)
    Main->>SM: drain publish_queue
    SM->>X: POST /tweets
    X-->>SM: tweet_id
    SM->>SJ: state=published
    SM->>DC: ✅ publish 完了
```

## 4. 依存関係

```mermaid
flowchart LR
    A[main.ts] --> B[discord/]
    A --> C[automation/preflight]
    B --> D[conversation/]
    D --> E[llm/bridge]
    D --> F[posting/]
    F --> G[account-state/]
    F --> E
    F --> H[x-api/]
    F --> I[settings/]
    G --> J[zod]
    E --> K[anthropic-sdk]
    E --> L[claude-code CLI]
    H --> M[twitter-api-v2]
    B --> N[discord.js]
```

依存方向は上流 → 下流のみ:

```text
main → discord → conversation → posting → llm/x-api/account-state/settings → utils
```

逆向きの import は禁止。

## 5. 不変方針 (DESIGN.md §1)

1. **repo が正本** ─ account.json / state.json
2. **core が頭脳** ─ LLM 呼出は bridge 経由
3. **Discord は control plane** ─ 顧客の唯一の窓
4. **1 顧客 = 1 VPS = 1 Discord bot**
5. **自然言語 primary、slash secondary**

## 6. 状態の境界

mutable な state は次の 3 ヶ所のみ:

| location | 何が住む | persistence |
| --- | --- | --- |
| `state.json` | posting_sessions, publish_queue, interaction_queue, inbound_reaction_sessions, skip_dates, x_api_rate_limit | atomic write + flock |
| in-memory | conversation locks, pending turn store, progress indicator, approval store | restart で消える (再構築可) |
| `account.json` | persona, brand, cadence, targets, goal_stack, half_focus, active_window | atomic write + flock |

**immutable**: `content/<id>/content.json` (publish 後は更新しない、archive のみ)

## 7. 並行性

- Node.js single-threaded で event-loop ベース
- ファイル I/O は proper-lockfile で flock
- 同 account に対する複数 process 起動は禁止
- async handler は順序保証なし → conversation lock で 1 turn ずつ serialize

## 8. error 戦略

```typescript
// LLM 系の error は型で区別
class LlmTimeoutError extends Error {}
class LlmInvalidJsonError extends Error {}
class LlmProviderError extends Error {}

// X API は twitter-api-v2 が ApiResponseError を投げる
// → catch で rate_limit / authorization / network を区別
```

intent-router は **すべての error を unknown intent fallback** で吸収 (顧客に向かって投げない)。

## 9. テスト

- vitest
- src と並行構造で `tests/unit/`
- LLM 呼出は mock (LlmProvider interface に対する fake)
- claude-code subprocess は execa で stub
- 80%+ coverage 目標

詳細: [50-testing.md](./50-testing.md)

## 10. 関連 docs

- [10-discord-conversation-engine.md](./10-discord-conversation-engine.md)
- [11-intent-router.md](./11-intent-router.md)
- [12-llm-bridge.md](./12-llm-bridge.md)
- [20-posting-state-machine.md](./20-posting-state-machine.md)
- [40-storage-and-migration.md](./40-storage-and-migration.md)
- [90-glossary.md](./90-glossary.md)
