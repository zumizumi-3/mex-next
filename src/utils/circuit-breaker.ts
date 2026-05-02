/**
 * Circuit breaker — protect against cascading failure when an upstream
 * (LLM provider, X API) is down.
 *
 * State machine:
 *
 *   closed   ──fail × N──▶ open
 *   open     ──Δt elapsed▶ half-open
 *   half-open──ok── ▶ closed
 *   half-open──fail──▶ open
 *
 * In `open` state, `execute` throws `CircuitOpenError` immediately —
 * the wrapped fn is never invoked. This bounds failure latency and
 * lets the caller surface "service degraded" to the operator.
 *
 * Half-open lets a small number of probe calls through. The first
 * success closes the circuit; the first failure re-opens it.
 *
 * The breaker is independent per upstream — keep one instance per
 * provider (LLM, X API). Don't share across unrelated dependencies.
 */

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Consecutive failures in `closed` that trip the circuit to `open`. */
  failureThreshold: number;
  /** Milliseconds in `open` before transitioning to `half-open`. */
  resetTimeoutMs: number;
  /** Probe call budget in `half-open` (default 1). */
  halfOpenAttempts?: number;
  /** Optional clock injection for tests (defaults to Date.now). */
  now?: () => number;
}

/** Thrown when `execute` is called while the circuit is `open`. */
export class CircuitOpenError extends Error {
  constructor(message = 'circuit is open') {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

const DEFAULT_HALF_OPEN_ATTEMPTS = 1;

export class CircuitBreaker<T = unknown> {
  private failures = 0;
  private state: CircuitState = 'closed';
  private openedAt = 0;
  private halfOpenInFlight = 0;
  private halfOpenSuccesses = 0;
  private readonly threshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenAttempts: number;
  private readonly clock: () => number;

  constructor(options: CircuitBreakerOptions) {
    if (options.failureThreshold < 1) {
      throw new Error('CircuitBreaker: failureThreshold must be >= 1');
    }
    if (options.resetTimeoutMs < 0) {
      throw new Error('CircuitBreaker: resetTimeoutMs must be >= 0');
    }
    this.threshold = options.failureThreshold;
    this.resetTimeoutMs = options.resetTimeoutMs;
    this.halfOpenAttempts = options.halfOpenAttempts ?? DEFAULT_HALF_OPEN_ATTEMPTS;
    this.clock = options.now ?? (() => Date.now());
  }

  /** Current state. Mirrors a cheap getter for observability. */
  getState(): CircuitState {
    this.maybeTransitionToHalfOpen();
    return this.state;
  }

  /**
   * Reset to `closed` regardless of current state. Use during graceful
   * shutdown / explicit operator recovery so the next start is clean.
   */
  reset(): void {
    this.failures = 0;
    this.state = 'closed';
    this.openedAt = 0;
    this.halfOpenInFlight = 0;
    this.halfOpenSuccesses = 0;
  }

  async execute(fn: () => Promise<T>): Promise<T> {
    this.maybeTransitionToHalfOpen();

    if (this.state === 'open') {
      throw new CircuitOpenError();
    }

    if (this.state === 'half-open') {
      if (this.halfOpenInFlight >= this.halfOpenAttempts) {
        throw new CircuitOpenError('circuit half-open: probe budget exhausted');
      }
      this.halfOpenInFlight += 1;
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  private maybeTransitionToHalfOpen(): void {
    if (this.state !== 'open') return;
    const elapsed = this.clock() - this.openedAt;
    if (elapsed >= this.resetTimeoutMs) {
      this.state = 'half-open';
      this.halfOpenInFlight = 0;
      this.halfOpenSuccesses = 0;
    }
  }

  private recordSuccess(): void {
    if (this.state === 'half-open') {
      this.halfOpenSuccesses += 1;
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
      if (this.halfOpenSuccesses >= this.halfOpenAttempts) {
        this.state = 'closed';
        this.failures = 0;
        this.halfOpenInFlight = 0;
        this.halfOpenSuccesses = 0;
      }
      return;
    }
    this.failures = 0;
  }

  private recordFailure(): void {
    if (this.state === 'half-open') {
      this.state = 'open';
      this.openedAt = this.clock();
      this.halfOpenInFlight = 0;
      this.halfOpenSuccesses = 0;
      return;
    }
    this.failures += 1;
    if (this.failures >= this.threshold) {
      this.state = 'open';
      this.openedAt = this.clock();
    }
  }
}
