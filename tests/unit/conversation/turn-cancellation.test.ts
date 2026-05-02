import { afterEach, describe, expect, it } from 'vitest';
import {
  TurnCancelledError,
  cancelTurn,
  listActiveTurns,
  registerTurn,
  resetTurnRegistryForTest,
  unregisterTurn,
} from '../../../src/conversation/turn-cancellation.js';

describe('turn-cancellation', () => {
  afterEach(() => {
    resetTurnRegistryForTest();
  });

  it('aborts the registered controller when cancelled', () => {
    const controller = new AbortController();
    registerTurn('turn-1', controller, { conversationKey: 'thread-1' });

    expect(controller.signal.aborted).toBe(false);
    const result = cancelTurn('turn-1', { cancelledBy: 'op-1', reason: 'test' });
    expect(result.ok).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    const reason = controller.signal.reason as TurnCancelledError;
    expect(reason).toBeInstanceOf(TurnCancelledError);
    expect(reason.cancelledBy).toBe('op-1');
    expect(reason.reason).toBe('test');
  });

  it('returns not_found when cancelling an unknown turn', () => {
    const result = cancelTurn('does-not-exist');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not_found');
  });

  it('is idempotent on repeated cancel calls', () => {
    const controller = new AbortController();
    registerTurn('turn-2', controller);
    const first = cancelTurn('turn-2');
    const second = cancelTurn('turn-2');
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.reason).toBe('already_cancelled');
  });

  it('lists active turns and removes them on unregister', () => {
    registerTurn('turn-A', new AbortController(), { conversationKey: 'thread-A' });
    registerTurn('turn-B', new AbortController(), { conversationKey: 'thread-B' });
    expect(listActiveTurns().map((t) => t.turnId).sort()).toEqual(['turn-A', 'turn-B']);

    unregisterTurn('turn-A', { status: 'completed' });
    expect(listActiveTurns().map((t) => t.turnId)).toEqual(['turn-B']);
  });

  it('filters listActiveTurns by conversationKey', () => {
    registerTurn('turn-1', new AbortController(), { conversationKey: 'thread-1' });
    registerTurn('turn-2', new AbortController(), { conversationKey: 'thread-2' });
    registerTurn('turn-3', new AbortController(), { conversationKey: 'thread-1' });
    const filtered = listActiveTurns({ conversationKey: 'thread-1' }).map((t) => t.turnId).sort();
    expect(filtered).toEqual(['turn-1', 'turn-3']);
  });

  it('TurnCancelledError carries metadata', () => {
    const error = new TurnCancelledError({
      turnId: 't',
      cancelledBy: 'u',
      reason: 'why',
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('TurnCancelledError');
    expect(error.turnId).toBe('t');
    expect(error.cancelledBy).toBe('u');
    expect(error.reason).toBe('why');
  });
});
