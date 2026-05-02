/**
 * post.create handler.
 *
 * Triggers the Posting v2 state machine:
 *   createSession → indexContext → generateCandidate → validateCurrent
 *
 * On `awaiting_decision` we surface the draft to the customer; on
 * `repairing` (validate / judge fail) we surface a brief diagnostic so
 * they can reword the topic.
 */

import type { HandlerContext, HandlerResult, HandlerArgs } from './types.js';
import { PostingStateMachine } from '../posting/state-machine.js';
import { asPostingMachineRepo } from './repo-adapter.js';
import type { LlmProvider as PostingLlmProvider } from '../posting/types.js';

export async function handlePostCreate(
  ctx: HandlerContext,
  args: HandlerArgs,
): Promise<HandlerResult> {
  const topic = String(args.topic ?? '').trim() || undefined;
  // PostingStateMachine internals require an `LlmProvider` interface
  // from posting/types.ts (with `.generate`). The real bridge (llm/bridge)
  // exposes `.call`. We adapt here.
  const adaptedBridge: PostingLlmProvider = {
    async generate(opts) {
      const userPrompt = JSON.stringify(opts.payload);
      const response = await ctx.bridge.call({
        kind: opts.kind as never,
        userPrompt,
      });
      return { text: response.text, raw: response.raw };
    },
  };
  const machine = new PostingStateMachine({
    repo: asPostingMachineRepo(ctx.repo),
    bridge: adaptedBridge,
    logger: ctx.logger,
  });

  let session;
  try {
    session = await machine.createSession(topic);
    session = await machine.indexContext(session.id);
    session = await machine.generateCandidate(session.id);
    session = await machine.validateCurrent(session.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: `❌ 投稿生成に失敗しました: ${message}`,
      tag: 'post.create.fail',
    };
  }

  const candidate = session.candidates[session.currentCandidateIndex];
  if (!candidate) {
    return { content: '⚠️ 候補が生成されませんでした。', tag: 'post.create.no_candidate' };
  }

  if (session.state === 'awaiting_decision') {
    const lines = [
      `✏️ ドラフト案 (\`${session.id}\`)`,
      '',
      candidate.text,
      '',
      '_どうしますか？_ 「予約して」「もう一度」「やめる」のいずれかで返してください。',
    ];
    return { content: lines.join('\n'), tag: 'post.create.awaiting_decision' };
  }

  if (session.state === 'repairing') {
    const errs = candidate.validateResult?.errors ?? [];
    const codeLines = errs.map((e) => `- ${e.code}: ${e.message}`);
    return {
      content: ['⚠️ 自動チェックで引っかかりました:', ...codeLines, '', '別の切り口で書き直してください。'].join('\n'),
      tag: 'post.create.repairing',
    };
  }

  return {
    content: `セッション \`${session.id}\` は ${session.state} 状態です。`,
    tag: 'post.create.other',
  };
}
