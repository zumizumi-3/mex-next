import type Anthropic from '@anthropic-ai/sdk';
import type { Logger } from 'pino';
import type { HandlerContext } from '../handlers/types.js';
import type { ToolSpec } from '../handlers/tool-specs.js';
import { executeTool } from './tool-executor.js';

export interface AgentLoopOptions {
  anthropic: Anthropic;
  model: string;
  systemPrompt: string;
  toolSpecs: ToolSpec[];
  handlerContext: HandlerContext;
  userMessage: string;
  /** Confirmation-pending destructive call from the previous turn. */
  pendingApproval?: { toolName: string; toolInput: Record<string, unknown> };
  /** Recent conversation transcript for context. */
  transcript?: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxIterations?: number;
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
  usage: { input: number; output: number };
  /** Fallback for defensive coverage gaps, e.g. model requested an unknown tool. */
  fallbackToLegacy?: boolean;
  fallbackReason?: 'unknown_tool';
}

type ToolUseBlock = Anthropic.ToolUseBlock;
type MessageParam = Anthropic.MessageParam;

const DEFAULT_MAX_ITERATIONS = 6;
const DEFAULT_MAX_TOKENS = 1000;

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const specsByName = new Map(opts.toolSpecs.map((spec) => [spec.name, spec]));
  const tools = opts.toolSpecs.map(toAnthropicTool);
  const messages = buildInitialMessages(opts);
  const trace: AgentLoopResult['trace'] = [];
  const usage = { input: 0, output: 0 };
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const response = await opts.anthropic.messages.create(
      {
        model: opts.model,
        max_tokens: DEFAULT_MAX_TOKENS,
        system: opts.systemPrompt,
        messages,
        tools,
        tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      },
      { signal: opts.abortSignal ?? null },
    );
    usage.input += response.usage?.input_tokens ?? 0;
    usage.output += response.usage?.output_tokens ?? 0;

    if (response.stop_reason === 'end_turn') {
      const reply = extractText(response.content);
      return { reply: reply || 'すみません、うまく返答を作れませんでした。', trace, usage };
    }

    if (response.stop_reason === 'max_tokens' || response.stop_reason === 'stop_sequence') {
      return {
        reply: '⚠️ 途中で応答が止まりました。もう一度、短めに指示してください。',
        trace,
        usage,
      };
    }

    if (response.stop_reason !== 'tool_use') {
      return {
        reply: '⚠️ うまく判断できませんでした。もう一度言い換えてください。',
        trace,
        usage,
      };
    }

    const toolUses = response.content.filter((block): block is ToolUseBlock => {
      return block.type === 'tool_use';
    });
    if (toolUses.length === 0) {
      return {
        reply: '⚠️ tool 呼び出しを読み取れませんでした。もう一度言い換えてください。',
        trace,
        usage,
      };
    }

    const firstDestructive = toolUses.find((toolUse) => {
      const spec = specsByName.get(toolUse.name);
      return spec?.destructive === true;
    });
    if (firstDestructive) {
      const spec = specsByName.get(firstDestructive.name);
      if (!spec) {
        opts.logger.warn({ toolName: firstDestructive.name }, 'agent_loop_unknown_tool');
        return { reply: '', trace, usage, fallbackToLegacy: true, fallbackReason: 'unknown_tool' };
      }
      const toolInput = asRecord(firstDestructive.input);
      if (!approvalMatches(opts.pendingApproval, firstDestructive.name, toolInput)) {
        const promptShown = await buildApprovalPrompt({
          textFromModel: extractText(response.content),
          spec,
          toolInput,
          ctx: opts.handlerContext,
        });
        return {
          reply: promptShown,
          awaitingApproval: { toolName: firstDestructive.name, toolInput, promptShown },
          trace,
          usage,
        };
      }
    }

    messages.push({
      role: 'assistant',
      content: response.content.map(toMessageContentBlock),
    });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      const spec = specsByName.get(toolUse.name);
      if (!spec) {
        opts.logger.warn({ toolName: toolUse.name }, 'agent_loop_unknown_tool');
        return { reply: '', trace, usage, fallbackToLegacy: true, fallbackReason: 'unknown_tool' };
      }
      const toolInput = asRecord(toolUse.input);
      const result = await executeTool(spec, toolInput, opts.handlerContext);
      const output = result.ok
        ? result.output
        : JSON.stringify({ ok: false, error: result.error });
      trace.push({
        tool: spec.name,
        input: toolInput,
        outputSummary: summarizeOutput(output),
      });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: output,
        ...(result.ok ? {} : { is_error: true }),
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return {
    reply: '⚠️ 処理が長くなりすぎました。もう一度、対象を絞って指示してください。',
    trace,
    usage,
  };
}

