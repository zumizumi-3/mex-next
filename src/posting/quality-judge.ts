/**
 * 5-axis LLM-as-judge quality gate.
 *
 * Mirrors the Python implementation in `runtime/scripts/posting_v2.py`
 * (`_judge_quality`, `_normalize_quality_judgement`, `_quality_passes`).
 *
 * Axes (DESIGN.md 2.2):
 *  - stop_power   : 1文目で読者の手が止まるか
 *  - specificity  : 一般論ではなく具体性があるか
 *  - progression  : hook → claim → evidence → residue の流れがあるか
 *  - voice_match  : account_voice / forbidden_tones に整合しているか
 *  - length_fit   : format_length_range の中で自然に収まっているか
 *
 * Pass rule: each axis 0-5, ≥3 = pass. The overall gate requires at
 * least `REQUIRED_PASSING_AXES` axes passing (3 of 5 by default).
 *
 * The judge is a *hard* gate — fail → repairing → at most 2 retries
 * → awaiting_decision (operator decides). We never silently downgrade
 * the score; we record the raw response so the failure is debuggable.
 */

import type { AccountJson, LlmProvider } from './types.js';

export const QUALITY_AXES = [
  'stop_power',
  'specificity',
  'progression',
  'voice_match',
  'length_fit',
] as const;

export type QualityAxis = (typeof QUALITY_AXES)[number];

/** Per-axis score returned by the judge. */
export interface AxisScore {
  axis: QualityAxis;
  /** Integer 0..5, clamped. */
  score: number;
  /** Short reason from the judge. */
  comment: string;
}

export interface QualityResult {
  scores: AxisScore[];
  /** Overall pass/fail. */
  pass: boolean;
  /** Axes that scored below threshold. */
  failureAxes: QualityAxis[];
  /** Optional next-prompt hint emitted by the judge. */
  regenerateHint?: string;
  /** Raw response text from the LLM (for debugging). */
  rawResponse?: string;
  /**
   * True iff the failure was a transient LLM transport error (network /
   * timeout / 5xx). The state machine uses this to decide between:
   *  - retryable=true  → re-generate immediately (LLM hiccup, no fault
   *                      with the candidate itself).
   *  - retryable=false → route to `repairing` (the candidate is bad, or
   *                      the model emitted unparseable JSON / out-of-
   *                      range scores — re-prompting won't help).
   *
   * Only meaningful when `pass` is false; on pass we never branch on it.
   */
  retryable?: boolean;
}

export const QUALITY_SCORE_MIN = 0;
export const QUALITY_SCORE_MAX = 5;
export const QUALITY_PASS_THRESHOLD = 3;
export const REQUIRED_PASSING_AXES = 3;

const QUALITY_JUDGE_KIND = 'post_v2_quality_judge';

/**
 * Coerce any LLM-emitted score into a clamped int 0..5. Missing /
 * malformed values fall back to the threshold so the caller is forced
 * to make an explicit pass/fail decision via `pass`/`failureAxes`.
 */
function coerceScore(value: unknown): number {
  let n: number;
  if (typeof value === 'number' && Number.isFinite(value)) {
    n = Math.trunc(value);
  } else if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    n = Number.isFinite(parsed) ? Math.trunc(parsed) : QUALITY_PASS_THRESHOLD;
  } else {
    n = QUALITY_PASS_THRESHOLD;
  }
  if (n < QUALITY_SCORE_MIN) return QUALITY_SCORE_MIN;
  if (n > QUALITY_SCORE_MAX) return QUALITY_SCORE_MAX;
  return n;
}

/**
 * Best-effort JSON parse from an LLM response.
 *
 * Returns `{ payload, parsed }`:
 *  - `parsed=true`  if we extracted a JSON object (direct or fenced).
 *  - `parsed=false` if no JSON block was recoverable. The caller treats
 *    this as a non-retryable schema failure (re-prompting won't fix
 *    a model that ignores the JSON contract).
 */
function parseJudgePayload(raw: string): { payload: Record<string, unknown>; parsed: boolean } {
  const text = raw.trim();
  try {
    const direct = JSON.parse(text) as unknown;
    if (direct && typeof direct === 'object') {
      return { payload: direct as Record<string, unknown>, parsed: true };
    }
  } catch {
    // fall through
  }
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const block = JSON.parse(match[0]) as unknown;
      if (block && typeof block === 'object') {
        return { payload: block as Record<string, unknown>, parsed: true };
      }
    } catch {
      // fall through
    }
  }
  return { payload: {}, parsed: false };
}

