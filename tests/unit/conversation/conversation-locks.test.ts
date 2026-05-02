import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_QUEUED,
  getConversationLockState,
  resetConversationLocksForTest,
  runWithConversationLock,
  setConversationLockStatus,
} from '../../../src/conversation/conversation-locks.js';

describe('conversation-locks', () => {
  afterEach(() => {
    resetConversationLocksForTest();
  });

  it('serializes calls for the same conversation key', async () => {
    const order: string[] = [];

    const release1 = withResolvers<void>();
    const release2 = withResolvers<void>();

    const p1 = runWithConversationLock('thread-a', async () => {
      order.push('start-1');
      await release1.promise;
      order.push('end-1');
    });
    // Allow p1 to enter the critical section before queuing p2
    await flushMicrotasks();
    const p2 = runWithConversationLock('thread-a', async () => {
      order.push('start-2');
      await release2.promise;
      order.push('end-2');
    });

    // While p1 is running, p2 must not have started yet.
    expect(order).toEqual(['start-1']);
    expect(getConversationLockState('thread-a').queuedCount).toBe(1);

    release1.resolve();
    await p1;
    // p2 should now be in flight
    await flushMicrotasks();
    expect(order).toEqual(['start-1', 'end-1', 'start-2']);
    release2.resolve();
    await p2;
    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
  });

  it('runs different conversation keys in parallel', async () => {
    const release = withResolvers<void>();
    const order: string[] = [];

    const p1 = runWithConversationLock('thread-a', async () => {
      order.push('a-start');
      await release.promise;
      order.push('a-end');
    });
    const p2 = runWithConversationLock('thread-b', async () => {
      order.push('b-start');
    });

    await p2;
    expect(order).toEqual(['a-start', 'b-start']);
    release.resolve();
    await p1;
  });

  it('reports running state and clears it after completion', async () => {
    const release = withResolvers<void>();
    const promise = runWithConversationLock('thread-z', async () => {
      await release.promise;
    });
    await flushMicrotasks();
    expect(getConversationLockState('thread-z').running).toBe(true);
    release.resolve();
    await promise;
    expect(getConversationLockState('thread-z').running).toBe(false);
  });

  it('records a status string when set during a run', async () => {
    const release = withResolvers<void>();
    const promise = runWithConversationLock('thread-s', async () => {
      setConversationLockStatus('thread-s', 'thinking');
      await release.promise;
    });
    await flushMicrotasks();
    expect(getConversationLockState('thread-s').status).toBe('thinking');
    release.resolve();
    await promise;
  });

  it('releases the lock even when the function throws', async () => {
    await expect(
      runWithConversationLock('thread-e', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(getConversationLockState('thread-e').running).toBe(false);

    // A subsequent call should run normally.
    let ran = false;
    const result = await runWithConversationLock('thread-e', async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(result.accepted).toBe(true);
  });

  it('returns accepted=true with the function value on success', async () => {
    const result = await runWithConversationLock('thread-v', async () => 42);
    expect(result).toEqual({ accepted: true, value: 42 });
  });

  it(`rejects new callers when the queue cap (${MAX_QUEUED}) is hit`, async () => {
    // Hold the head of the lock so anything else queues behind it.
    const release = withResolvers<void>();
    const queueReleases: Array<{ promise: Promise<void>; resolve: () => void }> = [];
    const inflight = runWithConversationLock('thread-cap', async () => {
      await release.promise;
    });
    await flushMicrotasks();

    // Saturate the queue exactly to MAX_QUEUED waiters.
    const queued: Array<Promise<unknown>> = [];
    for (let i = 0; i < MAX_QUEUED; i += 1) {
      const r = withResolvers<void>();
      queueReleases.push(r);
      queued.push(
        runWithConversationLock('thread-cap', async () => {
          await r.promise;
        }),
      );
      await flushMicrotasks();
    }

    expect(getConversationLockState('thread-cap').queuedCount).toBe(MAX_QUEUED);

    // The (MAX_QUEUED + 1)-th caller must be rejected without running.
    let extraRan = false;
    const overflow = await runWithConversationLock('thread-cap', async () => {
      extraRan = true;
    });
    expect(overflow).toEqual({ accepted: false });
    expect(extraRan).toBe(false);

    // Drain everything so the test exits cleanly.
    release.resolve();
    await inflight;
    for (const r of queueReleases) {
      r.resolve();
    }
    await Promise.all(queued);
  });
});

function withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  // Give the lock at least a few microtask ticks so its initial
  // `await previous.catch(() => {})` clears and `fn` starts.
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}
