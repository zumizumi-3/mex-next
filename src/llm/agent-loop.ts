/**
 * Primary conversation path: one-shot structured output from the LLM.
 * The prompt includes a read-only state snapshot so list/status requests do not need tools.
 * Destructive tool calls pause through pending approval before execution.
 * Malformed or unsupported model output falls back to the legacy intent router.
 */

import type { Logger } from 'pino';
import type { HandlerContext } from '../handlers/types.js';
import type { ToolSpec } from '../handlers/tool-specs.js';
import { AGENT_RESPONSE_SCHEMA } from '../handlers/tool-specs.js';
import { executeTool } from './tool-executor.js';
import type { LlmKind } from './kinds.js';
import type { LlmProvider } from './bridge.js';

export interface AgentStateSnapshot {
  queue: {
    today_active: number;
    past_active: number;
    total_active: number;
    samples: Array<{
      publish_id: string;
      scheduled_at: string;
      status: string;
      preview: string;
    }>;
  };
  automation: {
    enabled: boolean;
    cadence: 'light' | 'standard' | 'aggressive';
    skip_dates: string[];
  };
  targets: Array<{ handle: string }>;
  onboarding: {
    active: boolean;
    current_question_id: string | null;
  };
  account: {
    account_id: string;
    display_name: string;
  };
}

export interface AgentLoopOptions {
  bridge: LlmProvider;
  llmKind?: LlmKind;
  systemPrompt: string;
  toolSpecs: ToolSpec[];
  stateSnapshot: AgentStateSnapshot;
  handlerContext: HandlerContext;
  userMessage: string;
  /** Confirmation-pending destructive call from the previous turn. */
  pendingApproval?: { toolName: string; toolInput: Record<string, unknown> };
  /** Recent conversation transcript for context. */
  transcript?: Array<{ role: 'user' | 'assistant'; content: string }>;
  abortSignal?: AbortSignal;
  logger: Logger;
}

export interface AgentLoopResult {
  /** Final assistant text. */
  reply: string;
  /** If destructive tool was about to fire but waited for approval. */
  awaitingApproval?: { toolName: string; toolInput: Record<string, unknown>; promptShown: string };
  /** Tool call audit trail. */
  trace: Array<{ tool: string; input: unknown; outputSummary: string }>;
  /** Fallback for defensive coverage gaps, e.g. model requested an unknown tool. */
  fallbackToLegacy?: boolean;
  fallbackReason?: 'unknown_tool' | 'invalid_json' | 'invalid_shape';
}

interface AgentStructuredResponse {
  reply: string;
  tool_call: null | { name: string; input?: unknown };
  needs_confirmation: boolean;
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  if (opts.abortSignal?.aborted) {
    throw new Error('agent loop aborted before LLM call');
  }

  const response = await opts.bridge.call({
    kind: opts.llmKind ?? 'agent_turn',
    systemPrompt: opts.systemPrompt,
    userPrompt: buildAgentUserPrompt(opts),
    jsonSchema: AGENT_RESPONSE_SCHEMA,
  });

  if (opts.abortSignal?.aborted) {
    throw new Error('agent loop aborted after LLM call');
  }

  const blockText = extractJsonBlock(response.text);
  if (!blockText) {
    opts.logger.warn(
      { preview: response.text.slice(0, 200) },
      'agent_loop_no_json_block',
    );
    return {
      reply: '',
      trace: [],
      fallbackToLegacy: true,
      fallbackReason: 'invalid_json',
    };
  }

  let parsed: AgentStructuredResponse;
  try {
    parsed = JSON.parse(blockText) as AgentStructuredResponse;
  } catch (err) {
    opts.logger.warn(
      {
        error: err instanceof Error ? err.message : String(err),
        preview: blockText.slice(0, 200),
      },
      'agent_loop_json_parse_failed',
    );
    return {
      reply: '',
      trace: [],
      fallbackToLegacy: true,
      fallbackReason: 'invalid_json',
    };
  }

