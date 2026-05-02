/**
 * retryWithBackoff unit tests.
 *
 * We use vitest fake timers to skip the real backoff sleeps. Math.random
 * is stubbed to a fixed value so jitter is deterministic — otherwise
 * timing assertions would flake.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

import {
  retryWithBackoff,
  computeDelayMs,
  RetryAbortedError,
} from '../../../src/utils/retry.js';

describe('retryWithBackoff', () => {
  beforeEach(() => {
    // Pin jitter to 0 (Math.random=0.5 → ratio*(1*-0+0)=0 ish actually
    // becomes 0 because the formula is jitter * (random*2-1)).
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('returns the value on first success without sleeping', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await retryWithBackoff(fn, {
      attempts: 3,
      initialDelayMs: 100,
      maxDelayMs: 1000,
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries once and then succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue('ok');

    // initialDelay=0 → sleepWithSignal short-circuits, no real timer.
    const result = await retryWithBackoff(fn, {
      attempts: 3,
      initialDelayMs: 0,
      maxDelayMs: 0,
    });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws the last error after exhausting attempts', async () => {
    const final = new Error('final');
    const fn = vi.fn().mockRejectedValue(final);

    await expect(
      retryWithBackoff(fn, {
        attempts: 3,
        initialDelayMs: 0,
        maxDelayMs: 0,
      }),
    ).rejects.toBe(final);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry when shouldRetry returns false (e.g. 401)', async () => {
    const fn = vi.fn().mockRejectedValue({ status: 401, message: 'unauthorized' });
    const shouldRetry = vi.fn(() => false);

    await expect(
      retryWithBackoff(fn, {
        attempts: 5,
        initialDelayMs: 10,
        maxDelayMs: 100,
        shouldRetry,
      }),
    ).rejects.toMatchObject({ status: 401 });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(shouldRetry).toHaveBeenCalledTimes(1);
  });

  it('invokes onRetry with the next delay before sleeping', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue('ok');
    const onRetry = vi.fn();

    await retryWithBackoff(fn, {
      attempts: 3,
      initialDelayMs: 0,
      maxDelayMs: 0,
      onRetry,
    });

    expect(onRetry).toHaveBeenCalledTimes(1);
    const [, attemptIndex, delay] = onRetry.mock.calls[0]!;
    expect(attemptIndex).toBe(0);
    expect(delay).toBeGreaterThanOrEqual(0);
  });

  it('aborts immediately when signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const fn = vi.fn();

    await expect(
      retryWithBackoff(fn, {
        attempts: 3,
        initialDelayMs: 10,
        maxDelayMs: 100,
        signal: ac.signal,
      }),
    ).rejects.toBeInstanceOf(RetryAbortedError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('aborts during backoff sleep', async () => {
    const ac = new AbortController();
    const fn = vi.fn().mockRejectedValue(new Error('boom'));

    const promise = retryWithBackoff(fn, {
      attempts: 5,
      initialDelayMs: 1_000,
      maxDelayMs: 10_000,
      signal: ac.signal,
    });
    // Wait one microtask for the first attempt to enter sleep.
    await new Promise<void>((r) => setImmediate(r));
    ac.abort();
    await expect(promise).rejects.toBeInstanceOf(RetryAbortedError);
  });

  it('throws when attempts < 1', async () => {
    await expect(
      retryWithBackoff(async () => 'never', {
        attempts: 0,
        initialDelayMs: 10,
        maxDelayMs: 100,
      }),
    ).rejects.toThrow(/attempts/);
  });
});

describe('computeDelayMs', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // jitter midpoint = 0
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('grows exponentially with backoffFactor', () => {
    const base = (i: number): number =>
      computeDelayMs({ attemptIndex: i, initialDelayMs: 100, maxDelayMs: 100_000, backoffFactor: 2 });
    expect(base(0)).toBe(100);
    expect(base(1)).toBe(200);
    expect(base(2)).toBe(400);
    expect(base(3)).toBe(800);
  });

  it('clamps to maxDelayMs', () => {
    const v = computeDelayMs({ attemptIndex: 10, initialDelayMs: 100, maxDelayMs: 1000, backoffFactor: 2 });
    expect(v).toBeLessThanOrEqual(1000);
  });
});
