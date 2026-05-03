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
  pendingReviewForQuestion,
  questionIndexFor,
  renderQuestion,
  type OnboardingSession,
  type ResolvedQuestion,
} from '../onboarding/collector.js';
import {
  ONBOARDING_QUESTIONS,
  findQuestionById,
  resolveChoiceKey,
  type OnboardingQuestion,
} from '../onboarding/questions.js';
import { startPhaseQuestionnaire } from '../phase-questionnaire/runner.js';
import { STATE_EMOJI } from '../discord/templates.js';
import type { LlmProvider } from '../llm/bridge.js';

/** Build a collector tied to the handler context. */
export function buildCollectorFromContext(ctx: HandlerContext): OnboardingCollector {
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
    renderOnboardingPrompt(session, question, Math.max(0, idx)),
    '',
    '_この thread にそのまま自然文で返してください。途中でやめたい時は「やめる」と書いてください。_',
  ];
  // review 質問なら「維持 / 変更する / やめる」、通常質問なら「やめる」のみ。
  const components = pendingReviewForQuestion(session, question.id)
    ? onboardingReviewComponents(session.id)
    : onboardingCancelComponents(session.id);
  return {
    content: lines.join('\n'),
    components,
    tag: 'onboard.start',
  };
}

export async function handleOnboardStatus(
  ctx: HandlerContext,
  _args: HandlerArgs,
): Promise<HandlerResult> {
  const collector = buildCollectorFromContext(ctx);
  const session = await collector.getActive();
  if (!session) {
    return {
      content: 'いまオンボーディング中ではありません。`/mex onboard start` で始められます。',
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
    lines.push(renderOnboardingPrompt(session, current, Math.max(0, idx)));
  }
  return {
    content: lines.join('\n'),
    ...(current ? { components: onboardingPromptComponents(session, current) } : {}),
    tag: 'onboard.status',
  };
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
    content: `${STATE_EMOJI.cancelled} オンボーディング (\`${session.id}\`) を中断しました。やり直したい時は「最初から」と話しかけてください。`,
    tag: 'onboard.cancel',
  };
}

/**
 * Helper used by the message-handler when an active onboarding session
 * exists: routes the customer's free-form text directly to
 * answerCurrent, bypassing intent classification.
 *
 * Returns the formatted response and optional components (next question
 * or completion notice). Caller is responsible for sending it.
 */
export async function applyFreeFormAnswer(
  ctx: HandlerContext,
  session: OnboardingSession,
  rawText: string,
): Promise<HandlerResult> {
  const collector = buildCollectorFromContext(ctx);
  const fresh = await collector.getSession(session.id);
  if (!fresh) {
    return {
      content: `${STATE_EMOJI.attention} オンボーディングセッションが見つかりませんでした。もう一度「最初から」と話しかけてください。`,
      tag: 'onboard.answer.missing_session',
    };
  }
  const currentSession = fresh;
  ctx.logger.info(
    {
      session_id: currentSession.id,
      current_question_id: currentSession.currentQuestionId,
      pending_review_ids: currentSession.pending_review_questions.map((q) => q.id),
    },
    'onboarding_free_form_answer_received',
  );
  const trimmed = rawText.trim();
  if (trimmed === 'やめる' || trimmed.toLowerCase() === 'cancel' || trimmed === '中止') {
    await collector.cancel(currentSession.id);
    return {
      content: `${STATE_EMOJI.cancelled} オンボーディング (\`${currentSession.id}\`) を中断しました。`,
      tag: 'onboard.answer.cancel',
    };
  }
  const currentReview = pendingReviewForQuestion(currentSession, currentSession.currentQuestionId);
  if (currentReview) {
    assertReviewQuestionId(currentReview, currentSession.currentQuestionId);
    const verdict = await classifyReviewDecision(ctx.bridge, {
      questionId: currentReview.id,
      question: currentReview.question.question,
      review: currentReview,
      savedValueText: currentReview.savedValueText,
      reply: trimmed,
    });
    if (verdict?.action === 'keep') {
      const updated = await collector.keepCurrentReviewAnswer(currentSession.id);
      return renderUpdatedOnboardingSession(ctx, collector, updated);
    }
    if (verdict?.action === 'change') {
      const updated = await collector.changeCurrentReviewAnswer(currentSession.id);
      const question = findQuestionById(updated.currentQuestionId);
      if (!question) {
        return {
          content: '⚠️ 次の質問が見つかりませんでした。operator に連絡してください。',
          tag: 'onboard.answer.missing_question',
        };
      }
      const idx = questionIndexFor(question.id);
      return {
        content: renderQuestion(question, Math.max(0, idx)),
        components: onboardingCancelComponents(updated.id),
        tag: 'onboard.answer.change',
      };
    }
    if (verdict?.action === 'answer') {
      const updated = await collector.changeCurrentReviewAnswer(currentSession.id);
      const answered = await collector.answerCurrent(updated.id, verdict.answer);
      return renderUpdatedOnboardingSession(ctx, collector, answered);
    }
    return {
      content: [
        `${STATE_EMOJI.attention} 既存回答を維持するか変更するかを判断できませんでした。`,
        '「維持」または「変更する」と返してください。',
        '',
        renderReviewQuestion(currentReview, questionIndexFor(currentReview.id)),
      ].join('\n'),
      components: onboardingReviewComponents(currentSession.id),
      tag: 'onboard.answer.review_ambiguous',
    };
  }
  const skipping = trimmed === 'skip' || trimmed === 'スキップ' || trimmed === '飛ばす';
  let answer: unknown = trimmed;
  if (skipping) {
    const cur = findQuestionById(currentSession.currentQuestionId);
    if (cur && !cur.required) {
      answer = '';
    } else {
      return {
        content: `${STATE_EMOJI.attention} この質問は必須なのでスキップできません。回答を入力してください。`,
        components: onboardingCancelComponents(currentSession.id),
        tag: 'onboard.answer.skip_required',
      };
    }
  }
  const updated = await collector.answerCurrent(currentSession.id, answer);
  return renderUpdatedOnboardingSession(ctx, collector, updated);
}

