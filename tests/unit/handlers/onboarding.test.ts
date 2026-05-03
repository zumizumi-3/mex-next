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

    expect(result).toContain('X のユーザー名');
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

    expect(result).toContain('X で使う表示名');
    expect(updated?.currentQuestionId).toBe('display_name');
    expect(updated?.pending_review_questions.map((q) => q.id)).not.toContain('display_name');
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

    expect(result).toContain('四半期→月次→週次');
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
