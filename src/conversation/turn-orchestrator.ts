/**
 * Per-turn orchestration.
 *
 * Ported from wah-office-v2 `turn-orchestrator.js`, slimmed to MeX's
 * needs (no internal/parallel/coordination subagents).
 *
 * One {@link runConversationTurn} call covers:
 *   1. register the turn for cancellation
 *   2. persist a pending-turn record (so a crash leaves a trail)
 *   3. invoke the LLM bridge through the injected runner
 *   4. clear the pending-turn record on success
 *   5. translate AbortSignal aborts into TurnCancelledError
 *
 * Concurrency policing (one-turn-per-thread) lives in
 * conversation-locks; the caller wraps this in
 * {@link runWithConversationLock}.
 */

import type { Logger } from 'pino';
import { ulid } from 'ulid';
import type { PendingTurnStore } from './pending-turn-store.js';
import { TurnCancelledError, registerTurn, unregisterTurn } from './turn-cancellation.js';
import { TurnMessageSchema, type TurnMessage } from './turn-message.js';

/**
 * Result of a single turn — what gets surfaced back to the user.
 * `output` may be empty (e.g. if the engine decides to stay silent).
 */
export interface TurnResult {
  readonly output: string;
  readonly suppressReply?: boolean;
  readonly components?: ReadonlyArray<unknown>;
  readonly followUp?: { content: string; delaySec: number };
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Status callback signature used to feed the progress indicator. */
export type StatusCallback = (status: string) => void | Promise<void>;

export interface ConversationTranscriptTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/**
 * The conversation engine's only point of contact with the LLM.
 * WO-FRESH-3 supplies the implementation; this module just calls it.
 */
export interface ConversationRunner {
  run(input: {
    readonly conversationKey: string;
    readonly accountId: string;
    readonly turnId: string;
    readonly message: TurnMessage;
    readonly transcript?: ReadonlyArray<ConversationTranscriptTurn>;
    readonly abortSignal: AbortSignal;
    readonly onStatus?: StatusCallback;
  }): Promise<TurnResult>;
}

export interface RunConversationTurnInput {
  readonly accountId: string;
  readonly conversationKey: string;
  readonly replyChannelId: string;
  readonly message: TurnMessage;
  readonly transcript?: ReadonlyArray<ConversationTranscriptTurn>;
  readonly runner: ConversationRunner;
  readonly pendingTurnStore?: PendingTurnStore;
  readonly logger?: Logger;
  readonly kind?: string;
  readonly onStatus?: StatusCallback;
}

export interface RunConversationTurnOutput extends TurnResult {
  readonly turnId: string;
}

/**
 * Run a single conversation turn. Throws {@link TurnCancelledError}
 * if the turn was cancelled mid-flight; all other errors propagate
 * unchanged.
 */
export async function runConversationTurn(
  input: RunConversationTurnInput,
): Promise<RunConversationTurnOutput> {
  // Validate the turn message at the boundary before doing any work.
  const message = TurnMessageSchema.parse(input.message);

  const turnId = ulid();
  const abortController = new AbortController();
  const log = input.logger?.child({ subsystem: 'turn-orchestrator', turnId });
  const kind = input.kind ?? 'user-message';

  registerTurn(turnId, abortController, {
    conversationKey: input.conversationKey,
    discordUserId: message.author?.id ?? null,
    startedAt: Date.now(),
  });

  const persistPending = (): void => {
    if (!input.pendingTurnStore) {
      return;
    }
    try {
      input.pendingTurnStore.setRecord(input.conversationKey, {
        replyChannelId: input.replyChannelId,
        accountId: input.accountId,
        requestedAt: new Date().toISOString(),
        kind,
      });
    } catch (error) {
      log?.warn({ error: errMsg(error) }, 'pending_turn_persist_failed');
    }
  };

  const clearPending = (): void => {
    if (!input.pendingTurnStore) {
      return;
    }
    try {
      input.pendingTurnStore.delete(input.conversationKey);
    } catch (error) {
      log?.warn({ error: errMsg(error) }, 'pending_turn_clear_failed');
    }
  };

  log?.info(
    {
      conversationKey: input.conversationKey,
      authorId: message.author?.id ?? null,
      kind,
    },
    'turn_started',
  );

  persistPending();
  try {
    const result = await input.runner.run({
      conversationKey: input.conversationKey,
      accountId: input.accountId,
      turnId,
      message,
      ...(input.transcript ? { transcript: input.transcript } : {}),
      abortSignal: abortController.signal,
      onStatus: input.onStatus,
    });
    log?.info({ conversationKey: input.conversationKey }, 'turn_completed');
    unregisterTurn(turnId, { status: 'completed' });
    clearPending();
    return { ...result, turnId };
  } catch (error) {
    if (error instanceof TurnCancelledError || abortController.signal.aborted) {
      const cancelError =
        error instanceof TurnCancelledError
          ? error
          : new TurnCancelledError({ turnId, reason: 'aborted' });
      log?.info(
        { conversationKey: input.conversationKey, reason: cancelError.reason },
        'turn_cancelled',
      );
      unregisterTurn(turnId, { status: 'cancelled' });
      clearPending();
      throw cancelError;
    }
    log?.error({ conversationKey: input.conversationKey, error: errMsg(error) }, 'turn_failed');
    unregisterTurn(turnId, { status: 'failed' });
    clearPending();
    throw error;
  }
}

function errMsg(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
