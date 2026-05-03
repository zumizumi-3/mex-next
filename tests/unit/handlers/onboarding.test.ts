import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  applyFreeFormAnswer,
  handleOnboardStart,
  handleOnboardStatus,
  handleOnboardCancel,
} from '../../../src/handlers/onboarding.js';
import { OnboardingCollector } from '../../../src/onboarding/collector.js';
import { ONBOARDING_QUESTIONS } from '../../../src/onboarding/questions.js';
import { setupHandlerTest, type TestHandlerScaffold } from './test-helpers.js';

let scaf: TestHandlerScaffold;
afterEach(async () => {
  await scaf?.cleanup();
});

describe('handleOnboardStart', () => {
  it('creates a session and surfaces Q1', async () => {
    scaf = await setupHandlerTest();
    const result = await handleOnboardStart(scaf.ctx, {});
    expect(result.tag).toBe('onboard.start');
    expect(result.content).toContain('Q1/');
    expect(result.content).toContain('オンボーディング');
    const collector = new OnboardingCollector({
      repo: scaf.ctx.repo,
      bridge: scaf.ctx.bridge,
      logger: scaf.ctx.logger,
    });
    const active = await collector.getActive();
    expect(active).not.toBeNull();
    expect(active?.state).toBe('asking');
  });

  it('returning when no active session present is OK (idempotent)', async () => {
    scaf = await setupHandlerTest();
    const a = await handleOnboardStart(scaf.ctx, {});
    const b = await handleOnboardStart(scaf.ctx, {});
    expect(a.tag).toBe('onboard.start');
    expect(b.tag).toBe('onboard.start');
  });
});

describe('handleOnboardStatus', () => {
  it('idle when no session', async () => {
    scaf = await setupHandlerTest();
    const result = await handleOnboardStatus(scaf.ctx, {});
    expect(result.tag).toBe('onboard.status.idle');
    expect(result.content).toContain('オンボーディング中ではありません');
  });

  it('reports answered count and current question after start', async () => {
    scaf = await setupHandlerTest();
    await handleOnboardStart(scaf.ctx, {});
    const result = await handleOnboardStatus(scaf.ctx, {});
    expect(result.tag).toBe('onboard.status');
    expect(result.content).toContain('回答済: 0/');
    expect(result.content).toContain('現在の質問');
  });
});

describe('handleOnboardCancel', () => {
  it('noop when no active session', async () => {
    scaf = await setupHandlerTest();
    const result = await handleOnboardCancel(scaf.ctx, {});
    expect(result.tag).toBe('onboard.cancel.noop');
  });

  it('cancels an active session', async () => {
    scaf = await setupHandlerTest();
    await handleOnboardStart(scaf.ctx, {});
    const result = await handleOnboardCancel(scaf.ctx, {});
    expect(result.tag).toBe('onboard.cancel');
    expect(result.content).toContain('中断しました');
  });
});

