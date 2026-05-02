/**
 * Phase questionnaire handlers.
 *
 * `phase.questionnaire_start`  → open a new session for the requested cadence
 * `phase.questionnaire_status` → show in-flight / recent sessions
 * `phase.questionnaire_submit` → submit collected answers and synthesize
 */

import type { HandlerContext, HandlerResult, HandlerArgs } from './types.js';
import {
  startPhaseQuestionnaire,
  submitPhaseAnswers,
  listPhaseQuestionnaireSessions,
  getPhaseQuestionnaireSession,
} from '../phase-questionnaire/runner.js';
import type { PhaseCadence } from '../phase-questionnaire/questions.js';

function normalizeCadence(value: unknown): PhaseCadence {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'weekly' || text === 'monthly' || text === 'quarterly') {
    return text;
  }
  return 'monthly';
}

export async function handlePhaseQuestionnaireStart(
  ctx: HandlerContext,
  args: HandlerArgs,
): Promise<HandlerResult> {
  const cadence = normalizeCadence(args.cadence);
  try {
    const session = await startPhaseQuestionnaire({
      repo: ctx.repo,
      bridge: ctx.bridge,
      poster: ctx.discordPoster,
      cadence,
      logger: ctx.logger,
    });
    const cadenceLabel = cadence === 'weekly' ? '週次' : cadence === 'monthly' ? '月次' : '四半期';
    const lines = [
      `📋 ${cadenceLabel}アンケートを開始しました (\`${session.id}\`)`,
      `- 質問数: ${session.questions.length}`,
      session.threadId ? `- スレッド: ${session.threadId}` : '- スレッド作成は失敗 (DM 経由を確認してください)',
    ];
    return { content: lines.join('\n'), tag: 'phase.questionnaire_start' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: `❌ アンケートの開始に失敗しました: ${message}`,
      tag: 'phase.questionnaire_start.fail',
    };
  }
}

export async function handlePhaseQuestionnaireStatus(
  ctx: HandlerContext,
  args: HandlerArgs,
): Promise<HandlerResult> {
  const sessionIdRaw = String(args.session_id ?? '').trim();
  const cadenceRaw = String(args.cadence ?? '').trim().toLowerCase();
  const cadence: PhaseCadence | undefined =
    cadenceRaw === 'weekly' || cadenceRaw === 'monthly' || cadenceRaw === 'quarterly'
      ? (cadenceRaw as PhaseCadence)
      : undefined;

  if (sessionIdRaw) {
    const session = await getPhaseQuestionnaireSession(ctx.repo, sessionIdRaw);
    if (!session) {
      return {
        content: `アンケートセッションが見つかりません: \`${sessionIdRaw}\``,
        tag: 'phase.questionnaire_status.miss',
      };
    }
    const lines = [
      `📋 ${session.cadence} アンケート \`${session.id}\``,
      `- status: ${session.status}`,
      `- 回答済み: ${Object.keys(session.answers).length}/${session.questions.length}`,
    ];
    if (session.synthesis) {
      lines.push('', '**summary**', session.synthesis.summary || '_未生成_');
    }
    return { content: lines.join('\n'), tag: 'phase.questionnaire_status' };
  }

  const sessions = await listPhaseQuestionnaireSessions(ctx.repo, cadence);
  if (sessions.length === 0) {
    return { content: 'アンケートセッションはまだありません。', tag: 'phase.questionnaire_status.empty' };
  }
  const recent = sessions.slice(-5).reverse();
  const lines = ['📋 最近のアンケート'];
  for (const s of recent) {
    lines.push(`- \`${s.id}\` ${s.cadence} ${s.status} (${Object.keys(s.answers).length}/${s.questions.length})`);
  }
  return { content: lines.join('\n'), tag: 'phase.questionnaire_status' };
}

export async function handlePhaseQuestionnaireSubmit(
  ctx: HandlerContext,
  args: HandlerArgs,
): Promise<HandlerResult> {
  const sessionId = String(args.session_id ?? '').trim();
  if (!sessionId) {
    return {
      content: '⚠️ session_id を指定してください。',
      tag: 'phase.questionnaire_submit.missing_id',
    };
  }
  const answersRaw = args.answers;
  if (!answersRaw || typeof answersRaw !== 'object') {
    return {
      content: '⚠️ answers (id → 回答) を指定してください。',
      tag: 'phase.questionnaire_submit.missing_answers',
    };
  }
  const answers: Record<string, string> = {};
  for (const [k, v] of Object.entries(answersRaw as Record<string, unknown>)) {
    answers[k] = String(v ?? '').trim();
  }
  try {
    const session = await submitPhaseAnswers({
      repo: ctx.repo,
      bridge: ctx.bridge,
      poster: ctx.discordPoster,
      sessionId,
      answers,
      logger: ctx.logger,
    });
    const lines = [
      `📋 アンケート \`${session.id}\` を集約しました`,
      `- status: ${session.status}`,
    ];
    if (session.synthesis) {
      lines.push('', '**summary**', session.synthesis.summary || '_未生成_');
      if (session.synthesis.recommendedActions.length > 0) {
        lines.push('', '**次の一手**');
        for (const a of session.synthesis.recommendedActions) {
          lines.push(`- ${a}`);
        }
      }
    } else if (session.lastError) {
      lines.push('', `⚠️ 集約失敗: ${session.lastError}`);
    }
    return { content: lines.join('\n'), tag: 'phase.questionnaire_submit' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: `❌ アンケート集約に失敗しました: ${message}`,
      tag: 'phase.questionnaire_submit.fail',
    };
  }
}
