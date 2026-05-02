/**
 * Shared message templates and constants for Discord output.
 *
 * The goal is consistency — same emoji for the same state, same
 * JST formatting, same button styles — across all features that
 * emit Discord messages.
 *
 * MeX writes ~50 different messages and they all flow through here
 * so that "ok" / "warn" / "error" indicators stay aligned with
 * customer expectations.
 */

import { ButtonStyle } from 'discord.js';

/** State emoji — single source of truth. */
export const STATE_EMOJI = {
  /** "I see your message; starting work" — typing indicator companion. */
  ack: '👀',
  /** Work in progress — used by the progress indicator. */
  busy: '⏳',
  /** Successful completion. */
  ok: '✅',
  /** Failure — recoverable, customer can retry. */
  error: '❌',
  /** User-cancelled or operator-overridden. */
  cancelled: '🛑',
  /** Approval / authorization required. */
  approval: '🔐',
  /** Important — please look. */
  attention: '⚠️',
  /** "Listening" reaction for confirmation. */
  confirmYes: '✅',
  /** "Cancel" reaction for confirmation. */
  confirmNo: '❌',
} as const;

export const PROGRESS_TEMPLATES = {
  /** First placeholder shown when the bot starts processing. */
  starting: `${STATE_EMOJI.busy} 処理中…`,
  /** Final state when work succeeds. */
  done: `${STATE_EMOJI.ok} 完了`,
  /** Final state when work fails. */
  failed: `${STATE_EMOJI.error} 失敗`,
  /** Final state when work is cancelled. */
  cancelled: `${STATE_EMOJI.cancelled} 中断`,
} as const;

export const BUSY_REPLY_TEMPLATE = `${STATE_EMOJI.busy} 前の処理がまだ動いています。終わるのを待ちます。`;

/** Standard button labels and styles, kept consistent across modules. */
export const BUTTON_LABELS = {
  approve: '✅ 承認',
  deny: '❌ 拒否',
  yes: 'はい',
  no: 'いいえ',
  apply: '適用',
  rollback: 'ロールバック',
  skip: 'スキップ',
  publishNow: 'いますぐ投稿',
  cancel: 'キャンセル',
} as const;

export const BUTTON_STYLES = {
  approve: ButtonStyle.Success,
  deny: ButtonStyle.Danger,
  yes: ButtonStyle.Primary,
  no: ButtonStyle.Secondary,
  apply: ButtonStyle.Success,
  rollback: ButtonStyle.Secondary,
  skip: ButtonStyle.Secondary,
  publishNow: ButtonStyle.Primary,
  cancel: ButtonStyle.Danger,
} as const;

/** JST formatter — used for any timestamp shown to customers. */
const JST_FORMATTER = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

/** Format `value` (Date | epoch ms | ISO string) as `YYYY/MM/DD HH:MM` JST. */
export function formatJst(value: Date | number | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '(invalid date)';
  }
  return JST_FORMATTER.format(date);
}

/** "5 分", "1 時間 20 分", "30 秒" — for elapsed time displays. */
export function formatDurationJa(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return minutes > 0 ? `${hours}時間${minutes}分` : `${hours}時間`;
  }
  if (minutes === 0) {
    return `${seconds}秒`;
  }
  if (seconds === 0) {
    return `${minutes}分`;
  }
  return `${minutes}分${seconds}秒`;
}

/** Custom-id namespace prefixes used across button/modal flows. */
export const CUSTOM_ID_PREFIXES = {
  approval: 'mex.approval',
  confirm: 'mex.confirm',
  intent: 'mex.intent',
  schedule: 'mex.schedule',
  retro: 'mex.retro',
  inbound: 'mex.inbound',
} as const;

/** Discord 2000-char hard limit for a single message. */
export const DISCORD_MESSAGE_MAX_CHARS = 2000;

/** Soft limit we target so that emoji / mentions don't push us over. */
export const DISCORD_MESSAGE_SOFT_LIMIT = 1900;
