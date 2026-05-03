## Discord conversation engine (wah-office-v2 ported)

> **対象読者**: discord/ + conversation/ を直す developer
> **前提**: discord.js v14 の基礎、async/await
> **読了時間**: 約 10 分

`wah-office-v2` で完成していた対話エンジンを TypeScript で移植したものです。重要パターンと、mex-next 固有の調整を扱います。

## 1. 移植対応表

| pattern               | wah-office-v2 (JS)                | mex-next (TS)                            |
| --------------------- | --------------------------------- | ---------------------------------------- |
| Message handler       | `src/discord-message-handler.js`  | `src/discord/message-handler.ts`         |
| Conversation lock     | `src/conversation-locks.js`       | `src/conversation/conversation-locks.ts` |
| Pending turn store    | `src/pending-turn-store.js`       | `src/conversation/pending-turn-store.ts` |
| Turn orchestrator     | `src/turn-orchestrator.js`        | `src/conversation/turn-orchestrator.ts`  |
| Progress indicator    | `src/discord-status.js`           | `src/discord/progress-indicator.ts`      |
| Approval store        | `src/approval-store.js`           | `src/discord/approval.ts`                |
| Reaction confirmation | `src/discord-confirmation.js`     | `src/discord/confirmation.ts`            |
| Thread lifecycle      | `src/discord-thread-lifecycle.js` | `src/discord/thread-lifecycle.ts`        |
| Auto-unarchive        | `src/discord/auto-unarchive.js`   | `src/discord/thread-lifecycle.ts` (統合) |
| Session store         | `src/session-store.js`            | `src/conversation/session-store.ts`      |
| Judgment events       | `src/judgment-events.js`          | `src/observability/judgment-events.ts`   |
| Operator allowlist    | (config)                          | `src/config.ts`                          |

## 2. message → handler のフロー

```mermaid
flowchart TB
    A[Discord MESSAGE_CREATE] --> B[shouldHandleMessage]
    B -->|filter pass| C[shouldRouteAsCommand?]
    B -->|filter fail| Z[ignore]
    C -->|yes| D[slash dispatcher]
    C -->|no| E[turn-orchestrator.start]
    E --> F{conversation lock?}
    F -->|locked| G[queue 後で再試行]
    F -->|free| H[acquire lock]
    H --> I[agent-loop]
    I --> J{reply / tool_call}
    J -->|destructive tool| K[pending confirmation]
    J -->|display/safe tool| L[handler 実行 or direct reply]
    J -->|fallbackToLegacy| IR[intent-router fallback]
    IR --> L
    K -->|next turn: はい| L
    L --> M[release lock]
```

### 2.1 shouldHandleMessage

`src/discord/message-handler.ts` の filter:

- DM: 常に handle
- guild channel: `@bot` mention 付き or operator allowlist 内
- bot 自分の発言は無視
- `/` で始まる = slash command (別 handler に dispatch)

### 2.2 turn-orchestrator

1 顧客 = 1 turn lock。並行発言は queue されて順次実行。
turn の途中でユーザーが新メッセージを送ると、進行中 turn を **cancel** して新 turn に切替 (turn-cancellation)。

```mermaid
sequenceDiagram
    participant U as User
    participant MH as message-handler
    participant TO as turn-orchestrator
    participant CL as conversation-locks
    participant AL as agent-loop
    participant IR as intent-router fallback
    participant H as handlers
    participant DP as DiscordPoster
    U->>MH: messageCreate
    MH->>TO: runTurn
    TO->>CL: acquire(userId)
    TO->>AL: state snapshot + jsonSchema
    AL-->>TO: reply + tool_call
    alt fallbackToLegacy
        TO->>IR: classifyIntent
        IR-->>TO: intent + args
    end
    TO->>H: dispatch tool/intent
    H-->>TO: result
    TO->>DP: postMessage
    TO->>CL: release
```

```typescript
const result = await turnOrchestrator.run({
  userId,
  channelId,
  messageId,
  userText,
  handler: async (signal) => {
    // signal.aborted を時々チェックして cancel に応える
    return await runner.run({ userText, ... });
  },
});
```

### 2.3 conversation locks

`Map<userId, Promise<void>>` の単純 lock。`acquire(userId)` で前 turn の完了を await し、release されてから次 turn に進む。

```typescript
async function acquireLock(userId: string): Promise<() => void> {
  const previous = locks.get(userId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(
    userId,
    previous.then(() => next),
  );
  await previous;
  return release;
}
```

restart で全消失するが、顧客が新メッセージを送れば自然に復元。

## 3. progress indicator

長い処理 (LLM 呼出 + 5-axis judge + DB 書き込み) を 1 通の card で見せる:

