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
      // Auto-bootstrap: don't make the customer click "next wizard" — kick
      // off the first daily auto-post so they get an actionable draft card
      // immediately. The cron timer takes over for tomorrow's posts.
      let firstDraftLine = '';
      try {
        const outcome = await bootstrapFirstDraft(ctx);
        if (outcome.kind === 'awaiting_decision') {
          firstDraftLine =
            `\n📝 最初の投稿案も作りました (\`${outcome.sessionId}\`)。`
            + (outcome.threadId
              ? ` thread <#${outcome.threadId}> で承認 / 修正 / 見送りを選んでください。`
              : ' 同 channel に投稿候補を出しています。');
        } else if (outcome.kind === 'skip_active_session') {
          firstDraftLine = `\n📝 既に進行中の投稿セッションがあります (\`${outcome.sessionId}\`)。そちらの判断をお願いします。`;
        } else if (outcome.kind === 'skip_today') {
          firstDraftLine = '\n📝 今日は skip 設定なので、明日の朝に最初の投稿案を作ります。';
        } else {
          firstDraftLine = `\n⚠️ 最初の投稿案の生成でつまずきました: ${outcome.reason}`;
        }
      } catch (bootError) {
        const msg = bootError instanceof Error ? bootError.message : String(bootError);
        ctx.logger.warn?.({ error: msg }, 'first_auto_draft_failed');
        firstDraftLine = `\n⚠️ 最初の投稿案の生成に失敗: ${msg} (operator 通知済)`;
      }
      return [
        `✅ オンボーディング完了！ account.json を更新しました。`,
        `- account_id: \`${finalize.account.account_id}\``,
        `- display_name: ${finalize.account.display_name}`,
        '',
        '日次運用開始。明朝 07:00 JST から自動で投稿候補が作られます。',
        firstDraftLine,
      ].filter(Boolean).join('\n');
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

import { PostingStateMachine } from '../posting/state-machine.js';
import { ACTIVE_STATES } from '../posting/states.js';
import { asPostingMachineRepo } from './repo-adapter.js';
import { jstDateString } from '../utils/jst.js';
import { isSkipped } from '../settings/skip.js';
import type { LlmProvider as PostingLlmProvider } from '../posting/types.js';

type FirstDraftOutcome =
  | { kind: 'awaiting_decision'; sessionId: string; threadId?: string }
  | { kind: 'skip_today' }
  | { kind: 'skip_active_session'; sessionId: string }
  | { kind: 'fail'; reason: string };

function adaptBridgeForPosting(ctx: HandlerContext): PostingLlmProvider {
  return {
    async generate(opts) {
      const userPrompt = JSON.stringify(opts.payload);
      const response = await ctx.bridge.call({
        kind: opts.kind as never,
        userPrompt,
      });
      return { text: response.text, raw: response.raw };
    },
  };
}

/**
 * Run the same draft pipeline as cron-daily-auto-post but inline,
 * triggered immediately after onboarding finishes — so the customer
 * never has to "click next wizard".
 */
async function bootstrapFirstDraft(
  ctx: HandlerContext,
): Promise<FirstDraftOutcome> {
  const today = jstDateString(new Date());
  if (await isSkipped({ repo: asPostingMachineRepo(ctx.repo) as never, date: today })) {
    return { kind: 'skip_today' };
  }

  const state = await ctx.repo.loadState();
  const sessionsField = state.posting_sessions as unknown;
  const entries: Array<[string, { state?: string }]> = Array.isArray(sessionsField)
    ? sessionsField.map((s, i) => {
        const obj = s && typeof s === 'object' ? (s as { id?: string; state?: string }) : {};
        return [obj.id ?? String(i), obj];
      })
    : sessionsField && typeof sessionsField === 'object'
      ? Object.entries(sessionsField as Record<string, unknown>).map(([id, raw]) => [
          id,
          raw && typeof raw === 'object' ? (raw as { state?: string }) : {},
        ])
      : [];
  for (const [id, s] of entries) {
    if (typeof s.state === 'string' && (ACTIVE_STATES as ReadonlySet<string>).has(s.state)) {
      return { kind: 'skip_active_session', sessionId: id };
    }
  }

  const machine = new PostingStateMachine({
    repo: asPostingMachineRepo(ctx.repo),
    bridge: adaptBridgeForPosting(ctx),
    logger: ctx.logger,
  });

  let session;
  try {
    session = await machine.createSession(`onboard_bootstrap_${today}`);
    session = await machine.indexContext(session.id);
    session = await machine.generateCandidate(session.id);
    session = await machine.validateCurrent(session.id);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    ctx.logger.warn?.({ error: reason }, 'bootstrap_first_draft_pipeline_failed');
    return { kind: 'fail', reason };
  }
  if (session.state !== 'awaiting_decision') {
    return { kind: 'fail', reason: `unexpected state: ${session.state}` };
  }
  const candidate = session.candidates[session.currentCandidateIndex];
  if (!candidate) {
    return { kind: 'fail', reason: 'no candidate produced' };
  }

  // Post the draft card to customer_attention. The DiscordPoster from
  // ctx maps the role to whichever channel the operator wired in.
  try {
    const result = await ctx.discordPoster.postThread({
      channelRole: 'customer_attention',
      title: '✏️ 最初の投稿候補',
      content: [
        `**最初の投稿候補** (\`${session.id}\`)`,
        '',
        candidate.text,
        '',
        '_承認 / 修正 / 見送りを選んでください。これがあなたの初投稿になります。_',
      ].join('\n'),
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 3, label: '承認', custom_id: `posting:${session.id}:schedule` },
            { type: 2, style: 2, label: '修正', custom_id: `posting:${session.id}:revise` },
            { type: 2, style: 4, label: '見送り', custom_id: `posting:${session.id}:reject` },
          ],
        },
      ],
      silent: false,
      metadata: { sessionId: session.id, kind: 'onboarding_bootstrap' },
    });
    return { kind: 'awaiting_decision', sessionId: session.id, ...(result.threadId ? { threadId: result.threadId } : {}) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { kind: 'fail', reason };
  }
}
