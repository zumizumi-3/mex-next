## Testing — vitest 流儀

> **対象読者**: テストを書く developer
> **前提**: vitest の基礎
> **読了時間**: 約 7 分

mex-next は **vitest** + 80%+ coverage 目標。LLM / X API / Discord は mock。

## 1. structure

```text
tests/
├── fixtures/
│   ├── python-mex-account.json
│   ├── python-mex-state.json
│   └── ...
├── integration/
│   └── (vertical slice tests, future)
└── unit/
    ├── account-state/
    ├── conversation/
    ├── discord/
    ├── llm/
    ├── posting/
    │   └── collectors/
    ├── settings/
    └── x-api/
```

ファイル名は src の対応 + `.test.ts`:

```text
src/posting/dedup.ts          → tests/unit/posting/dedup.test.ts
src/conversation/intent-router.ts → tests/unit/conversation/intent-router.test.ts
```

## 2. vitest.config.ts

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**'],
      exclude: ['src/**/*.test.ts', 'src/main.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
```

`npm test`, `npm run test:coverage` で実行。

## 3. mock 戦略

### 3.1 LLM Bridge

`LlmProvider` interface を fake で実装:

```typescript
class FakeLlmProvider implements LlmProvider {
  responses = new Map<LlmKind, string | (() => string)>();
  recordedCalls: LlmRequest[] = [];

  async call(req: LlmRequest): Promise<LlmResponse> {
    this.recordedCalls.push(req);
    const r = this.responses.get(req.kind);
    const text = typeof r === 'function' ? r() : (r ?? '');
    return { text, usage: { input_tokens: 10, output_tokens: 5 } };
  }
}

const fake = new FakeLlmProvider();
fake.responses.set('intent_classify', JSON.stringify({ intent: 'schedule.list' }));
```

### 3.2 claude-code subprocess

`execa` を vi.mock:

```typescript
import { vi } from 'vitest';

vi.mock('execa', () => ({
  execa: vi.fn().mockResolvedValue({
    stdout: '{"text":"mocked claude code output"}',
    stderr: '',
    exitCode: 0,
  }),
}));
```

### 3.3 X API

`twitter-api-v2` を partial mock:

```typescript
const fakeClient = {
  v2: {
    userMentionTimeline: vi.fn().mockResolvedValue({ tweets: [...] }),
    search: vi.fn().mockResolvedValue({ tweets: [...] }),
    tweet: vi.fn().mockResolvedValue({ data: { id: '1234' } }),
  },
} as unknown as TwitterApi;
```

### 3.4 Discord

`DiscordPoster` interface (in-memory impl) を使う:

```typescript
class InMemoryDiscordPoster implements DiscordPoster {
  messages: { channelId: string; content: string }[] = [];
  edits: { channelId: string; messageId: string; content: string }[] = [];
  async sendMessage(channelId: string, content: string) {
    this.messages.push({ channelId, content });
    return { messageId: `m-${this.messages.length}` };
  }
  async editMessage(channelId: string, messageId: string, content: string) {
    this.edits.push({ channelId, messageId, content });
  }
}
```

discord.js の Client / Channel 等を直接 mock するのは避ける (脆い)。

### 3.5 file system

実 filesystem を使う場合は `os.tmpdir()` で隔離:

```typescript
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

let testDir: string;
beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'mex-test-'));
});
afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});
```

## 4. 純粋関数の test

state machine / dedup / scheduler のような純粋関数は table-driven test が楽:

```typescript
test.each([
  ['created', 'indexing_context', true],
  ['created', 'scheduled', false],
  ['awaiting_decision', 'scheduled', true],
  ['awaiting_decision', 'expired', true],
  ['published', 'scheduled', false],
])('canTransition(%s, %s) = %s', (from, to, expected) => {
  expect(canTransition(from, to)).toBe(expected);
});
```

## 5. 統合テスト (将来)

`tests/integration/` で vertical slice:

```typescript
test('1 投稿: created → published (vertical)', async () => {
  const repo = await loadFixtureRepo();
  const bridge = makeFakeLlm();
  bridge.responses.set('post_v2_generate', JSON.stringify({ text: '...', topic: '...' }));
  bridge.responses.set('post_v2_quality_judge', JSON.stringify({ scores: { stop_power: 4, ... } }));
  const xApi = makeFakeXApi();

  const session = await createPostingSession(repo);
  await runStateMachine(session, repo, bridge, xApi);
  // ... button [予約] 押下
  await drainPublishQueue(repo, xApi);

  const final = await repo.readState();
  expect(final.posting_sessions[0].state).toBe('published');
  expect(xApi.tweet).toHaveBeenCalledWith({ text: expect.stringContaining('...') });
});
```

## 6. snapshot test の使い所

- prompt 文字列の regression 検出
- LLM レスポンスの parser 出力

```typescript
test('intent classify prompt is stable', () => {
  expect(buildIntentUserPrompt('予約見せて', 'ja')).toMatchSnapshot();
});
```

## 7. 並列実行

vitest はデフォルト並列。共有 state を持たないこと:

```typescript
// WRONG: module-level state は test 間で漏れる
const sharedRepo = ...;

// CORRECT: beforeEach で生成
let repo: AccountRepo;
beforeEach(() => { repo = makeInMemoryRepo(); });
```

## 8. coverage の見方

```bash
npm run test:coverage
open coverage/index.html
```

- `src/main.ts`: integration test で覆う想定なので unit から除外
- `src/observability/logger.ts`: pino wrapper のみで test 対象外
- それ以外は 80% 以上目標

## 9. 失敗の debug

```bash
# 1 ファイルだけ
npx vitest run tests/unit/posting/dedup.test.ts

# watch mode
npx vitest

# verbose
npx vitest run --reporter=verbose

# 特定 test だけ
npx vitest run -t "dedup blocks topic"
```

## 10. 関連 docs

- [00-architecture.md](./00-architecture.md)
- [60-contributing.md](./60-contributing.md)
