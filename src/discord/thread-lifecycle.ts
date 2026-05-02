/**
 * Thread lifecycle handlers.
 *
 * Combines wah-office-v2 `discord-thread-lifecycle.js` and
 * `discord/auto-unarchive.js` into one module since their concerns
 * overlap: keeping the bot present in customer threads.
 *
 * - {@link ensureThreadJoined}: idempotently join a thread.
 * - {@link handleThreadCreate}: when a new thread is created in a
 *   channel we care about, join it.
 * - {@link handleThreadUpdate}: rejoin if needed; if the thread was
 *   archived/locked, close the corresponding session in our store.
 * - {@link handleThreadDelete}: drop the session.
 * - {@link createAutoUnarchiveManager}: when the user posts in an
 *   archived thread, auto-unarchive (rate-limited to avoid abuse).
 */

import type { Logger } from 'pino';
import type { SessionStore } from '../conversation/session-store.js';

/** Minimal thread shape — matches discord.js `ThreadChannel`. */
export interface ThreadLike {
  readonly id: string;
  readonly parentId?: string | null;
  readonly archived?: boolean;
  readonly locked?: boolean;
  readonly joinable?: boolean;
  readonly joined?: boolean;
  readonly archiveTimestamp?: number | null;
  readonly threadMetadata?: { archiveTimestamp?: number | null } | null;
  join(): Promise<unknown>;
  setArchived(archived: boolean): Promise<unknown>;
}

/** Idempotent: join a thread if we aren't in it already. */
export async function ensureThreadJoined(
  thread: ThreadLike,
  logger?: Logger,
): Promise<boolean> {
  if (!thread.joinable || thread.joined) {
    return false;
  }
  try {
    await thread.join();
    logger?.info(
      { threadId: thread.id, parentId: thread.parentId ?? null },
      'thread_joined',
    );
    return true;
  } catch (error) {
    logger?.warn(
      { threadId: thread.id, error: errMsg(error) },
      'thread_join_failed',
    );
    return false;
  }
}

export interface ThreadLifecycleDeps {
  readonly sessionStore: SessionStore;
  readonly logger?: Logger;
}

export async function handleThreadCreate(
  thread: ThreadLike,
  deps: ThreadLifecycleDeps,
): Promise<void> {
  await ensureThreadJoined(thread, deps.logger);
}

export async function handleThreadUpdate(
  thread: ThreadLike,
  deps: ThreadLifecycleDeps,
): Promise<void> {
  if (thread.archived === true || thread.locked === true) {
    closeSessionFor(thread, deps, thread.archived === true ? 'archived' : 'locked');
    return;
  }
  await ensureThreadJoined(thread, deps.logger);
}

export function handleThreadDelete(
  thread: ThreadLike,
  deps: ThreadLifecycleDeps,
): void {
  closeSessionFor(thread, deps, 'deleted');
}

function closeSessionFor(
  thread: ThreadLike,
  deps: ThreadLifecycleDeps,
  reason: string,
): void {
  if (!thread.id) {
    return;
  }
  const existing = deps.sessionStore.getSession(thread.id);
  if (!existing) {
    return;
  }
  deps.sessionStore.closeSession(thread.id, {
    closedBy: 'discord-thread-lifecycle',
    reason,
  });
  deps.logger?.info(
    {
      threadId: thread.id,
      parentId: thread.parentId ?? null,
      reason,
    },
    'thread_session_closed',
  );
}

// ---------- Auto-unarchive ----------

const AUTO_UNARCHIVE_RATE_LIMIT_MS = 10_000;
const AUTO_UNARCHIVE_ELIGIBLE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface AutoUnarchiveManager {
  /** Returns true if the thread was successfully unarchived just now. */
  maybeAutoUnarchive(input: { thread: ThreadLike }): Promise<boolean>;
}

export interface CreateAutoUnarchiveOptions {
  readonly now?: () => number;
  readonly setTimeoutImpl?: typeof setTimeout;
  readonly rateLimitMs?: number;
  readonly eligibleWindowMs?: number;
  readonly logger?: Logger;
}

/**
 * Create a per-bucket-rate-limited auto-unarchive manager.
 *
 * Bucket = parent channel id (or thread id if no parent). One
 * unarchive per bucket per `rateLimitMs`. Threads archived more
 * than `eligibleWindowMs` ago are skipped (Discord refuses old
 * unarchives anyway).
 */
export function createAutoUnarchiveManager(
  options: CreateAutoUnarchiveOptions = {},
): AutoUnarchiveManager {
  const now = options.now ?? (() => Date.now());
  const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
  const rateLimitMs = options.rateLimitMs ?? AUTO_UNARCHIVE_RATE_LIMIT_MS;
  const eligibleWindowMs = options.eligibleWindowMs ?? AUTO_UNARCHIVE_ELIGIBLE_WINDOW_MS;
  const logger = options.logger?.child({ subsystem: 'auto-unarchive' });
  const nextAvailableAt = new Map<string, number>();

  return {
    async maybeAutoUnarchive({ thread }) {
      if (!thread?.archived) {
        return false;
      }
      const archivedAt = resolveArchiveTimestamp(thread);
      const currentTime = Number(now());
      if (archivedAt === null || currentTime - archivedAt > eligibleWindowMs) {
        return false;
      }
      const bucketKey = String(thread.parentId ?? thread.id ?? '').trim();
      if (!bucketKey) {
        return false;
      }
      const earliest = nextAvailableAt.get(bucketKey) ?? currentTime;
      const delay = Math.max(0, earliest - currentTime);
      nextAvailableAt.set(bucketKey, Math.max(currentTime, earliest) + rateLimitMs);

      if (delay > 0) {
        await new Promise<void>((resolve) => {
          setTimeoutImpl(resolve, delay);
        });
      }
      try {
        await thread.setArchived(false);
        logger?.info({ threadId: thread.id, parentId: thread.parentId ?? null }, 'thread_unarchived');
        return true;
      } catch (error) {
        if (isPermissionError(error)) {
          logger?.warn({ threadId: thread.id }, 'thread_unarchive_permission_denied');
          return false;
        }
        logger?.warn(
          { threadId: thread.id, error: errMsg(error) },
          'thread_unarchive_failed',
        );
        return false;
      }
    },
  };
}

function resolveArchiveTimestamp(thread: ThreadLike): number | null {
  const raw = thread.archiveTimestamp ?? thread.threadMetadata?.archiveTimestamp ?? null;
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? parsed : null;
}

function isPermissionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const e = error as { code?: number; message?: string };
  if (e.code === 50013) {
    return true;
  }
  return /Missing Permissions/i.test(String(e.message ?? ''));
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