describe('applyFreeFormAnswer onboarding review mode', () => {
  it('維持 keeps the saved answer and advances', async () => {
    scaf = await setupHandlerTest({ account: { account_id: 'zumi-x', display_name: '既存名' } });
    const collector = new OnboardingCollector({
      repo: scaf.ctx.repo,
      bridge: scaf.ctx.bridge,
      logger: scaf.ctx.logger,
    });
    const session = await collector.start();

    const result = await applyFreeFormAnswer(scaf.ctx, session, '維持');
    const updated = await collector.getSession(session.id);

    expect(result.content).toContain('X のユーザー名');
    expect(updated?.answers.display_name).toBe('既存名');
  });

  it('変更する returns to normal answer flow for that question', async () => {
    scaf = await setupHandlerTest({ account: { account_id: 'zumi-x', display_name: '既存名' } });
    const collector = new OnboardingCollector({
      repo: scaf.ctx.repo,
      bridge: scaf.ctx.bridge,
      logger: scaf.ctx.logger,
    });
    const session = await collector.start();

    const result = await applyFreeFormAnswer(scaf.ctx, session, '変更する');
    const updated = await collector.getSession(session.id);

    expect(result.content).toContain('X で使う表示名');
    expect(JSON.stringify(result.components)).toContain(`onboard:cancel:${session.id}`);
    expect(updated?.currentQuestionId).toBe('display_name');
    expect(updated?.pending_review_questions.map((q) => q.id)).not.toContain('display_name');
  });

  it('stale session 引数でも保存済み currentQuestionId を再取得して review を表示する', async () => {
    scaf = await setupHandlerTest({
      account: {
        account_id: 'zumi-x',
        voice_profile: { assertiveness: '中', warmth: '温かめ' },
      },
      llmReplies: { onboarding_review_decision: '{"verdict":"unknown"}' },
    });
    const collector = new OnboardingCollector({
      repo: scaf.ctx.repo,
      bridge: scaf.ctx.bridge,
      logger: scaf.ctx.logger,
    });
    const session = await collector.start();
    await advanceToQuestion(collector, session.id, 'assertiveness');
    const staleQ19 = await collector.getSession(session.id);
    expect(staleQ19?.currentQuestionId).toBe('assertiveness');

    await applyFreeFormAnswer(scaf.ctx, staleQ19!, '維持');
    const result = await applyFreeFormAnswer(scaf.ctx, staleQ19!, 'ぜんぜん違う');

    expect(result.content).toContain('トーンの温度感');
    expect(result.content).not.toContain('主張の強さ');
  });

  it('Q19 review で saved label と同じ「中」は keep 扱いになる', async () => {
    scaf = await setupHandlerTest({
      account: { account_id: 'zumi-x', voice_profile: { assertiveness: '中' } },
    });
    const collector = new OnboardingCollector({
      repo: scaf.ctx.repo,
      bridge: scaf.ctx.bridge,
      logger: scaf.ctx.logger,
    });
    const session = await collector.start();
    await advanceToQuestion(collector, session.id, 'assertiveness');
    const active = await collector.getSession(session.id);

    const result = await applyFreeFormAnswer(scaf.ctx, active!, '中');
    const updated = await collector.getSession(session.id);

    expect(result.content).toContain('トーンの温度感');
    expect(updated?.answers.assertiveness).toBe('balanced');
  });

  it('Q19 review で別の選択肢ラベル「強め」はその値で回答して進む', async () => {
    scaf = await setupHandlerTest({
      account: { account_id: 'zumi-x', voice_profile: { assertiveness: '中' } },
    });
    const collector = new OnboardingCollector({
      repo: scaf.ctx.repo,
      bridge: scaf.ctx.bridge,
      logger: scaf.ctx.logger,
    });
    const session = await collector.start();
    await advanceToQuestion(collector, session.id, 'assertiveness');
    const active = await collector.getSession(session.id);

    const result = await applyFreeFormAnswer(scaf.ctx, active!, '強め');
    const updated = await collector.getSession(session.id);

    expect(result.content).toContain('トーンの温度感');
    expect(updated?.answers.assertiveness).toBe('strong');
    expect(updated?.currentQuestionId).toBe('warmth');
  });

  it('Q19 review で ambiguous な返答は同じ Q19 review を再表示する', async () => {
    scaf = await setupHandlerTest({
      account: { account_id: 'zumi-x', voice_profile: { assertiveness: '中' } },
      llmReplies: { onboarding_review_decision: '{"verdict":"unknown"}' },
    });
    const collector = new OnboardingCollector({
      repo: scaf.ctx.repo,
      bridge: scaf.ctx.bridge,
      logger: scaf.ctx.logger,
    });
    const session = await collector.start();
    await advanceToQuestion(collector, session.id, 'assertiveness');
    const active = await collector.getSession(session.id);

    const result = await applyFreeFormAnswer(scaf.ctx, active!, 'ぜんぜん違う');
    const updated = await collector.getSession(session.id);

    expect(result.content).toContain('判断できませんでした');
    expect(result.content).toContain('主張の強さ');
    expect(result.content).not.toContain('読者との距離感');
    expect(JSON.stringify(result.components)).toContain(`onboard:review:keep:${session.id}`);
    expect(updated?.currentQuestionId).toBe('assertiveness');
  });

  it('changeCurrentReviewAnswer 後の表示は同じ question の通常入力 prompt', async () => {
    scaf = await setupHandlerTest({
      account: { account_id: 'zumi-x', voice_profile: { assertiveness: '中' } },
    });
    const collector = new OnboardingCollector({
      repo: scaf.ctx.repo,
      bridge: scaf.ctx.bridge,
      logger: scaf.ctx.logger,
    });
    const session = await collector.start();
    await advanceToQuestion(collector, session.id, 'assertiveness');
    const active = await collector.getSession(session.id);

    const result = await applyFreeFormAnswer(scaf.ctx, active!, '変更する');
    const updated = await collector.getSession(session.id);

    expect(result.content).toContain('主張の強さ');
    expect(result.content).toContain('選択肢:');
    expect(updated?.currentQuestionId).toBe('assertiveness');
    expect(updated?.pending_review_questions.map((q) => q.id)).not.toContain('assertiveness');
  });
});