/**
 * Build the prompt payload sent to the judge. We keep it minimal so
 * that prompt-engineering experiments live in `src/llm/prompts.ts`
 * (WO-FRESH-3) — this function only assembles structured fields.
 */
function buildJudgePayload(opts: { candidateText: string; account: AccountJson }): Record<string, unknown> {
  const voice = opts.account.voice_profile ?? {};
  return {
    candidate_text: opts.candidateText,
    axes: [...QUALITY_AXES],
    score_range: [QUALITY_SCORE_MIN, QUALITY_SCORE_MAX],
    pass_threshold: QUALITY_PASS_THRESHOLD,
    required_passing_axes: REQUIRED_PASSING_AXES,
    account_voice: {
      tone: voice.tone ?? '',
      first_person: voice.first_person ?? '',
      forbidden_tones: voice.forbidden_tones ?? [],
      register: voice.register ?? '',
    },
    contract: {
      return_json_keys: ['scores', 'comments', 'weakest_axis', 'regenerate_hint'],
      rules: [
        '5軸すべてを 0〜5 の整数で評価する',
        'stop_power: 1文目で読者の手が止まるか',
        'specificity: 一般論ではなく具体的な判断・体験・手順か',
        'progression: hook→主張→証拠→残り香 の流れが進んでいるか',
        'voice_match: account_voice.tone / forbidden_tones に整合しているか',
        'length_fit: 280字以内で自然に収まっているか',
      ],
    },
  };
}

/**
 * Normalize a parsed judge payload into a stable `QualityResult`.
 *
 * Failure axes = those whose score < QUALITY_PASS_THRESHOLD.
 * Pass = (5 − failureAxes.length) >= REQUIRED_PASSING_AXES.
 */
function normalize(parsed: Record<string, unknown>, raw: string): QualityResult {
  const rawScores = (parsed.scores ?? {}) as Record<string, unknown>;
  const rawComments = (parsed.comments ?? {}) as Record<string, unknown>;

  const scores: AxisScore[] = QUALITY_AXES.map((axis) => ({
    axis,
    score: coerceScore(rawScores[axis]),
    comment: typeof rawComments[axis] === 'string' ? (rawComments[axis] as string) : '',
  }));

  const failureAxes = scores.filter((s) => s.score < QUALITY_PASS_THRESHOLD).map((s) => s.axis);
  const passingCount = scores.length - failureAxes.length;
  const pass = passingCount >= REQUIRED_PASSING_AXES;

  const hint = typeof parsed.regenerate_hint === 'string' ? parsed.regenerate_hint : undefined;

  const result: QualityResult = {
    scores,
    pass,
    failureAxes,
    rawResponse: raw,
  };
  if (hint) {
    result.regenerateHint = hint;
  }
  return result;
}

/**
 * Run the 5-axis judge against a candidate.
 *
 * The LLM bridge call is wrapped so that a transport / parse error
 * produces a deterministic `pass: false, failureAxes: [...all]` result.
 * Caller can then route to `repairing` or `awaiting_decision`.
 *
 * `onJudged` is an optional side-channel for the judgment-event sink
 * (`{ kind: 'quality_judge_result', payload: { axes, pass } }`). It
 * must not throw — the judge swallows callback failures.
 */
export async function judgeQuality(opts: {
  candidateText: string;
  account: AccountJson;
  bridge: LlmProvider;
  onJudged?: (info: { result: QualityResult }) => void;
}): Promise<QualityResult> {
  const payload = buildJudgePayload({ candidateText: opts.candidateText, account: opts.account });

  let raw = '';
  let result: QualityResult;
  try {
    const response = await opts.bridge.generate({
      kind: QUALITY_JUDGE_KIND,
      payload,
    });
    raw = response.text ?? '';
    const { payload: parsed, parsed: didParse } = parseJudgePayload(raw);
    result = normalize(parsed, raw);
    if (!didParse) {
      // JSON parse failed. The model is misbehaving on the contract;
      // re-prompting from the same candidate will not help. Caller
      // should treat this as a "repair the candidate" path, not a retry.
      result = { ...result, retryable: false };
    }
  } catch (error: unknown) {
    // Transport / network / 5xx — transient. Caller may retry the
    // judge once before falling through to `repairing`.
    result = {
      scores: QUALITY_AXES.map((axis) => ({ axis, score: 0, comment: 'judge_error' })),
      pass: false,
      failureAxes: [...QUALITY_AXES],
      rawResponse: error instanceof Error ? `error: ${error.message}` : 'unknown_error',
      retryable: true,
    };
  }

  try {
    opts.onJudged?.({ result });
  } catch {
    // observability hooks never bubble up
  }
  return result;
}
