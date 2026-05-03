/**
 * Onboarding questions catalog (33 questions).
 *
 * Customer-facing onboarding wizard. Each question collects a single
 * piece of information needed to populate AccountJson (persona, brand,
 * goal_stack, half_focus, voice_profile, operating_cadence, targets).
 *
 * Ported from Python `runtime/scripts/onboarding_collector.py`
 * (QUESTION_SPECS, CHARACTER_CHOICES, DISTANCE_CHOICES, CADENCE_CHOICES,
 * launch_wizard MINIMAL_DEFAULT_ANSWERS).
 *
 * The catalog is intentionally a flat list so the collector can drive a
 * simple linear state machine. `category` lets the finalize step group
 * answers by AccountJson section.
 */

export type OnboardingCategory =
  | 'persona'
  | 'brand'
  | 'goal'
  | 'voice'
  | 'cadence'
  | 'targets';

export type OnboardingQuestionType =
  | 'text'
  | 'select'
  | 'multi-select'
  | 'number';

export interface OnboardingChoice {
  /** Stable machine key — what gets written to answers. */
  readonly key: string;
  /** Human-facing label shown in prompt. */
  readonly label: string;
  /** Short example sentence to disambiguate the choice. */
  readonly example?: string;
}

export interface OnboardingQuestion {
  readonly id: string;
  readonly category: OnboardingCategory;
  readonly question: string;
  readonly type: OnboardingQuestionType;
  readonly accountFieldPath?: string;
  readonly options?: ReadonlyArray<OnboardingChoice>;
  readonly required: boolean;
  readonly default?: string | number | ReadonlyArray<string>;
  readonly hint?: string;
}

const PERSONA_STYLE_CHOICES: ReadonlyArray<OnboardingChoice> = [
  { key: 'practical_operator', label: '実務家', example: '副業は気合いより、先に導線設計だ。' },
  { key: 'corporate_partner', label: '伴走パートナー', example: '事業の詰まりは、気合いではなく設計でほどけます。' },
  { key: 'industry_expert', label: '専門家', example: '論点を外さなければ、判断はぶれません。' },
  { key: 'sharp_mentor', label: '厳しめメンター', example: '理想を語る前に、まず売れ。' },
  { key: 'close_guide', label: '伴走ガイド', example: '怖くて普通です。小さく始めれば大丈夫です。' },
  { key: 'builder_experimenter', label: '実験家', example: 'まず試す。比べる。残す。' },
];

const DISTANCE_CHOICES: ReadonlyArray<OnboardingChoice> = [
  { key: 'close', label: '近め', example: '一緒に整理していきましょう。' },
  { key: 'balanced', label: '標準', example: 'まず小さく始める方が再現しやすいです。' },
  { key: 'stern', label: 'やや遠め', example: '順番を間違えないでください。' },
];

const ASSERTIVENESS_CHOICES: ReadonlyArray<OnboardingChoice> = [
  { key: 'soft', label: 'やわらかめ' },
  { key: 'balanced', label: '標準' },
  { key: 'strong', label: '強め' },
];

const WARMTH_CHOICES: ReadonlyArray<OnboardingChoice> = [
  { key: 'cool', label: 'クール' },
  { key: 'balanced', label: '標準' },
  { key: 'warm', label: '温かめ' },
];

const CADENCE_CHOICES: ReadonlyArray<OnboardingChoice> = [
  { key: 'light', label: '軽め', example: '1 本/日くらい' },
  { key: 'standard', label: '標準', example: '1〜3 本/日' },
  { key: 'aggressive', label: '強め', example: '3〜5 本/日' },
];

const PROHIBITED_CHOICES: ReadonlyArray<OnboardingChoice> = [
  { key: 'investment_pitch', label: '投資勧誘' },
  { key: 'income_flex', label: '年収マウント' },
  { key: 'politics', label: '政治的言及' },
  { key: 'competitor_attack', label: '競合批判' },
  { key: 'affiliate_tone', label: 'アフィ感' },
  { key: 'pure_motivation', label: '精神論だけ' },
];

const APPROVAL_OWNER_CHOICES: ReadonlyArray<OnboardingChoice> = [
  { key: 'director', label: '日々の運用担当' },
  { key: 'account-owner', label: '上位方針の責任者' },
];

const PUBLISH_MODE_CHOICES: ReadonlyArray<OnboardingChoice> = [
  { key: 'manual', label: '手動投稿' },
  { key: 'x_api', label: 'X API publish' },
  { key: 'later', label: 'あとで決める' },
];

