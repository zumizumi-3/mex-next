/**
 * Retry with exponential backoff + jitter.
 *
 * Used by:
 *   - LLM bridge: wrap provider calls (transport / 5xx / rate-limit)
 *   - X API client: 429 / 5xx (delegated through `shouldRetry`)
 *   - publish executor: transient transport errors
 *
 * Design choices:
 *   - `attempts` counts total tries (including the first), so attempts=3
 *     means up to 2 retries.
 *   - Backoff is `initial * factor^index`, capped at `maxDelayMs`.
 *   - Jitter is symmetric ±25% so two retriers never thunder at the
 *     same instant.
 *   - `shouldRetry` is consulted on every error. Returning false makes
 *     the error propagate immediately (used for 401, programming bugs,
 *     etc.). Default policy: always retry.
 *   - `signal.aborted` is checked before each attempt and after each
 *     wait — abort throws `RetryAbortedError` deterministically so
 *     callers can distinguish abort from operational failure.
 *
 * The function is intentionally framework-free (no logger / no timer
 * injection) so it can be unit-tested with `vi.useFakeTimers()`.
 */

export interface RetryOptions {
  /** Total attempts including the first call. Must be >= 1. */
  attempts: number;
  /** Delay before the first retry, in milliseconds. */
  initialDelayMs: number;
  /** Cap on the backoff delay before jitter. */
  maxDelayMs: number;
  /** Backoff multiplier per attempt (default 2). */
  backoffFactor?: number;
  /**
   * Decide whether a given error should be retried. `attemptIndex` is
   * 0-based for the *failed* attempt (so 0 means "first attempt failed").
   * Default: always retry.
   */
  shouldRetry?: (error: unknown, attemptIndex: number) => boolean;
  /**
   * Hook invoked just before sleeping. Lets callers log retry context
   * without contaminating retry semantics.
   */
  onRetry?: (error: unknown, attemptIndex: number, nextDelayMs: number) => void;
  /** Optional abort signal — throws `RetryAbortedError` when triggered. */
  signal?: AbortSignal;
}

/** Thrown when the abort signal fires during a retry sequence. */
export class RetryAbortedError extends Error {
  constructor(message = 'retry aborted') {
    super(message);
    this.name = 'RetryAbortedError';
  }
}

const JITTER_RATIO = 0.25;
const DEFAULT_BACKOFF_FACTOR = 2;

/**
 * Execute `fn` with retry/backoff. Returns the first successful value,
 * or throws the last error after `attempts` attempts.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  if (!Number.isFinite(options.attempts) || options.attempts < 1) {
    throw new Error(`retryWithBackoff: attempts must be >= 1 (got ${options.attempts})`);
  }
  const factor = options.backoffFactor ?? DEFAULT_BACKOFF_FACTOR;
  const shouldRetry = options.shouldRetry ?? (() => true);

  let lastError: unknown;
  for (let attemptIndex = 0; attemptIndex < options.attempts; attemptIndex += 1) {
    if (options.signal?.aborted) {
      throw new RetryAbortedError();
    }
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;
      const isLast = attemptIndex >= options.attempts - 1;
      if (isLast) break;
      if (!shouldRetry(error, attemptIndex)) break;

      const delay = computeDelayMs({
        attemptIndex,
        initialDelayMs: options.initialDelayMs,
        maxDelayMs: options.maxDelayMs,
        backoffFactor: factor,
      });
      options.onRetry?.(error, attemptIndex, delay);
      await sleepWithSignal(delay, options.signal);
    }
  }
  throw lastError;
}

/**
 * Compute the next backoff delay including jitter.
 *
 * Exponential growth `initial * factor^index`, then clamped to
 * `maxDelayMs`, then jittered ±25%.
 */
export function computeDelayMs(opts: {
  attemptIndex: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
}): number {
  const base = opts.initialDelayMs * Math.pow(opts.backoffFactor, opts.attemptIndex);
  const capped = Math.min(base, opts.maxDelayMs);
  const jitter = capped * JITTER_RATIO * (Math.random() * 2 - 1); // ±25%
  const result = capped + jitter;
  return Math.max(0, Math.round(result));
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    if (signal?.aborted) return Promise.reject(new RetryAbortedError());
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RetryAbortedError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new RetryAbortedError());
    };
    signal?.addEventListener('abort', onAbort);
  });
}
