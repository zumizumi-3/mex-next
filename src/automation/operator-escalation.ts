/**
 * Operator escalation pipeline.
 *
 * Discord poster (WO-FRESH-9) を経由して operator alert channel に投稿する。
 * 同 reason の連投を 10 分 window で dedup し、ノイズを抑える。
 *
 * 機能:
 *   - operator role mention (`<@id>`) を本文先頭に入れる
 *   - silent=false で通常 notification (operator は気付かないと困る)
 *   - dedup は `escalation-state.ts` の `shouldEscalate` に委譲
 *
 * Python 版の `runtime/scripts/operator_escalation.py` を TS に移植したもの。
 */

import type { AppConfig } from '../config.js';
import type { AccountRepo } from '../account-state/repo.js';
import type {
  DiscordPoster,
  DiscordPostThreadResult,
} from '../posting/collectors/types.js';
import { shouldEscalate } from './escalation-state.js';

export interface EscalateOpts {
  /** 短い理由 (dedup key にも使う)。 */
  readonly reason: string;
  /** 詳細 (stack trace など、operator only)。 */
  readonly detail?: string;
  /** 復旧ヒント。 */
  readonly hint?: string;
  /** Account ID — body に含めて identify しやすくする。 */
  readonly accountId: string;
  readonly poster: DiscordPoster;
  readonly config: AppConfig;
  readonly repo: AccountRepo;
  /** Override dedup window (default 10 minutes). */
  readonly windowMinutes?: number;
  /** Inject "now" for tests. */
  readonly now?: () => Date;
}

export interface EscalateResult {
  readonly emitted: boolean;
  readonly skipped: boolean;
  readonly failCount: number;
  readonly threadId?: string;
  readonly messageId?: string;
}

const ESCALATION_TITLE_PREFIX = '[FAIL] operator escalation';

/**
 * operator alert channel に escalation message を 1 回投稿する。
 *
 * 戻り値の `emitted=false` は dedup により skip された (前回投稿から 10 分
 * 以内) ことを意味する。`failCount` は同じ reason がカウントされた数 —
 * 5 件以上溜まると body に "繰り返し" と表示する。
 */
export async function escalateOperator(opts: EscalateOpts): Promise<EscalateResult> {
  const { shouldEmit, failCount } = await shouldEscalate({
    repo: opts.repo,
    reason: opts.reason,
    windowMinutes: opts.windowMinutes,
    now: opts.now,
  });

  if (!shouldEmit) {
    return { emitted: false, skipped: true, failCount };
  }

  const content = buildContent({
    reason: opts.reason,
    detail: opts.detail,
    hint: opts.hint,
    accountId: opts.accountId,
    failCount,
    operatorMention: pickMention(opts.config.operatorDiscordUserIds),
  });

  let result: DiscordPostThreadResult;
  try {
    result = await opts.poster.postEscalation({
      channelRole: 'operator',
      content,
      metadata: {
        reason: opts.reason,
        accountId: opts.accountId,
        failCount,
      },
    });
  } catch (err) {
    // Poster 失敗時は dedup state を残しつつ呼出元に再 throw する。
    // (上位 caller は logger に流す責務)
    throw new EscalateDeliveryError(opts.reason, err);
  }

  return {
    emitted: true,
    skipped: false,
    failCount,
    threadId: result.threadId,
    messageId: result.messageId,
  };
}

interface BuildContentInput {
  readonly reason: string;
  readonly detail?: string;
  readonly hint?: string;
  readonly accountId: string;
  readonly failCount: number;
  readonly operatorMention: string;
}

function buildContent(input: BuildContentInput): string {
  const lines: string[] = [];
  const headerSuffix = input.failCount > 1 ? ` (x${input.failCount})` : '';
  if (input.operatorMention) {
    lines.push(`${input.operatorMention} ${ESCALATION_TITLE_PREFIX}${headerSuffix}`);
  } else {
    lines.push(
      `${ESCALATION_TITLE_PREFIX}${headerSuffix} (operator_discord_id 未設定 — mention skipped)`,
    );
  }
  lines.push(`account: ${input.accountId}`);
  lines.push(`reason: ${truncate(input.reason, 400)}`);
  if (input.hint && input.hint.trim().length > 0) {
    lines.push(`hint: ${truncate(input.hint, 400)}`);
  }
  if (input.detail && input.detail.trim().length > 0) {
    lines.push('');
    lines.push('detail:');
    lines.push('```');
    lines.push(truncate(input.detail, 1500));
    lines.push('```');
  }
  return lines.join('\n');
}

function pickMention(operatorIds: readonly string[]): string {
  const first = operatorIds[0]?.trim();
  if (!first) return '';
  return `<@${first}>`;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit - 1).trimEnd() + '…';
}

export class EscalateDeliveryError extends Error {
  readonly reason: string;
  readonly cause: unknown;

  constructor(reason: string, cause: unknown) {
    super(`failed to deliver operator escalation for "${reason}"`);
    this.name = 'EscalateDeliveryError';
    this.reason = reason;
    this.cause = cause;
  }
}