const READ_MODE_CHOICES: ReadonlyArray<OnboardingChoice> = [
  { key: 'manual', label: '手動で確認' },
  { key: 'x_api', label: 'X API metrics' },
  { key: 'later', label: 'あとで決める' },
];

/**
 * The 33-question onboarding catalog.
 *
 * Indexing convention — purely linear; the collector walks it from
 * index 0. Categories are advisory (used by the finalizer to map
 * answers into AccountJson sections).
 */
export const ONBOARDING_QUESTIONS: ReadonlyArray<OnboardingQuestion> = [
  // ── persona ────────────────────────────────────────────────
  {
    id: 'display_name',
    category: 'persona',
    question: 'X で使う表示名を 40 文字以内で教えてください。',
    type: 'text',
    accountFieldPath: 'display_name',
    required: true,
    hint: '例: ずみさん / Zumi / 副業メモの人',
  },
  {
    id: 'x_handle',
    category: 'persona',
    question: 'X のユーザー名を @ なしで教えてください。',
    type: 'text',
    accountFieldPath: 'x_handle',
    required: true,
    hint: '英数字とアンダースコア、最大 15 文字 (例: example_handle)',
  },
  {
    id: 'persona_role',
    category: 'persona',
    question: '主な肩書き・役割を 1 行で教えてください。',
    type: 'text',
    required: true,
    hint: '例: 副業コンサル / SaaS 創業者 / コーチ',
  },
  {
    id: 'persona_style',
    category: 'persona',
    question: 'ベース人格タイプを選んでください。',
    type: 'select',
    options: PERSONA_STYLE_CHOICES,
    required: true,
    default: 'builder_experimenter',
  },
  {
    id: 'gender_presentation',
    category: 'persona',
    question: '一人称や見せ方の好みがあれば教えてください (任意)。',
    type: 'text',
    accountFieldPath: 'voice_profile.gender_presentation',
    required: false,
    hint: '例: 男性 / 女性 / どちらでもない / 一人称はぼく',
  },

  // ── brand ──────────────────────────────────────────────────
  {
    id: 'primary_audience',
    category: 'brand',
    question: '誰に届けたいですか？ 1〜2 行で教えてください。',
    type: 'text',
    accountFieldPath: 'brand.audience',
    required: true,
    hint: '例: 副業を始めたい 30〜40 代の会社員',
  },
  {
    id: 'brand_promise',
    category: 'brand',
    question: 'この発信で読者に約束したい価値を 1 行で教えてください。',
    type: 'text',
    accountFieldPath: 'brand.promise',
    required: true,
    hint: '例: 副業の最初の一歩を最短で再現する',
  },
  {
    id: 'core_thesis',
    category: 'brand',
    question: '中心の主張・テーマを 1〜3 個、カンマ区切りで教えてください。',
    type: 'text',
    accountFieldPath: 'brand.core_thesis',
    required: false,
    default: '',
    hint: '例: 順番設計, 小さく検証, 売る前の言語化',
  },
  {
    id: 'problem_space',
    category: 'brand',
    question: '解決したい読者の悩みを 1〜3 個、カンマ区切りで教えてください。',
    type: 'text',
    accountFieldPath: 'brand.problem_space',
    required: false,
    default: '',
  },
  {
    id: 'evidence_sources',
    category: 'brand',
    question: '根拠として使える情報源 (URL / 書籍 / 自分の経験) があれば教えてください。',
    type: 'text',
    accountFieldPath: 'brand.evidence_sources',
    required: false,
    default: '',
  },

  // ── goal ──────────────────────────────────────────────────
  {
    id: 'objective',
    category: 'goal',
    question: 'このアカウントで達成したいことを 1 行で教えてください。',
    type: 'text',
    accountFieldPath: 'goal_stack.objective',
    required: true,
    hint: '例: 副業興味層に LINE 流入',
  },
  {
    id: 'recognition_goal',
    category: 'goal',
    question: '「こう覚えてほしい」役割があれば教えてください (任意)。',
    type: 'text',
    accountFieldPath: 'goal_stack.recognition',
    required: false,
    default: '',
  },
  {
    id: 'trust_goal',
    category: 'goal',
    question: '信頼を積むための具体的な行動があれば教えてください (任意)。',
    type: 'text',
    accountFieldPath: 'goal_stack.trust',
    required: false,
    default: '',
  },
  {
    id: 'relationship_goal',
    category: 'goal',
    question: '読者との関係をどう育てたいですか？ (任意)',
    type: 'text',
    accountFieldPath: 'goal_stack.relationship',
    required: false,
    default: '',
  },
  {
    id: 'action_goal',
    category: 'goal',
    question: '読者に最終的に取ってほしい行動を 1 行で教えてください (任意)。',
    type: 'text',
    accountFieldPath: 'goal_stack.action',
    required: false,
    default: '',
    hint: '例: LINE 登録 / 個別相談予約',
  },
  {
    id: 'half_focus',
    category: 'goal',
    question: 'この半年で集中したい主題があれば 1 行で教えてください (任意)。',
    type: 'text',
    accountFieldPath: 'half_focus',
    required: false,
    default: '',
  },

  // ── voice ─────────────────────────────────────────────────
  {
    id: 'distance_to_reader',
    category: 'voice',
    question: '読者との距離感を選んでください。',
    type: 'select',
    accountFieldPath: 'voice_profile.distance_to_reader',
    options: DISTANCE_CHOICES,
    required: true,
    default: 'balanced',
  },
  {
    id: 'assertiveness',
    category: 'voice',
    question: '主張の強さを選んでください。',
    type: 'select',
    accountFieldPath: 'voice_profile.assertiveness',
    options: ASSERTIVENESS_CHOICES,
    required: true,
    default: 'balanced',
  },
  {
    id: 'warmth',
    category: 'voice',
    question: 'トーンの温度感を選んでください。',
    type: 'select',
    accountFieldPath: 'voice_profile.warmth',
    options: WARMTH_CHOICES,
    required: true,
    default: 'balanced',
  },
  {
    id: 'humor',
    category: 'voice',
    question: 'ユーモアの量を教えてください (任意 / 例: ほぼ無し / 少なめ / 多め)。',
    type: 'text',
    accountFieldPath: 'voice_profile.humor',
    required: false,
    default: '少なめ',
  },
  {
    id: 'emoji_policy',
    category: 'voice',
    question: '絵文字の使い方を教えてください (任意)。',
    type: 'text',
    accountFieldPath: 'voice_profile.emoji_policy',
    required: false,
    default: '使わない',
    hint: '例: 使わない / 強調のみ / 自由に使う',
  },
  {
    id: 'forbidden_tones',
    category: 'voice',
    question: '避けたい言い回しがあればカンマ区切りで教えてください (任意)。',
    type: 'text',
    accountFieldPath: 'voice_profile.forbidden_tones',
    required: false,
    default: '',
    hint: '例: 「神」と書かない, ビックリマーク連発しない',
  },
  {
    id: 'prohibited',
    category: 'voice',
    question: '避けたい話題を選んでください (複数可)。',
    type: 'multi-select',
    accountFieldPath: 'brand.avoid_topics',
    options: PROHIBITED_CHOICES,
    required: false,
    default: [],
  },

  // ── cadence ───────────────────────────────────────────────
  {
    id: 'cadence_profile',
    category: 'cadence',
    question: '投稿ペースを選んでください。',
    type: 'select',
    accountFieldPath: 'operating_cadence.profile',
    options: CADENCE_CHOICES,
    required: true,
    default: 'light',
  },
  {
    id: 'hot_zones',
    category: 'cadence',
    question: '投稿 OK 時間帯を `HH:MM-HH:MM` 形式で、複数あればカンマ区切りで教えてください。',
    type: 'text',
    accountFieldPath: 'operating_cadence.hot_zones',
    required: false,
    default: '06:00-09:00, 11:00-13:00, 17:00-22:00',
  },
  {
    id: 'timezone',
    category: 'cadence',
    question: 'タイムゾーンを教えてください。',
    type: 'text',
    accountFieldPath: 'operating_cadence.timezone',
    required: false,
    default: 'Asia/Tokyo',
  },
  {
    id: 'rolling_review_every_days',
    category: 'cadence',
    question: '振り返りを何日おきに回したいですか？',
    type: 'number',
    accountFieldPath: 'operating_cadence.review_targets.rolling_review_every_days',
    required: false,
    default: 7,
  },

  // ── targets ───────────────────────────────────────────────
  {
    id: 'tracked_handles',
    category: 'targets',
    question: '常時ウォッチしたい X アカウント (handle) があればカンマ区切りで教えてください (任意)。',
    type: 'text',
    accountFieldPath: 'x_action_system.tracked_targets.usernames',
    required: false,
    default: '',
    hint: '例: tanaka_san, sato_eng',
  },
  {
    id: 'tracked_keywords',
    category: 'targets',
    question: '常時ウォッチしたいキーワードがあればカンマ区切りで教えてください (任意)。',
    type: 'text',
    accountFieldPath: 'x_action_system.tracked_targets.keywords',
    required: false,
    default: '',
  },
  {
    id: 'low_risk_owner',
    category: 'targets',
    question: '低リスク承認者 (日常運用) を選んでください。',
    type: 'select',
    accountFieldPath: 'approval_policy.low_risk_owner',
    options: APPROVAL_OWNER_CHOICES,
    required: true,
    default: 'director',
  },
  {
    id: 'high_risk_owner',
    category: 'targets',
    question: '高リスク承認者 (上位方針) を選んでください。',
    type: 'select',
    accountFieldPath: 'approval_policy.high_risk_owner',
    options: APPROVAL_OWNER_CHOICES,
    required: true,
    default: 'account-owner',
  },
  {
    id: 'publish_mode',
    category: 'targets',
    question: '投稿の publish 方法を選んでください。',
    type: 'select',
    options: PUBLISH_MODE_CHOICES,
    required: false,
    default: 'manual',
  },
  {
    id: 'read_mode',
    category: 'targets',
    question: 'X API の read (metrics / 競合分析) を使いますか？',
    type: 'select',
    options: READ_MODE_CHOICES,
    required: false,
    default: 'manual',
  },
];