export async function renderUpdatedOnboardingSession(
  ctx: HandlerContext,
  collector: Pick<OnboardingCollector, 'finalize'>,
  updated: OnboardingSession,
): Promise<HandlerResult> {
  if (updated.state === 'completed') {
    try {
      const finalize = await collector.finalize(updated.id);
      const phase = await startOnboardingPhaseBridge(ctx);
      // Auto-bootstrap as a fire-and-forget background task:
      // indexContext + generateCandidate + 5-axis judge can take 30+
      // seconds. Don't make the customer wait at the end of the wizard.
      // The background task posts its own thread when ready, or escalates
      // to the operator on failure.
      void runBootstrapFirstDraftInBackground(ctx);
      return {
        content: [
          `${STATE_EMOJI.ok} オンボーディング完了！ account.json を更新しました。`,
          `- account_id: \`${finalize.account.account_id}\``,
          `- display_name: ${finalize.account.display_name}`,
          '',
          phase,
          '',
          '日次運用開始。明朝 07:00 JST から自動で投稿候補が作られます。',
          '\n📝 最初の投稿候補を作成中です…(まもなく別 thread で届きます)',
        ]
          .filter(Boolean)
          .join('\n'),
        tag: 'onboard.answer.completed',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: `${STATE_EMOJI.attention} 全質問の回答は保存しましたが、account.json への反映でエラー: ${message}`,
        tag: 'onboard.answer.finalize_failed',
      };
    }
  }
  if (updated.state === 'expired') {
    return {
      content: '⌛ セッションが期限切れになりました。もう一度「最初から」と話しかけて再開してください。',
      tag: 'onboard.answer.expired',
    };
  }
  const nextQ = findQuestionById(updated.currentQuestionId);
  if (!nextQ) {
    return {
      content: '⚠️ 次の質問が見つかりませんでした。operator に連絡してください。',
      tag: 'onboard.answer.missing_question',
    };
  }
  const idx = questionIndexFor(nextQ.id);
  return {
    content: renderOnboardingPrompt(updated, nextQ, Math.max(0, idx)),
    components: onboardingPromptComponents(updated, nextQ),
    tag: 'onboard.answer.next',
  };
}

function renderOnboardingPrompt(
  session: OnboardingSession,
  question: NonNullable<ReturnType<typeof findQuestionById>>,
  index: number,
): string {
  const review = pendingReviewForQuestion(session, question.id);
  if (!review) return renderQuestion(question, index);
  assertReviewQuestionId(review, question.id);
  return renderReviewQuestion(review, index);
}

