/**
 * CircuitBreaker tests — fully synchronous (no fake timers needed)
 * because we inject `now()` for clock control.
 */

import { describe, it, expect } from 'vitest';

import { CircuitBreaker, CircuitOpenError } from '../../../src/utils/circuit-breaker.js';

describe('CircuitBreaker', () => {
  it('starts closed and lets calls through', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });
    const result = await breaker.execute(async () => 42);
    expect(result).toBe(42);
    expect(breaker.getState()).toBe('closed');
  });

  it('opens after failureThreshold consecutive failures', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });
    for (let i = 0; i < 3; i += 1) {
      await expect(breaker.execute(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    }
    expect(breaker.getState()).toBe('open');
    // While open, fn is never invoked.
    let called = false;
    await expect(
      breaker.execute(async () => {
        called = true;
        return 'never';
      }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(called).toBe(false);
  });

  it('transitions to half-open after resetTimeoutMs elapses', async () => {
    let now = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 100,
      now: () => now,
    });
    for (let i = 0; i < 2; i += 1) {
      await expect(breaker.execute(async () => { throw new Error('x'); })).rejects.toThrow();
    }
    expect(breaker.getState()).toBe('open');

    now = 200;
    expect(breaker.getState()).toBe('half-open');
  });

  it('half-open success closes the circuit', async () => {
    let now = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 10,
      now: () => now,
    });
    await expect(breaker.execute(async () => { throw new Error(); })).rejects.toThrow();
    now = 100;
    const value = await breaker.execute(async () => 'ok');
    expect(value).toBe('ok');
    expect(breaker.getState()).toBe('closed');
  });

  it('half-open failure re-opens the circuit', async () => {
    let now = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 10,
      now: () => now,
    });
    await expect(breaker.execute(async () => { throw new Error(); })).rejects.toThrow();
    now = 100;
    await expect(breaker.execute(async () => { throw new Error(); })).rejects.toThrow();
    expect(breaker.getState()).toBe('open');
  });

  it('reset() forces back to closed', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1_000 });
    await expect(breaker.execute(async () => { throw new Error(); })).rejects.toThrow();
    expect(breaker.getState()).toBe('open');
    breaker.reset();
    expect(breaker.getState()).toBe('closed');
  });

  it('rejects construction with invalid options', () => {
    expect(() => new CircuitBreaker({ failureThreshold: 0, resetTimeoutMs: 100 })).toThrow();
    expect(() => new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: -1 })).toThrow();
  });
});
