/**
 * LLM bridge type surface.
 *
 * The full bridge (claude_code subprocess + Anthropic SDK) is provided by
 * `src/llm/bridge.ts` in WO-FRESH-3. Here we declare the minimum types so
 * domain modules (posting / retrospective / writeback) can depend on the
 * abstract `LlmProvider` interface and be tested with mocks.
 */

export type LlmKind =
  | 'post_v2_generate'
  | 'post_v2_quality_judge'
  | 'post_v2_repair'
  | 'post_v2_revise'
  | 'intent_classify'
  | 'intent_classify_confirmation'
  | 'inbound_risk_classify'
  | 'inbound_reply_draft'
  | 'quote_v2_generate'
  | 'quote_v2_edit'
  | 'periodic_retrospective_generate'
  | 'periodic_retrospective_apply'
  | 'plan_writeback_diff'
  | 'plan_writeback_apply';

export interface LlmCallInput {
  kind: LlmKind;
  systemPrompt: string;
  userPrompt: string;
  /** Free-form metadata for logging / observability. */
  meta?: Record<string, unknown>;
}

export interface LlmCallResult {
  kind: LlmKind;
  text: string;
  /** Optional structured payload parsed from the model output. */
  json?: unknown;
}

export interface LlmProvider {
  call(input: LlmCallInput): Promise<LlmCallResult>;
}
