/**
 * Phase questionnaire question bank.
 *
 * Defines the periodic (weekly / monthly / quarterly) survey items the
 * operator pushes to the customer via Discord. The customer answers in
 * a thread, and the LLM (kind=phase_questionnaire_synthesize) folds
 * the answers into a digest the operator can act on.
 *
 * Mirrors the Python `runtime/scripts/phase_questionnaire.py` question
 * sets (DIAGNOSIS / WINDOW / RETROSPECTIVE), trimmed to the recurring
 * customer-pulse items that fit a chat-style cadence. The richer
 * onboarding-only sets stay on the Python side for now.
 */

export type PhaseCadence = 'weekly' | 'monthly' | 'quarterly';

export type PhaseQuestionType = 'text' | 'rating' | 'select';

export interface PhaseQuestion {
  /** Stable id (used as the answer key). Snake_case. */
  id: string;
  /** When this question fires. */
  cadence: PhaseCadence;
  /** Customer-facing prompt (Japanese). */
  question: string;
  /** Answer modality. */
  type: PhaseQuestionType;
  /** For type=select, the choice list (Japanese, customer-facing). */
  options?: string[];
  /** Optional gate: only ask when the account has at least N posts. */
  triggerAfterNPosts?: number;
  /** Optional explanation surfaced under the question. */
  explain?: string;
}

const RATING_HINT = '1-5 で答えてください (1=低い / 5=高い)。';

export const PHASE_QUESTIONS: ReadonlyArray<PhaseQuestion> = [
  // ---- weekly ----
  {
    id: 'weekly_pulse',
    cadence: 'weekly',
    question: '今週の運用の手応え、ひとことで言うと？',
    type: 'text',
    explain: '整った文章でなくて大丈夫です。1〜2 行で。',
  },
  {
    id: 'weekly_satisfaction',
    cadence: 'weekly',
    question: '今週の運用の満足度を 1-5 で',
    type: 'rating',
    explain: RATING_HINT,
  },
  {
    id: 'weekly_pain',
    cadence: 'weekly',
    question: '今週、引っかかったこと・違和感があれば教えてください',
    type: 'text',
  },
  // ---- monthly ----
  {
    id: 'monthly_satisfaction',
    cadence: 'monthly',
    question: '今月の運用、満足度を 1-5 で',
    type: 'rating',
    explain: RATING_HINT,
  },
  {
    id: 'monthly_pain',
    cadence: 'monthly',
    question: '今月、困っていること・改善したいことを教えてください',
    type: 'text',
  },
  {
    id: 'monthly_wins',
    cadence: 'monthly',
    question: '今月、良かった投稿・反応を覚えている範囲で 1-3 個',
    type: 'text',
  },
  {
    id: 'monthly_focus_change',
    cadence: 'monthly',
    question: '次の 1 ヶ月で、優先して改善したい場所はどれ？',
    type: 'select',
    options: [
      '見つかる (まだ知られていない)',
      '覚えられる (誰なのか印象に残らない)',
      '話しかけられる (反応が起きにくい)',
      '信頼される (深く刺さらない)',
      '動く (相談・購入につながらない)',
      '今のままで良い',
    ],
  },
  {
    id: 'monthly_voice_check',
    cadence: 'monthly',
    question: '生成された投稿の口調、自分らしい？ (1-5)',
    type: 'rating',
    explain: RATING_HINT,
  },
  // ---- quarterly ----
  {
    id: 'quarterly_direction',
    cadence: 'quarterly',
    question: 'この 3 ヶ月で読み手にどう思われたい？',
    type: 'text',
    explain: '読んだ人の印象や行動がどう変わるとよいかを 1-2 行で。',
  },
  {
    id: 'quarterly_continue',
    cadence: 'quarterly',
    question: '続けたい型・テーマを 1-3 個',
    type: 'text',
  },
  {
    id: 'quarterly_drop',
    cadence: 'quarterly',
    question: 'やめたい型・テーマがあれば 1-3 個',
    type: 'text',
  },
  {
    id: 'quarterly_satisfaction',
    cadence: 'quarterly',
    question: 'この 3 ヶ月の総合満足度 (1-5)',
    type: 'rating',
    explain: RATING_HINT,
  },
  {
    id: 'quarterly_recommend',
    cadence: 'quarterly',
    question: '同業の知人にこの運用を勧めたい？ (1-5)',
    type: 'rating',
    explain: RATING_HINT,
  },
];

export function questionsForCadence(cadence: PhaseCadence): PhaseQuestion[] {
  return PHASE_QUESTIONS.filter((q) => q.cadence === cadence);
}