/** Question count constant — exported so tests assert the catalog size. */
export const ONBOARDING_QUESTION_COUNT = ONBOARDING_QUESTIONS.length;

/** Look up a question by id (returns undefined when not found). */
export function findQuestionById(id: string): OnboardingQuestion | undefined {
  return ONBOARDING_QUESTIONS.find((q) => q.id === id);
}

/** Index in the catalog (-1 when not found). */
export function indexOfQuestion(id: string): number {
  return ONBOARDING_QUESTIONS.findIndex((q) => q.id === id);
}

/** Question after `id` (or null when at the end). */
export function nextQuestion(id: string): OnboardingQuestion | null {
  const idx = indexOfQuestion(id);
  if (idx === -1) return null;
  if (idx + 1 >= ONBOARDING_QUESTIONS.length) return null;
  return ONBOARDING_QUESTIONS[idx + 1] ?? null;
}

/** First question in the catalog. */
export function firstQuestion(): OnboardingQuestion {
  const first = ONBOARDING_QUESTIONS[0];
  if (!first) {
    throw new Error('onboarding catalog is empty');
  }
  return first;
}

/** Resolve a select-style answer (label / key / lowercased) to the canonical key.
 *
 * Lenient on purpose: the rendered question shows the customer
 * "<label> (<key>) — <tagline>" so a copy-paste of any of the three
 * pieces (or the whole thing) should resolve.
 */
