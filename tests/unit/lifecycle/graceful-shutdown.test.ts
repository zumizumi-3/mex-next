/**
 * GracefulShutdown tests.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Logger } from 'pino';

import { GracefulShutdown } from '../../../src/lifecycle/graceful-shutdown.js';

/**
 * Tiny no-op logger that satisfies the pino `Logger` shape we touch
 * (info/warn/error). Avoids depending on pino's transport at test time.
 */
function silentLogger(): Logger {
  const noop = (): void => undefined;
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    silent: noop,
    child: () => silentLogger(),
  } as unknown as Logger;
}

describe('GracefulShutdown', () => {
  it('runs every registered task in LIFO order', async () => {
    const order: string[] = [];
    const sd = new GracefulShutdown({ logger: silentLogger() });
    sd.register({ name: 'a', run: async () => { order.push('a'); } });
    sd.register({ name: 'b', run: async () => { order.push('b'); } });
    sd.register({ name: 'c', run: async () => { order.push('c'); } });

    await sd.shutdown('SIGTERM');

    // LIFO: c (registered last) runs first.
    expect(order[0]).toBe('c');
    expect(order).toContain('a');
    expect(order).toContain('b');
    expect(order).toHaveLength(3);
  });

  it('continues even when a task throws', async () => {
    const sd = new GracefulShutdown({ logger: silentLogger() });
    const after = vi.fn().mockResolvedValue(undefined);
    sd.register({ name: 'will_fail', run: async () => { throw new Error('boom'); } });
    sd.register({ name: 'after', run: after });

    await sd.shutdown('SIGINT');
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('honors per-task timeout (stuck task does not block siblings)', async () => {
    const sd = new GracefulShutdown({ logger: silentLogger(), defaultTimeoutMs: 50 });
    const fast = vi.fn().mockResolvedValue(undefined);
    sd.register({
      name: 'slow',
      timeoutMs: 30,
      run: () => new Promise<void>(() => undefined), // never resolves
    });
    sd.register({ name: 'fast', run: fast });

    const start = Date.now();
    await sd.shutdown('SIGTERM');
    const elapsed = Date.now() - start;

    expect(fast).toHaveBeenCalledTimes(1);
    // Should resolve well within the slow task's would-be infinite wait.
    expect(elapsed).toBeLessThan(500);
  });

  it('is idempotent — concurrent shutdowns share one promise', async () => {
    const sd = new GracefulShutdown({ logger: silentLogger() });
    const run = vi.fn().mockResolvedValue(undefined);
    sd.register({ name: 'task', run });

    await Promise.all([
      sd.shutdown('SIGTERM'),
      sd.shutdown('SIGINT'),
      sd.shutdown('SIGTERM'),
    ]);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
