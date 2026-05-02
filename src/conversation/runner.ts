/**
 * IntentDrivenRunner — concrete implementation of the
 * `ConversationRunner` interface required by `turn-orchestrator.ts`.
 *
 * Per turn:
 *   1. classify intent via the LLM bridge
 *   2. if confirmation is needed → return a confirmation prompt as
 *      the turn output (the runner does NOT block on a button — that
 *      is left to the higher-level interaction handler in MeX's
 *      simplified UX, which surfaces the confirm card via the natural
 *      reply rather than ephemeral interaction)
 *   3. otherwise → dispatch to the matching handler
 *   4. respect AbortSignal — handlers that are running when abort
 *      fires are not interrupted, but the runner short-circuits before
 *      dispatching if abort is signaled
 */

import { classifyIntent, type IntentResult } from './intent-router.js';
import {
  type ConversationRunner,
  type StatusCallback,
  type TurnResult,
} from './turn-orchestrator.js';
import { TurnCancelledError } from './turn-cancellation.js';
import type { TurnMessage } from './turn-message.js';
import type { HandlerContext, HandlersMap, HandlerArgs } from '../handlers/types.js';
import type { LlmProvider } from '../llm/bridge.js';
import { OnboardingCollector } from '../onboarding/collector.js';
import { applyFreeFormAnswer } from '../handlers/onboarding.js';

export interface IntentDrivenRunnerOptions {
  bridge: LlmProvider;
  handlers: HandlersMap;
  handlerContext: HandlerContext;
}

export class IntentDrivenRunner implements ConversationRunner {
  private readonly bridge: LlmProvider;
  private readonly handlers: HandlersMap;
  private readonly handlerContext: HandlerContext;

  constructor(opts: IntentDrivenRunnerOptions) {
    this.bridge = opts.bridge;
    this.handlers = opts.handlers;
    this.handlerContext = opts.handlerContext;
  }

  async run(input: {
    readonly conversationKey: string;
    readonly accountId: string;
    readonly turnId: string;
    readonly message: TurnMessage;
    readonly abortSignal: AbortSignal;
    readonly onStatus?: StatusCallback;
  }): Promise<TurnResult> {
    const { abortSignal, message, turnId, onStatus } = input;
    if (abortSignal.aborted) {
      throw new TurnCancelledError({ turnId, reason: 'aborted_before_start' });
    }
    await safeStatus(onStatus, '🧭 意図を解釈中…');

    const userText = message.content.trim();
    if (!userText) {
      return { output: '何か書いてください。' };
    }

    // Onboarding bypass: when an active onboarding session exists, take
    // the customer's raw text as the answer to the current question
    // instead of running the intent classifier.
    try {
      const collector = new OnboardingCollector({
        repo: this.handlerContext.repo,
        bridge: this.bridge,
        logger: this.handlerContext.logger,
      });
      const active = await collector.getActive();
      if (active) {
        const lower = userText.toLowerCase();
        const wantsCancel =
          userText === 'やめる' ||
          userText === '中止' ||
          lower === 'cancel' ||
          userText === 'オンボーディング中止' ||
          userText === 'オンボやめる';
        const wantsStatus =
          userText === '状態' ||
          userText === '進捗' ||
          lower === 'status' ||
          userText === '今どこ' ||
          userText === '今どこまで';
        if (!wantsCancel && !wantsStatus) {
          const reply = await applyFreeFormAnswer(this.handlerContext, active, userText);
          return {
            output: reply,
            metadata: {
              intent: 'onboard.answer',
              session_id: active.id,
              question_id: active.currentQuestionId,
            },
          };
        }
      }
    } catch (error) {
      this.handlerContext.logger.warn?.(
        { error: error instanceof Error ? error.message : String(error) },
        'onboarding_bypass_failed',
      );
    }

    const judgmentEvents = this.handlerContext.judgmentEvents;
    const accountId = this.handlerContext.accountId;
    const intent: IntentResult = await classifyIntent({
      userText,
      bridge: this.bridge,
      onClassified: judgmentEvents
        ? ({ input, result }): void => {
            void judgmentEvents
              .emit({
                accountId,
                kind: 'intent_classify_result',
                payload: {
                  input,
                  intent: result.intent,
                  confirmationNeeded: result.confirmationNeeded,
                  fallbackReason: result.fallbackReason ?? null,
                },
              })
              .catch(() => undefined);
          }
        : undefined,
    });

    if (abortSignal.aborted) {
      throw new TurnCancelledError({ turnId, reason: 'aborted_after_intent' });
    }

    if (intent.confirmationNeeded) {
      const message =
        intent.confirmationMessage ??
        '実行してよろしいですか？「はい」と書いていただければ実行します。';
      return {
        output: message,
        metadata: { intent: intent.intent, args: intent.args, awaitingConfirmation: true },
      };
    }

    return this.dispatch(intent, onStatus);
  }

  /**
   * Dispatch a non-confirmation-required intent to its handler.
   * Public so slash command / interaction routes can re-use it.
   */
  async dispatch(intent: IntentResult, onStatus?: StatusCallback): Promise<TurnResult> {
    await safeStatus(onStatus, '⚙️ 実行中…');
    const handler = this.handlers[intent.intent] ?? this.handlers['unknown'];
    if (!handler) {
      return { output: '内部エラー: handler が見つかりません。' };
    }
    const args: HandlerArgs =
      intent.intent === 'unknown'
        ? { ...(intent.args ?? {}), userMessage: intent.userMessage ?? '' }
        : intent.args;
    try {
      const result = await handler(this.handlerContext, args);
      return {
        output: result.content,
        ...(result.silent ? { suppressReply: true } : {}),
        metadata: { intent: intent.intent, tag: result.tag ?? null },
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        output: `❌ 実行に失敗しました: ${detail}`,
        metadata: { intent: intent.intent, error: detail },
      };
    }
  }
}

async function safeStatus(cb: StatusCallback | undefined, status: string): Promise<void> {
  if (!cb) return;
  try {
    await cb(status);
  } catch {
    // status callbacks are advisory; ignore their failures
  }
}