function renderReviewQuestion(
  review: NonNullable<ReturnType<typeof pendingReviewForQuestion>>,
  index: number,
): string {
  return [
    `Q${index + 1}/${ONBOARDING_QUESTION_COUNT} (${review.question.category}) ${review.question.question}`,
    '',
    `既存回答: ${review.savedValueText}`,
    'このまま維持しますか？ 変更しますか？',
    '維持する場合は「維持」、変更する場合は「変更する」と返してください。',
  ].join('\n');
}

function assertReviewQuestionId(review: ResolvedQuestion, questionId: string): void {
  if (review.id !== questionId) {
    throw new Error(`review question mismatch: current=${questionId} review=${review.id}`);
  }
}

export function onboardingCancelComponents(sessionId: string): ReadonlyArray<unknown> {
  return [
    {
      type: 1,
      components: [
        { type: 2, custom_id: `onboard:cancel:${sessionId}`, label: 'やめる', style: 4 },
      ],
    },
  ];
}

export function onboardingReviewComponents(sessionId: string): ReadonlyArray<unknown> {
  return [
    {
      type: 1,
      components: [
        { type: 2, custom_id: `onboard:review:keep:${sessionId}`, label: '維持', style: 1 },
        {
          type: 2,
          custom_id: `onboard:review:change:${sessionId}`,
          label: '変更する',
          style: 2,
        },
        { type: 2, custom_id: `onboard:review:cancel:${sessionId}`, label: 'やめる', style: 4 },
      ],
    },
  ];
}

function onboardingPromptComponents(
  session: OnboardingSession,
  question: OnboardingQuestion,
): ReadonlyArray<unknown> {
  return pendingReviewForQuestion(session, question.id)
    ? onboardingReviewComponents(session.id)
    : onboardingCancelComponents(session.id);
}

type ReviewDecision =
  | { action: 'keep' }
  | { action: 'change' }
  | { action: 'answer'; answer: unknown };

async function classifyReviewDecision(
  bridge: LlmProvider,
  input: {
    questionId: string;
    question: string;
    review: ResolvedQuestion;
    savedValueText: string;
    reply: string;
  },
): Promise<ReviewDecision | null> {
  const local = classifyReviewDecisionLocal(input.reply);
  if (local) return local;
  const direct = classifyReviewDirectAnswer(input.review, input.reply);
  if (direct) return direct;
  try {
    const response = await bridge.call({
      kind: 'onboarding_review_decision' as never,
      userPrompt: JSON.stringify({
        task: 'Classify whether the customer wants to keep or change a saved onboarding answer. Return JSON: {"verdict":"keep"} or {"verdict":"change"}.',
        question_id: input.questionId,
        question: input.question,
        saved_value: input.savedValueText,
        customer_reply: input.reply,
      }),
    });
    const llm = classifyReviewDecisionFromLlmText(response.text);
    return llm ? { action: llm } : null;
  } catch {
    return null;
  }
}

function classifyReviewDecisionLocal(reply: string): ReviewDecision | null {
  const text = reply.trim().toLowerCase();
  if (!text) return null;
  if (
    text === 'keep' ||
    text === 'ok' ||
    text === 'no' ||
    text === 'n' ||
    text === 'はい' ||
    text.includes('維持') ||
    text.includes('そのまま') ||
    text.includes('現状') ||
    text.includes('変えない') ||
    text.includes('変更しない')
  ) {
    return { action: 'keep' };
  }
  if (
    text === 'change' ||
    text === 'update' ||
    text === 'yes' ||
    text === 'y' ||
    text.includes('変更') ||
    text.includes('変える') ||
    text.includes('変えたい') ||
    text.includes('直す') ||
    text.includes('編集') ||
    text.includes('修正')
  ) {
    return { action: 'change' };
  }
  return null;
}

function classifyReviewDirectAnswer(
  review: ResolvedQuestion,
  reply: string,
): ReviewDecision | null {
  const text = reply.trim();
  if (!text) return null;
  if (normalizeReviewText(text) === normalizeReviewText(review.savedValueText)) {
    return { action: 'keep' };
  }
  const question = review.question;
  if (question.type !== 'select' && question.type !== 'multi-select') {
    return null;
  }
  const replyKey = resolveChoiceKeyWithReviewAliases(question, text);
  if (!replyKey) return null;
  const savedKey =
    typeof review.savedValue === 'string'
      ? resolveChoiceKeyWithReviewAliases(question, review.savedValue)
      : resolveChoiceKeyWithReviewAliases(question, review.savedValueText);
  if (savedKey && savedKey === replyKey) {
    return { action: 'keep' };
  }
  return { action: 'answer', answer: question.type === 'select' ? replyKey : text };
}

