/**
 * Per-conversation async lock.
 *
 * Ported from wah-office-v2 `conversation-locks.js`.
 *
 * Each conversation key (typically a Discord thread or DM channel id)
 * has an in-memory queue. Calls to {@link runWithConversationLock}
 * for the same key are serialized: a second call waits until the
 * first finishes before its `fn` runs. Calls for different keys
 * proceed concurrently.
 *
 * This lock is process-local. Cross-process serialization (when
 * recovering from crash via the pending-turn-store) is the caller's
 * responsibility.
 */

export interface ConversationLockState {
  /** True iff some `fn` is currently executing for this key. */
  readonly running: boolean;
  /** Wall-clock ms when the current run started, or null if idle. */
  readonly runningSince: number | null;
  /** Number of waiters queued behind the current run. */
  readonly queuedCount: number;
  /** Free-form status string set by the current run via {@link setConversationLockStatus}. */
  readonly status: string;
}

interface InternalLockState {
  runningSince: number | null;
  queuedCount: number;
  status: string;
  tail: Promise<void>;
}

const inflightByConversation = new Map<string, InternalLockState>();

/**
 * Run `fn` while holding the lock for `key`. Other callers for the
 * same key wait their turn. The lock is released when `fn` settles
 * (either resolves or rejects).
 */
export async function runWithConversationLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const existing = inflightByConversation.get(key);
  const previous = existing?.tail ?? Promise.resolve();

  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => {}).then(() => current);

  const state: InternalLockState = existing ?? {
    runningSince: null,
    queuedCount: 0,
    status: '',
    tail: Promise.resolve(),
  };

  if (state.runningSince !== null) {
    state.queuedCount += 1;
  }
  state.tail = tail;
  inflightByConversation.set(key, state);

  await previous.catch(() => {});
  state.runningSince = Date.now();
  state.status = '';
  if (state.queuedCount > 0) {
    state.queuedCount -= 1;
  }

  try {
    return await fn();
  } finally {
    state.runningSince = null;
    state.status = '';
    release();
    if (inflightByConversation.get(key) === state && state.tail === tail) {
      inflightByConversation.delete(key);
    }
  }
}

/** Inspect (without mutating) the current lock state for `key`. */
export function getConversationLockState(key: string): ConversationLockState {
  const state = inflightByConversation.get(key);
  return {
    running: state?.runningSince !== null && state?.runningSince !== undefined,
    runningSince: state?.runningSince ?? null,
    queuedCount: state?.queuedCount ?? 0,
    status: state?.status ?? '',
  };
}

/**
 * Set the human-readable status for the in-flight run on `key`.
 * Typically called from a progress indicator's status callback.
 */
export function setConversationLockStatus(key: string, status: string): void {
  const state = inflightByConversation.get(key);
  if (!state) {
    return;
  }
  state.status = String(status ?? '').trim();
}

/** Test helper: clear all locks. Do not call from production code. */
export function resetConversationLocksForTest(): void {
  inflightByConversation.clear();
}
