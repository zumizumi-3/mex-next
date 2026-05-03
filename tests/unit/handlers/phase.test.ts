/**
 * Tests for handlers/phase.ts.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  handlePhaseQuestionnaireStart,
  handlePhaseQuestionnaireStatus,
  handlePhaseQuestionnaireSubmit,
} from '../../../src/handlers/index.js';
import { setupHandlerTest, type TestHandlerScaffold } from './test-helpers.js';

let scaf: TestHandlerScaffold;
afterEach(async () => {
  await scaf?.cleanup();
});

const SYNTH_REPLY = JSON.stringify({
  summary: '今月は満足度が高め。',
  signals: [{ axis: 'satisfaction', observation: '4/5' }],
  recommended_actions: ['反応誘導の型を追加'],
});

describe('handlePhaseQuestionnaireStart', () => {
  it('cadence=monthly で開始メッセージを返す', async () => {
    scaf = await setupHandlerTest();
    const result = await handlePhaseQuestionnaireStart(scaf.ctx, { cadence: 'monthly' });
    expect(result.tag).toBe('phase.questionnaire_start');
    expect(result.content).toContain('月次');
  });

  it('cadence=quarterly でも開始できる', async () => {
    scaf = await setupHandlerTest();
    const result = await handlePhaseQuestionnaireStart(scaf.ctx, { cadence: 'quarterly' });
    expect(result.content).toContain('四半期');
  });
});

describe('handlePhaseQuestionnaireStatus', () => {
  it('未開始なら空メッセージ', async () => {
    scaf = await setupHandlerTest();
    const result = await handlePhaseQuestionnaireStatus(scaf.ctx, {});
    expect(result.tag).toBe('phase.questionnaire_status.empty');
  });

  it('開始後は session 一覧を返す', async () => {
    scaf = await setupHandlerTest();
    await handlePhaseQuestionnaireStart(scaf.ctx, { cadence: 'monthly' });
    const result = await handlePhaseQuestionnaireStatus(scaf.ctx, {});
    expect(result.tag).toBe('phase.questionnaire_status');
    expect(result.content).toContain('monthly');
  });
});

describe('handlePhaseQuestionnaireSubmit', () => {
  it('answers を submit すると summary が返る', async () => {
    scaf = await setupHandlerTest({
      llmReplies: {
        phase_questionnaire_synthesize: SYNTH_REPLY,
      },
    });
    const start = await handlePhaseQuestionnaireStart(scaf.ctx, { cadence: 'monthly' });
    // session_id を取り出す (\`xxx\` フォーマット)
    const match = start.content.match(/`([^`]+)`/);
    expect(match).toBeTruthy();
    const sessionId = match![1]!;
    const result = await handlePhaseQuestionnaireSubmit(scaf.ctx, {
      session_id: sessionId,
      answers: { monthly_satisfaction: '4', monthly_pain: '反応が薄い' },
    });
    expect(result.tag).toBe('phase.questionnaire_submit');
    expect(result.content).toContain('満足度が高め');
  });

  it('auto_chain_next=true の quarterly 完了後に monthly を開始する', async () => {
    scaf = await setupHandlerTest({
      llmReplies: {
        phase_questionnaire_synthesize: SYNTH_REPLY,
      },
    });
    const { startPhaseQuestionnaire, submitPhaseAnswers, listPhaseQuestionnaireSessions } =
      await import('../../../src/phase-questionnaire/runner.js');
    const started = await startPhaseQuestionnaire({
      repo: scaf.ctx.repo,
      bridge: scaf.ctx.bridge,
      poster: scaf.ctx.discordPoster,
      cadence: 'quarterly',
      logger: scaf.ctx.logger,
      autoChainNext: true,
    });

    await submitPhaseAnswers({
      repo: scaf.ctx.repo,
      bridge: scaf.ctx.bridge,
      poster: scaf.ctx.discordPoster,
      sessionId: started.id,
      answers: { quarterly_goal: '伸ばす' },
      logger: scaf.ctx.logger,
    });
    const sessions = await listPhaseQuestionnaireSessions(scaf.ctx.repo);

    expect(sessions.some((s) => s.cadence === 'monthly' && s.auto_chain_next)).toBe(true);
  });
});
