/**
 * Graceful shutdown coordinator.
 *
 * Why this exists:
 *   On SIGTERM / SIGINT we must NOT just exit — there are several
 *   resources that need ordered teardown so we don't lose data:
 *     - Discord client (close gateway, drain reply queue)
 *     - Collector intervals (clear timers so no new fetch starts)
 *     - JudgmentEventStream (flush pending JSONL appends)
 *     - PendingTurnStore / SessionStore (already on-disk via lock,
 *       but we run a final no-op flush for symmetry)
 *     - CircuitBreakers (reset so next start is clean)
 *
 * Each `register`-ed task runs in LIFO order (last registered = first
 * to shut down) — matches the stack-of-resources pattern, e.g.
 * "open Discord client" registers a task that closes the client; if
 * Discord depends on logger, logger is registered first and closed last.
 *
 * Each task is guarded by its own timeout. A slow task does NOT block
 * other tasks — they run in parallel, and the overall `shutdown` call
 * resolves when all tasks have either completed or hit timeout.
 *
 * Shutdown is idempotent — calling `shutdown` twice (once per signal,
 * say SIGTERM then SIGINT) only runs the tasks once.
 */

import type { Logger } from 'pino';

export interface ShutdownTask {
  name: string;
  /** Per-task timeout. Falls back to the constructor default. */
  timeoutMs?: number;
  run: () => Promise<void>;
}

export interface GracefulShutdownOptions {
  logger: Logger;
  /** Default per-task timeout (ms). Default 5000. */
  defaultTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export class GracefulShutdown {
  private readonly logger: Logger;
  private readonly defaultTimeoutMs: number;
  private readonly tasks: ShutdownTask[] = [];
  private inProgress: Promise<void> | null = null;

  constructor(opts: GracefulShutdownOptions) {
    this.logger = opts.logger;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Register a teardown task. Tasks run in LIFO order on shutdown. */
  register(task: ShutdownTask): void {
    this.tasks.push(task);
  }

  /**
   * Trigger shutdown. Idempotent — concurrent / repeated calls return
   * the same in-flight promise.
   */
  async shutdown(signal: string): Promise<void> {
    if (this.inProgress) {
      this.logger.info({ signal }, 'shutdown_already_in_progress');
      return this.inProgress;
    }
    this.inProgress = this.doShutdown(signal);
    return this.inProgress;
  }

  private async doShutdown(signal: string): Promise<void> {
    this.logger.info({ signal, taskCount: this.tasks.length }, 'shutdown_started');
    // LIFO: last registered = first torn down.
    const ordered = [...this.tasks].reverse();
    const settle = await Promise.all(
      ordered.map((task) => this.runOne(task)),
    );
    const failed = settle.filter((s) => s.status === 'failed').length;
    const timed = settle.filter((s) => s.status === 'timeout').length;
    this.logger.info(
      { signal, ok: settle.length - failed - timed, failed, timed },
      'shutdown_complete',
    );
  }

  private async runOne(task: ShutdownTask): Promise<{ status: 'ok' | 'failed' | 'timeout' }> {
    const timeoutMs = task.timeoutMs ?? this.defaultTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    try {
      const outcome = await Promise.race([
        task.run().then(() => 'ok' as const),
        timeout,
      ]);
      if (outcome === 'timeout') {
        this.logger.warn({ task: task.name, timeoutMs }, 'shutdown_task_timeout');
        return { status: 'timeout' };
      }
      this.logger.info({ task: task.name }, 'shutdown_task_done');
      return { status: 'ok' };
    } catch (error) {
      this.logger.error(
        {
          task: task.name,
          error: error instanceof Error ? error.message : String(error),
        },
        'shutdown_task_failed',
      );
      return { status: 'failed' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * Wire `SIGTERM` / `SIGINT` to a `GracefulShutdown` instance.
 *
 * Returns a disposer that removes the signal handlers — useful for
 * tests that want to assert handlers don't leak across `it` blocks.
 *
 * The `onComplete` callback fires after the shutdown promise resolves.
 * Typical use: call `process.exit(0)` once shutdown is done.
 */
export function bindShutdownSignals(opts: {
  shutdown: GracefulShutdown;
  signals?: NodeJS.Signals[];
  onComplete?: (signal: string) => void;
}): () => void {
  const signals: NodeJS.Signals[] = opts.signals ?? ['SIGTERM', 'SIGINT'];
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const sig of signals) {
    const handler = (): void => {
      void opts.shutdown.shutdown(sig).then(() => {
        opts.onComplete?.(sig);
      });
    };
    handlers.set(sig, handler);
    process.on(sig, handler);
  }
  return () => {
    for (const [sig, handler] of handlers.entries()) {
      process.off(sig, handler);
    }
  };
}