describe('applyFreeFormAnswer finalize bridge', () => {
  it('finalize 後に quarterly phase questionnaire を auto-start する', async () => {
    scaf = await setupHandlerTest({
      llmReplies: {
        onboarding_finalize: '{}',
      },
    });
    const postThread = vi.spyOn(scaf.discordPoster, 'postThread');
    const collector = new OnboardingCollector({
      repo: scaf.ctx.repo,
      bridge: scaf.ctx.bridge,
      logger: scaf.ctx.logger,
    });
    const session = await collector.start();
    for (const q of ONBOARDING_QUESTIONS.slice(0, -1)) {
      await collector.answerCurrent(session.id, answerFor(q));
    }
    const active = await collector.getSession(session.id);
    expect(active).not.toBeNull();

    const result = await applyFreeFormAnswer(
      scaf.ctx,
      active!,
      String(answerFor(ONBOARDING_QUESTIONS.at(-1)!)),
    );
    const state = await scaf.repo.loadState();
    const phaseSessions = state.phase_questionnaire_sessions as Array<{
      cadence?: string;
      auto_chain_next?: boolean;
    }>;

    expect(result.content).toContain('四半期→月次→週次');
    expect(phaseSessions.some((s) => s.cadence === 'quarterly' && s.auto_chain_next)).toBe(true);
    expect(postThread).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ kind: 'phase_questionnaire', cadence: 'quarterly' }),
      }),
    );
  });
});

function answerFor(q: (typeof ONBOARDING_QUESTIONS)[number]): string | number {
  if (q.type === 'select') {
    return (q.default as string | undefined) ?? q.options?.[0]?.key ?? '';
  }
  if (q.type === 'multi-select') {
    return q.options?.[0]?.key ?? '';
  }
  if (q.type === 'number') {
    return typeof q.default === 'number' ? q.default : 7;
  }
  if (q.id === 'x_handle') return 'zumi_ops';
  if (q.id === 'hot_zones') return '06:00-09:00, 17:00-22:00';
  if (q.id === 'tracked_handles') return 'tanaka, sato';
  return '回答テキスト';
}

async function advanceToQuestion(
  collector: OnboardingCollector,
  sessionId: string,
  questionId: string,
): Promise<void> {
  for (let i = 0; i < ONBOARDING_QUESTIONS.length; i += 1) {
    const session = await collector.getSession(sessionId);
    if (!session) throw new Error('missing session');
    if (session.currentQuestionId === questionId) return;
    const question = ONBOARDING_QUESTIONS.find((q) => q.id === session.currentQuestionId);
    if (!question) throw new Error(`missing question ${session.currentQuestionId}`);
    await collector.answerCurrent(sessionId, answerFor(question));
  }
  throw new Error(`question not reached: ${questionId}`);
}