  if (typeof parsed !== 'object' || parsed === null || typeof parsed.reply !== 'string') {
    opts.logger.warn({ shape: typeof parsed }, 'agent_loop_invalid_shape');
    return {
      reply: '',
      trace: [],
      fallbackToLegacy: true,
      fallbackReason: 'invalid_shape',
    };
  }

  if (parsed.tool_call !== null && parsed.tool_call !== undefined) {
    if (typeof parsed.tool_call !== 'object' || typeof parsed.tool_call.name !== 'string') {
      opts.logger.warn({ toolCallShape: typeof parsed.tool_call }, 'agent_loop_invalid_shape');
      return {
        reply: parsed.reply || '',
        trace: [],
        fallbackToLegacy: true,
        fallbackReason: 'invalid_shape',
      };
    }
  }

  const reply = typeof parsed.reply === 'string' && parsed.reply.trim()
    ? parsed.reply.trim()
    : 'すみません、うまく返答を作れませんでした。';

  if (!parsed.tool_call) {
    return { reply, trace: [] };
  }

  const specsByName = new Map(opts.toolSpecs.map((spec) => [spec.name, spec]));
  const spec = specsByName.get(parsed.tool_call.name);
  if (!spec) {
    opts.logger.warn({ toolName: parsed.tool_call.name }, 'agent_loop_unknown_tool');
    return { reply: '', trace: [], fallbackToLegacy: true, fallbackReason: 'unknown_tool' };
  }

  const toolInput = asRecord(parsed.tool_call.input);
  const needsApproval = spec.destructive && !approvalMatches(opts.pendingApproval, spec.name, toolInput);
  if (needsApproval) {
    return {
      reply,
      awaitingApproval: {
        toolName: spec.name,
        toolInput,
        promptShown: reply,
      },
      trace: [],
    };
  }

  const result = await executeTool(spec, toolInput, opts.handlerContext);
  const output = result.ok ? result.output : JSON.stringify({ ok: false, error: result.error });
  const trace = [
    {
      tool: spec.name,
      input: toolInput,
      outputSummary: summarizeOutput(output),
    },
  ];

  return {
    reply: result.ok ? reply : `${reply}\n${result.error}`.trim(),
    trace,
  };
}

function extractJsonBlock(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    const inner = fence[1].trim();
    if (inner.startsWith('{') && inner.endsWith('}')) return inner;
  }

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) {
    return trimmed.slice(first, last + 1);
  }
  return null;
}

function buildAgentUserPrompt(opts: AgentLoopOptions): string {
  const transcript = (opts.transcript ?? [])
    .filter((turn) => turn.content.trim().length > 0)
    .map((turn) => `${turn.role}: ${turn.content}`)
    .join('\n');
  const pendingApprovalNote = opts.pendingApproval
    ? [
        '前回保留した destructive tool が承認待ちです。',
        `toolName: ${opts.pendingApproval.toolName}`,
        `toolInput: ${JSON.stringify(opts.pendingApproval.toolInput)}`,
        'ユーザが肯定している場合は同じ tool_call を返してください。',
      ].join('\n')
    : '承認待ち tool はありません。';

  return [
    `現在の state: ${JSON.stringify(opts.stateSnapshot)}`,
    '',
    `会話直前:\n${transcript || '(なし)'}`,
    '',
    pendingApprovalNote,
    '',
    `ユーザ: ${opts.userMessage}`,
  ].join('\n');
}

function asRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }
  return input as Record<string, unknown>;
}

function approvalMatches(
  pending: AgentLoopOptions['pendingApproval'],
  toolName: string,
  toolInput: Record<string, unknown>,
): boolean {
  return (
    pending?.toolName === toolName &&
    stableStringify(pending.toolInput) === stableStringify(toolInput)
  );
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    return `{${Object.keys(rec)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(rec[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function summarizeOutput(output: string): string {
  const oneLine = output.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= 200) return oneLine;
  return `${oneLine.slice(0, 197)}...`;
}