```typescript
const card = await progressIndicator.start({
  channel,
  initialText: '⏳ 投稿案を生成しています...',
});
try {
  await heavyWork();
  await card.update('✅ 投稿案ができました\n...');
} catch (err) {
  await card.update('❌ エラーが発生しました');
  throw err;
}
```

Discord の rate limit (5 edits / 5s) を内部で respect。

## 4. confirmation flow

destructive tool / legacy destructive intent には confirmation を強制する。現在の自然文 UX は `[はい] [いいえ]` button だけでなく、次 turn の「はい」「いいえ」も拾う。

```mermaid
sequenceDiagram
    participant U as user
    participant Bot
    participant Store as pending-confirmation-store
    U->>Bot: 「今日いらない」
    Bot->>Bot: agent loop
    Bot->>Store: kind=tool, pendingTool, expires=+5min
    Bot-->>U: 「今日 N 件を取り消します。実行しますか？」
    U->>Bot: 「はい」
    Bot->>Store: pop pending
    alt 期限内
        Bot->>Bot: handler 実行
        Bot-->>U: ✅ 完了
    else 期限切れ
        Bot-->>U: 確認の有効期限が切れました
    end
```

pending confirmation は in-memory で、`conversationKey` ごとに 1 件だけ保持する。TTL は 5 分。

```typescript
type PendingConfirmation =
  | { kind: 'legacy'; intent: IntentName; args: Record<string, unknown> }
  | { kind: 'tool'; pendingTool: { name: string; input: Record<string, unknown> } };
```

`kind=tool` は agent loop の destructive tool、`kind=legacy` は intent-router fallback の destructive intent。restart で消えるが、破壊的操作が勝手に走らない方向なので安全。

## 5. thread lifecycle

長期 thread (`[POST]`, `[RPLY]`, `[QREV]`, `[WREV]`, `[ALERT]`) の auto-archive 復活パターン:

```mermaid
flowchart LR
    A[thread create] --> B[active]
    B -->|24h 無発言| C[auto-archived]
    C -->|next message| D[un-archive + revive]
    D --> B
```

discord.js が thread の archive を自動でやるので、mex-next 側は **archived thread を unarchive する** code を持つ。

```typescript
async function ensureUnarchived(thread: ThreadChannel): Promise<void> {
  if (thread.archived) {
    await thread.setArchived(false);
  }
}
```

## 6. session store (pending recovery)

bot restart 後に進行中の draft 編集 thread を再開する:

```typescript
// state.json の posting_sessions から ACTIVE_STATES のものを抽出
const activeSessions = state.posting_sessions.filter((s) => ACTIVE_STATES.has(s.state));

// 各 session の thread を pending として登録
for (const session of activeSessions) {
  pendingTurnStore.register({
    sessionId: session.id,
    threadId: session.thread_id,
    userId: session.customer_user_id,
  });
}
```

restart 後の 1st message でも、session が紐づいているので適切な flow に戻る。

## 7. judgment events (observability)

判断の追跡用に「いつ・誰の・どんな agent/tool/intent が・どう処理されたか」を構造化 log する。

```typescript
logger.info({
  kind: 'intent_judgement',
  user_id: userId,
  intent: result.intent,
  confirmation_needed: result.confirmationNeeded,
  fallback_reason: result.fallbackReason,
});
```

agent loop が fallback した場合は judgment event `agent_loop_fallback` を出す。operator が `journalctl -o json | jq` で agent / intent 系列の傾向を分析する用。

## 8. operator allowlist

DM 以外の channel での自然文応答は **OPERATOR_DISCORD_USER_IDS** の人だけ。
顧客には DM か `@bot` mention で十分。

```typescript
function shouldHandleMessage(msg: Message): boolean {
  if (msg.author.bot) return false;
  if (msg.channel.isDMBased()) return true;
  if (msg.mentions.has(client.user!.id)) return true;
  if (config.operatorAllowlist.has(msg.author.id)) return true;
  return false;
}
```

## 9. テストの mock 戦略

discord.js を直接 mock するのは骨が折れるので、`DiscordPoster` interface を切って handler を test する:

```typescript
interface DiscordPoster {
  sendMessage(channelId: string, content: string): Promise<{ messageId: string }>;
  editMessage(channelId: string, messageId: string, content: string): Promise<void>;
  createThread(channelId: string, name: string): Promise<{ threadId: string }>;
}
```

tests/unit では `InMemoryDiscordPoster` を使う。実 bot 起動は integration test で。

## 10. 関連 docs

- [11-agent-loop.md](./11-agent-loop.md)
- [11-intent-router.md](./11-intent-router.md)
- [00-architecture.md](./00-architecture.md)
- [50-testing.md](./50-testing.md)
