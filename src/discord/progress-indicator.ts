/**
 * In-place progress message indicator.
 *
 * Ported (and slimmed) from wah-office-v2 `discord-status.js`.
 *
 * Lifecycle:
 *   start()      — sends `⏳ 処理中…`
 *   updateStatus — edits to show fine-grained status (optional)
 *   done()       — edits to `✅ 完了`
 *   failed()     — edits to `❌ 失敗`
 *   cancelled()  — edits to `🛑 中断`
 *
 * The intent is to occupy a single Discord message slot so the
 * channel doesn't fill up with noise. If the initial send fails
 * we degrade silently — progress is informational only.
 */

import type { Logger } from 'pino';
import { DISCORD_MESSAGE_SOFT_LIMIT, PROGRESS_TEMPLATES, truncateForDiscord } from './templates.js';

/**
 * Minimal contract we need from a Discord message we sent.
 * We model it as an interface so unit tests can substitute mocks
 * without depending on the heavy discord.js Message class.
 */
export interface EditableMessage {
  edit(
    content: string | { content: string; components?: ReadonlyArray<unknown> },
  ): Promise<unknown>;
}

/**
 * Minimal contract for the channel we send to.
 * Matches the shape of `TextBasedChannel.send` in discord.js.
 */
export interface ProgressChannel {
  send(content: string): Promise<EditableMessage>;
}

export type ProgressState = 'idle' | 'running' | 'done' | 'failed' | 'cancelled';

export interface ProgressIndicator {
  start(initialStatus?: string): Promise<void>;
  updateStatus(status: string): Promise<void>;
  done(finalText?: string, options?: { components?: ReadonlyArray<unknown> }): Promise<void>;
  failed(finalText?: string): Promise<void>;
  cancelled(finalText?: string): Promise<void>;
  /** Current state — useful for tests and for handlers that need to skip. */
  readonly state: ProgressState;
}

export interface CreateProgressIndicatorOptions {
  readonly channel: ProgressChannel;
  readonly logger?: Logger;
  /** When set, status updates always show the prefix (e.g. "[Posting v2]"). */
  readonly prefix?: string;
}

/**
 * Create a progress indicator bound to `channel`.
 *
 * The first call to `start()` sends the placeholder message; later
 * calls edit it. If `start()` fails (network blip, missing perms),
 * subsequent updates and `done()` calls become no-ops — we never
 * throw from progress reporting because it's not critical.
 */
export function createProgressIndicator(
  options: CreateProgressIndicatorOptions,
): ProgressIndicator {
  const log = options.logger?.child({ subsystem: 'progress-indicator' });
  const prefix = options.prefix ? `${options.prefix} ` : '';

  let message: EditableMessage | null = null;
  let currentStatus = '';
  let state: ProgressState = 'idle';

  const renderRunning = (status: string): string => {
    const trimmed = status.trim();
    if (!trimmed) {
      return `${prefix}${PROGRESS_TEMPLATES.starting}`;
    }
    return `${prefix}⏳ ${trimmed}`;
  };

  const safeEdit = async (
    content: string,
    options?: { components?: ReadonlyArray<unknown> },
  ): Promise<void> => {
    if (!message) {
      return;
    }
    try {
      const truncated = truncateForDiscord(content, DISCORD_MESSAGE_SOFT_LIMIT);
      if (options?.components) {
        await message.edit({ content: truncated, components: options.components });
      } else {
        await message.edit(truncated);
      }
    } catch (error) {
      log?.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'progress_edit_failed',
      );
    }
  };

  return {
    get state() {
      return state;
    },

    async start(initialStatus = ''): Promise<void> {
      if (state !== 'idle') {
        return;
      }
      currentStatus = initialStatus.trim();
      state = 'running';
      const content = renderRunning(currentStatus);
      try {
        message = await options.channel.send(content);
      } catch (error) {
        log?.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'progress_send_failed',
        );
        message = null;
      }
    },

    async updateStatus(status: string): Promise<void> {
      if (state !== 'running') {
        return;
      }
      const normalized = status.trim();
      if (!normalized || normalized === currentStatus) {
        return;
      }
      currentStatus = normalized;
      await safeEdit(renderRunning(currentStatus));
    },

    async done(
      finalText?: string,
      options?: { components?: ReadonlyArray<unknown> },
    ): Promise<void> {
      if (state === 'done' || state === 'failed' || state === 'cancelled') {
        return;
      }
      state = 'done';
      const text = finalText?.trim() || PROGRESS_TEMPLATES.done;
      await safeEdit(`${prefix}${text}`, options);
    },

    async failed(finalText?: string): Promise<void> {
      if (state === 'done' || state === 'failed' || state === 'cancelled') {
        return;
      }
      state = 'failed';
      const text = finalText?.trim() || PROGRESS_TEMPLATES.failed;
      await safeEdit(`${prefix}${text}`);
    },

    async cancelled(finalText?: string): Promise<void> {
      if (state === 'done' || state === 'failed' || state === 'cancelled') {
        return;
      }
      state = 'cancelled';
      const text = finalText?.trim() || PROGRESS_TEMPLATES.cancelled;
      await safeEdit(`${prefix}${text}`);
    },
  };
}