function buildInitialMessages(opts: AgentLoopOptions): MessageParam[] {
  const messages: MessageParam[] = [];
  for (const turn of opts.transcript ?? []) {
    if (!turn.content.trim()) continue;
    messages.push({ role: turn.role, content: turn.content });
  }
  messages.push({ role: 'user', content: opts.userMessage });
  if (opts.pendingApproval) {
    messages.push({
      role: 'assistant',
      content: `承認されました。前回保留した ${opts.pendingApproval.toolName} を実行してください。`,
    });
  }
  return messages;
}

function toAnthropicTool(spec: ToolSpec): Anthropic.Tool {
  return {
    name: spec.name,
    description: spec.description,
    input_schema: spec.inputSchema,
  };
}

function toMessageContentBlock(
  block: Anthropic.ContentBlock,
): Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam {
  if (block.type === 'text') {
    return { type: 'text', text: block.text };
  }
  return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
}

function extractText(blocks: Anthropic.ContentBlock[]): string {
  return blocks
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
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

async function buildApprovalPrompt(input: {
  textFromModel: string;
  spec: ToolSpec;
  toolInput: Record<string, unknown>;
  ctx: HandlerContext;
}): Promise<string> {
  if (input.textFromModel.trim()) {
    return input.textFromModel.trim();
  }
  const summary = input.spec.summarize
    ? await input.spec.summarize(input.toolInput, input.ctx)
    : '対象';
  switch (input.spec.name) {
    case 'publish_now':
      return `${summary}を今すぐ投稿します。実行しますか?`;
    case 'cancel_publish_items':
      return `${summary}を取り消します。実行しますか?`;
    case 'add_target_handle':
      return `@${String(input.toolInput.handle ?? '').replace(/^@/, '')} を追跡対象に追加します。実行しますか?`;
    case 'remove_target_handle':
      return `@${String(input.toolInput.handle ?? '').replace(/^@/, '')} を追跡対象から外します。実行しますか?`;
    case 'enable_all_automation':
      return '自動運用を一括 ON にします。実行しますか?';
    case 'skip_today':
      return '今日の予約をスキップします。実行しますか?';
    case 'set_cadence':
      return `投稿ペースを ${String(input.toolInput.level ?? '')} に変更します。実行しますか?`;
    case 'start_onboarding':
      return '33 問オンボーディングを開始します。実行しますか?';
    case 'cancel_onboarding':
      return '進行中のオンボーディングを中断します。実行しますか?';
    case 'run_seed':
      return '投稿 draft の一括生成を開始します。実行しますか?';
    case 'run_training':
      return '過去投稿の取り込みと voice 学習を開始します。実行しますか?';
    case 'start_phase_questionnaire':
      return 'phase questionnaire を開始します。実行しますか?';
    case 'run_system_update':
      return 'mex bot の自己更新を開始します。実行しますか?';
    case 'regenerate_knowledge':
      return 'knowledge files を再生成します。実行しますか?';
    default:
      return `${summary}を変更します。実行しますか?`;
  }
}

function summarizeOutput(output: string): string {
  const compact = output.replace(/\s+/g, ' ').trim();
  return compact.length > 160 ? `${compact.slice(0, 160)}…` : compact;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