export function resolveChoiceKey(
  question: OnboardingQuestion,
  answer: string,
): string | null {
  if (!question.options) return null;
  const trimmed = answer.trim();
  if (!trimmed) return null;
  const normalized = trimmed.toLowerCase();

  // 1) Exact match (key / label, case-insensitive).
  for (const opt of question.options) {
    if (opt.key.toLowerCase() === normalized || opt.label.toLowerCase() === normalized) {
      return opt.key;
    }
  }

  // 2) Pattern "<label> (<key>) — <tagline>" — pull the (<key>) and look it up.
  const parenMatch = trimmed.match(/[(（]([a-z][a-z0-9_]*)[)）]/i);
  if (parenMatch) {
    const candidate = parenMatch[1]?.toLowerCase();
    if (candidate) {
      for (const opt of question.options) {
        if (opt.key.toLowerCase() === candidate) return opt.key;
      }
    }
  }

  // 3) startsWith match — handles "伴走パートナー (corporate_partner) — ..."
  // and the customer typing just "伴走パートナー です" / "伴走パートナーがいい".
  for (const opt of question.options) {
    const labelLower = opt.label.toLowerCase();
    const keyLower = opt.key.toLowerCase();
    if (
      normalized.startsWith(labelLower) ||
      normalized.startsWith(keyLower) ||
      normalized.includes(labelLower)
    ) {
      return opt.key;
    }
  }

  return null;
}
