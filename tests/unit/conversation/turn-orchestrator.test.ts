import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PendingTurnStore } from '../../../src/conversation/pending-turn-store.js';
import { TurnCancelledError, cancelTurn, listActiveTurns, resetTurnRegistryForTest } from '../../../src/conversation/turn-cancellation.js';
import { buildTurnMessage } from '../../../src/conversation/turn-message.js';
import {
  runConversationTurn,
  type ConversationRunner,
} from '../../../src/conversation/turn-orchestrator.js';

describe('runConversationTurn', () => {
  let tempDir: string;
  let pendingStore: PendingTurnStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mex-orch-'));
    pendingStore = new PendingTurnStore({ filePath: join(tempDir, 'pending.json') });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    resetTurnRegistryForTest();
  });

  it('persists pending then clears on completion', async () => {
    let observedPending: import('../../../src/conversation/pending-turn-store.js').PendingTurnRecord | null = null;
    const runner: ConversationRunner = {
      async run() {
        // Observe what's in the store mid-flight
        const recordsNow = pendingStore.listRecords();
        observedPending = recordsNow[0] ?? null;
        return { output: 'ok' };
      },
    };

    const result = await runConversationTurn({
      accountId: 'zumi-x',
      conversationKey: 'thread-1',
      replyChannelId: 'ch-1',
      message: buildTurnMessage({ content: 'hello' }),
      runner,
      pendingTurnStore: pendingStore,
    });

    expect(result.output).toBe('ok');
    expect(observedPending).not.toBeNull();
    expect(observedPending?.kind).toBe('user-message');
    // After completion, the record must be cleared
    expect(pendingStore.listRecords()).toEqual([]);
  });

  it('clears pending and re-throws on TurnCancelledError', async () => {
    const runner: ConversationRunner = {
      async run({ turnId }) {
        cancelTurn(turnId, { reason: 'cancel-test' });
        // Wait so the orchestrator sees the abort
        await new Promise((resolve) => setTimeout(resolve, 5));
        // Throw cancel ourselves to simulate downstream honour
        throw new TurnCancelledError({ turnId, reason: 'cancel-test' });
      },
    };

    await expect(
      runConversationTurn({
        accountId: 'zumi-x',
        conversationKey: 'thread-2',
        replyChannelId: 'ch-2',
        message: buildTurnMessage({ content: 'hello' }),
        runner,
        pendingTurnStore: pendingStore,
      }),
    ).rejects.toBeInstanceOf(TurnCancelledError);
    expect(pendingStore.listRecords()).toEqual([]);
    expect(listActiveTurns()).toEqual([]);
  });

  it('translates abort signal into TurnCancelledError', async () => {
    const runner: ConversationRunner = {
      async run({ abortSignal, turnId }) {
        // Self-abort via the registry, then throw a generic error
        cancelTurn(turnId, { reason: 'aborted-test' });
        // Yield once so the abort propagates
        await Promise.resolve();
        if (abortSignal.aborted) {
          throw new Error('downstream noticed abort');
        }
        return { output: 'should-not-happen' };
      },
    };

    await expect(
      runConversationTurn({
        accountId: 'zumi-x',
        conversationKey: 'thread-3',
        replyChannelId: 'ch-3',
        message: buildTurnMessage({ content: 'go' }),
        runner,
        pendingTurnStore: pendingStore,
      }),
    ).rejects.toBeInstanceOf(TurnCancelledError);
    expect(pendingStore.listRecords()).toEqual([]);
  });

  it('clears pending on non-cancellation error and re-throws', async () => {
    const runner: ConversationRunner = {
      async run() {
        throw new Error('downstream blew up');
      },
    };
    await expect(
      runConversationTurn({
        accountId: 'zumi-x',
        conversationKey: 'thread-4',
        replyChannelId: 'ch-4',
        message: buildTurnMessage({ content: 'hi' }),
        runner,
        pendingTurnStore: pendingStore,
      }),
    ).rejects.toThrow('downstream blew up');
    expect(pendingStore.listRecords()).toEqual([]);
    expect(listActiveTurns()).toEqual([]);
  });

  it('passes onStatus through to the runner', async () => {
    const seen: string[] = [];
    const runner: ConversationRunner = {
      async run({ onStatus }) {
        await onStatus?.('thinking');
        await onStatus?.('drafting');
        return { output: 'done' };
      },
    };
    await runConversationTurn({
      accountId: 'zumi-x',
      conversationKey: 'thread-5',
      replyChannelId: 'ch-5',
      message: buildTurnMessage({ content: 'go' }),
      runner,
      pendingTurnStore: pendingStore,
      onStatus: (status: string) => {
        seen.push(status);
      },
    });
    expect(seen).toEqual(['thinking', 'drafting']);
  });
});