function resolveChoiceKeyWithReviewAliases(
  question: OnboardingQuestion,
  answer: string,
): string | null {
  const key = resolveChoiceKey(question, answer);
  if (key) return key;
  const normalized = normalizeReviewText(answer);
  if (normalized === '中' && question.options?.some((opt) => opt.key === 'balanced')) {
    return 'balanced';
  }
  return null;
}

function normalizeReviewText(value: string): string {
  return value.trim().toLowerCase();
}

function classifyReviewDecisionFromLlmText(raw: string): 'keep' | 'change' | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as { verdict?: unknown };
    if (parsed.verdict === 'keep' || parsed.verdict === 'change') {
      return parsed.verdict;
    }
  } catch {
    // fall through to text matching
  }
  const local = classifyReviewDecisionLocal(text)?.action ?? null;
  return local === 'keep' || local === 'change' ? local : null;
}

async function startOnboardingPhaseBridge(ctx: HandlerContext): Promise<string> {
  try {
    const session = await startPhaseQuestionnaire({
      repo: ctx.repo,
      bridge: ctx.bridge,
      poster: ctx.discordPoster,
      cadence: 'quarterly',
      logger: ctx.logger,
      autoChainNext: true,
    });
    const first = session.questions[0];
    return [
      '🎉 続けて、四半期→月次→週次 の方針合わせに入ります。',
      first ? `最初の質問:\n${first.question}` : '最初の質問を開始しました。',
    ].join('\n');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `${STATE_EMOJI.attention} 方針合わせアンケートの開始に失敗しました: ${message}`;
  }
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
async function bootstrapFirstDraft(ctx: HandlerContext): Promise<FirstDraftOutcome> {
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
    ...(ctx.exemplarWriter ? { exemplarWriter: ctx.exemplarWriter } : {}),
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
    return {
      kind: 'awaiting_decision',
      sessionId: session.id,
      ...(result.threadId ? { threadId: result.threadId } : {}),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { kind: 'fail', reason };
  }
}

/**
 * Fire-and-forget wrapper for bootstrapFirstDraft.
 *
 * Returns immediately. The pipeline runs on the next tick; on
 * completion the draft card is posted via DiscordPoster (already
 * handled inside bootstrapFirstDraft on the success path), and on
 * failure we escalate to the operator channel so they can investigate
 * before the customer notices the missing card.
 *
 * Exported so tests can directly assert that the background work
 * completes without the caller awaiting it.
 */
export function runBootstrapFirstDraftInBackground(ctx: HandlerContext): Promise<void> {
  // Detach scheduling from the caller's microtask so the customer
  // reply flushes before the heavy LLM pipeline kicks in.
  const work = (async (): Promise<void> => {
    let outcome: FirstDraftOutcome;
    try {
      outcome = await bootstrapFirstDraft(ctx);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      ctx.logger.warn?.({ error: reason }, 'bootstrap_first_draft_background_threw');
      outcome = { kind: 'fail', reason };
    }
    if (outcome.kind === 'fail') {
      ctx.logger.warn?.({ reason: outcome.reason }, 'bootstrap_first_draft_failed_background');
      try {
        const mention =
          ctx.operatorDiscordUserIds && ctx.operatorDiscordUserIds[0]
            ? `<@${ctx.operatorDiscordUserIds[0]}> `
            : '';
        await ctx.discordPoster.postEscalation({
          channelRole: 'operator',
          content:
            `${mention}[FAIL] onboarding bootstrap first draft\n` +
            `account: ${ctx.accountId}\n` +
            `reason: ${outcome.reason}`,
          metadata: {
            kind: 'onboarding_bootstrap_failed',
            accountId: ctx.accountId,
          },
        });
      } catch (escErr) {
        ctx.logger.warn?.(
          { error: escErr instanceof Error ? escErr.message : String(escErr) },
          'bootstrap_first_draft_escalation_failed',
        );
      }
    }
  })();
  // Swallow the rejection on the detached promise so unhandled-rejection
  // listeners stay quiet — the inner block already logs + escalates.
  work.catch(() => undefined);
  return work;
}
