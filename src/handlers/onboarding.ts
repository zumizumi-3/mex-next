/**
 * Onboarding intent / slash handlers.
 *
 * Wraps `OnboardingCollector` so the conversation runner and the slash
 * dispatcher can call the same entry points:
 *
 *   - handleOnboardStart  — start (or resume) a customer onboarding wizard
 *   - handleOnboardStatus — show the current question / progress
 *   - handleOnboardCancel — abort the active session
 *
 * The runner injects an `OnboardingCollector` factory via `args` so this
 * handler stays composable with existing `HandlerContext` (which doesn't
 * own a collector — sessions are state-resident).
 */

import type { HandlerArgs, HandlerContext, HandlerResult } from './types.js';
import {
  OnboardingCollector,
  ONBOARDING_QUESTION_COUNT,
  questionIndexFor,
  renderQuestion,
  type OnboardingSession,
} from '../onboarding/collector.js';
import {
  ONBOARDING_QUESTIONS,
  findQuestionById,
} from '../onboarding/questions.js';

/** Build a collector tied to the handler context. */
export function buildCollectorFromContext(
  ctx: HandlerContext,
): OnboardingCollector {
  return new OnboardingCollector({
    repo: ctx.repo,
    bridge: ctx.bridge,
    logger: ctx.logger,
  });
}

export async function handleOnboardStart(
  ctx: HandlerContext,
  args: HandlerArgs,
): Promise<HandlerResult> {
  const collector = buildCollectorFromContext(ctx);
  const threadId = typeof args.threadId === 'string' ? args.threadId : null;
  const channelId = typeof args.channelId === 'string' ? args.channelId : null;
  const session = await collector.start({ threadId, channelId });
  const question = findQuestionById(session.currentQuestionId);
  if (!question) {
    return {
      content:
        'オンボーディングは既に完了しています。もう一度やり直したい場合は operator に「再オンボード」とお伝えください。',
      tag: 'onboard.start.completed',
    };
  }
  const idx = questionIndexFor(question.id);
  const lines = [
    `🟢 オンボーディングを開始しました (${ONBOARDING_QUESTION_COUNT} 問 / セッション \`${session.id}\`)`,
    '',
    renderQuestion(question, Math.max(0, idx)),
    '',
    '_この thread にそのまま自然文で返してください。途中でやめたい時は「やめる」と書いてください。_',
  ];
  return { content: lines.join('\n'), tag: 'onboard.start' };
}

export async function handleOnboardStatus(
  ctx: HandlerContext,
  _args: HandlerArgs,
): Promise<HandlerResult> {
  const collector = buildCollectorFromContext(ctx);
  const session = await collector.getActive();
  if (!session) {
    return {
      content:
        'いまオンボーディング中ではありません。`/mex onboard start` で始められます。',
      tag: 'onboard.status.idle',
    };
  }
  const answered = Object.keys(session.answers).length;
  const remaining = ONBOARDING_QUESTION_COUNT - answered;
  const current = findQuestionById(session.currentQuestionId);
  const lines = [
    `🟢 オンボーディング進行中 (\`${session.id}\`)`,
    `- 回答済: ${answered}/${ONBOARDING_QUESTION_COUNT}`,
    `- 残り: ${remaining}`,
    `- TTL: ${session.expiresAt}`,
  ];
  if (current) {
    const idx = questionIndexFor(current.id);
    lines.push('');
    lines.push('現在の質問:');
    lines.push(renderQuestion(current, Math.max(0, idx)));
  }
  return { content: lines.join('\n'), tag: 'onboard.status' };
}

export async function handleOnboardCancel(
  ctx: HandlerContext,
  _args: HandlerArgs,
): Promise<HandlerResult> {
  const collector = buildCollectorFromContext(ctx);
  const session = await collector.getActive();
  if (!session) {
    return {
      content: '取り消すオンボーディングはありません。',
      tag: 'onboard.cancel.noop',
    };
  }
  await collector.cancel(session.id);
  return {
    content: `🛑 オンボーディング (\`${session.id}\`) を中断しました。やり直したい時は「最初から」と話しかけてください。`,
    tag: 'onboard.cancel',
  };
}

/**
 * Helper used by the message-handler when an active onboarding session
 * exists: routes the customer's free-form text directly to
 * answerCurrent, bypassing intent classification.
 *
 * Returns the formatted response text (next question or completion
 * notice). Caller is responsible for sending it.
 */
export async function applyFreeFormAnswer(
  ctx: HandlerContext,
  session: OnboardingSession,
  rawText: string,
): Promise<string> {
  const collector = buildCollectorFromContext(ctx);
  const trimmed = rawText.trim();
  if (
    trimmed === 'やめる' ||
    trimmed.toLowerCase() === 'cancel' ||
    trimmed === '中止'
  ) {
    await collector.cancel(session.id);
    return `🛑 オンボーディング (\`${session.id}\`) を中断しました。`;
  }
  const skipping = trimmed === 'skip' || trimmed === 'スキップ' || trimmed === '飛ばす';
  let answer: unknown = trimmed;
  if (skipping) {
    const cur = findQuestionById(session.currentQuestionId);
    if (cur && !cur.required) {
      answer = '';
    } else {
      return '⚠️ この質問は必須なのでスキップできません。回答を入力してください。';
    }
  }
  const updated = await collector.answerCurrent(session.id, answer);
  if (updated.state === 'completed') {
    try {
      const finalize = await collector.finalize(updated.id);
      return [
        `✅ オンボーディング完了！ account.json を更新しました。`,
        `- account_id: \`${finalize.account.account_id}\``,
        `- display_name: ${finalize.account.display_name}`,
        '',
        '次に進みたければ「初期運用設計を始めて」と話しかけてください (first-window 5 問)。',
      ].join('\n');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `⚠️ 全質問の回答は保存しましたが、account.json への反映でエラー: ${message}`;
    }
  }
  if (updated.state === 'expired') {
    return '⌛ セッションが期限切れになりました。もう一度「最初から」と話しかけて再開してください。';
  }
  const nextQ = findQuestionById(updated.currentQuestionId);
  if (!nextQ) {
    return '⚠️ 次の質問が見つかりませんでした。operator に連絡してください。';
  }
  const idx = questionIndexFor(nextQ.id);
  return renderQuestion(nextQ, Math.max(0, idx));
}

/** Re-export for handler registry consumers. */
export { ONBOARDING_QUESTIONS };
