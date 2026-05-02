/**
 * Intent router contract tests.
 *
 * The router must:
 * - Classify Japanese phrasings into structured intents
 * - Force confirmation on destructive intents (even if LLM said no)
 * - Force NO confirmation on display intents (even if LLM said yes)
 * - Return `unknown` gracefully on JSON parse failure / timeout / etc.
 *
 * The LLM is mocked end-to-end. We never hit the real API.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  classifyIntent,
  DESTRUCTIVE_INTENTS,
  DISPLAY_INTENTS,
} from '../../../src/conversation/intent-router.js';
import type { LlmProvider } from '../../../src/llm/bridge.js';
import { LlmTimeoutError } from '../../../src/llm/bridge.js';
import { INTENT_FEW_SHOTS } from '../../../src/llm/prompts.js';

function makeBridge(text: string): LlmProvider {
  return {
    call: vi.fn().mockResolvedValue({
      text,
      usage: { input: 0, output: 0 },
    }),
  };
}

function makeFailingBridge(err: Error): LlmProvider {
  return { call: vi.fn().mockRejectedValue(err) };
}

describe('classifyIntent — happy path', () => {
  it('「予約見せて」→ schedule.list / no confirmation', async () => {
    const bridge = makeBridge(
      JSON.stringify({ intent: 'schedule.list', args: {}, confirmation_needed: false }),
    );
    const result = await classifyIntent({ userText: '予約見せて', bridge });
    expect(result.intent).toBe('schedule.list');
    expect(result.confirmationNeeded).toBe(false);
    expect(result.args).toEqual({});
  });

  it('「6:18のやつ取り消して」→ schedule.cancel / confirmation forced', async () => {
    const bridge = makeBridge(
      JSON.stringify({
        intent: 'schedule.cancel',
        args: { time_hint: '06:18' },
        confirmation_needed: true,
        confirmation_message: '06:18 の予約を取り消しますか？',
      }),
    );
    const result = await classifyIntent({ userText: '6:18のやつ取り消して', bridge });
    expect(result.intent).toBe('schedule.cancel');
    expect(result.confirmationNeeded).toBe(true);
    expect(result.args.time_hint).toBe('06:18');
    expect(result.confirmationMessage).toContain('取り消');
  });

  it('「@user 追加」→ target.add / no confirmation, handle stripped of @', async () => {
    const bridge = makeBridge(
      JSON.stringify({
        intent: 'target.add',
        args: { handle: '@tanaka_san' },
        confirmation_needed: false,
      }),
    );
    const result = await classifyIntent({
      userText: '@tanaka_san をターゲットに追加して',
      bridge,
    });
    expect(result.intent).toBe('target.add');
    expect(result.confirmationNeeded).toBe(false);
    expect(result.args.handle).toBe('tanaka_san');
  });

  it('「今日いらない」→ cadence.skip_today / confirmation forced', async () => {
    const bridge = makeBridge(
      JSON.stringify({ intent: 'cadence.skip_today', args: {}, confirmation_needed: true }),
    );
    const result = await classifyIntent({ userText: '今日は投稿しない', bridge });
    expect(result.intent).toBe('cadence.skip_today');
    expect(result.confirmationNeeded).toBe(true);
    expect(result.confirmationMessage).toBeTruthy();
  });

  it('post.create with topic preserves topic arg', async () => {
    const bridge = makeBridge(
      JSON.stringify({
        intent: 'post.create',
        args: { topic: 'AIの活用' },
        confirmation_needed: false,
      }),
    );
    const result = await classifyIntent({ userText: 'AIの活用について書いて', bridge });
    expect(result.intent).toBe('post.create');
    expect(result.args.topic).toBe('AIの活用');
  });

  it('status.show is a display intent → no confirmation', async () => {
    const bridge = makeBridge(
      JSON.stringify({ intent: 'status.show', args: {}, confirmation_needed: false }),
    );
    const result = await classifyIntent({ userText: '今の状態確認', bridge });
    expect(result.intent).toBe('status.show');
    expect(result.confirmationNeeded).toBe(false);
  });

  it('help.show works', async () => {
    const bridge = makeBridge(
      JSON.stringify({ intent: 'help.show', args: {}, confirmation_needed: false }),
    );
    const result = await classifyIntent({ userText: '使い方教えて', bridge });
    expect(result.intent).toBe('help.show');
    expect(result.confirmationNeeded).toBe(false);
  });

  it('「knowledge を再生成して」→ system.regenerate_knowledge / confirmation forced', async () => {
    const bridge = makeBridge(
      JSON.stringify({
        intent: 'system.regenerate_knowledge',
        args: {},
        confirmation_needed: false,
      }),
    );
    const result = await classifyIntent({ userText: 'knowledge を再生成して', bridge });
    expect(result.intent).toBe('system.regenerate_knowledge');
    expect(result.confirmationNeeded).toBe(true);
    expect(result.confirmationMessage).toContain('knowledge files');
  });
});

describe('classifyIntent — safety overrides (LLM hallucination)', () => {
  it('forces confirmation=true on destructive intents even if LLM said false', async () => {
    const bridge = makeBridge(
      JSON.stringify({
        intent: 'schedule.cancel',
        args: { time_hint: '06:18' },
        confirmation_needed: false, // LLM hallucinated "no need" — must be forced to true
      }),
    );
    const result = await classifyIntent({ userText: '6:18 取り消し', bridge });
    expect(result.confirmationNeeded).toBe(true);
    expect(result.confirmationMessage).toBeTruthy();
  });

  it('forces confirmation=true on automation.enable_all even if LLM said false', async () => {
    const bridge = makeBridge(
      JSON.stringify({
        intent: 'automation.enable_all',
        args: {},
        confirmation_needed: false,
      }),
    );
    const result = await classifyIntent({ userText: '全部 ON にして', bridge });
    expect(result.confirmationNeeded).toBe(true);
  });

  it('forces confirmation=true on target.remove even if LLM said false', async () => {
    const bridge = makeBridge(
      JSON.stringify({
        intent: 'target.remove',
        args: { handle: 'foo' },
        confirmation_needed: false,
      }),
    );
    const result = await classifyIntent({ userText: '@foo はずして', bridge });
    expect(result.confirmationNeeded).toBe(true);
    expect(result.confirmationMessage).toContain('foo');
  });

  it('forces confirmation=false on display intents even if LLM said true', async () => {
    const bridge = makeBridge(
      JSON.stringify({
        intent: 'schedule.list',
        args: {},
        confirmation_needed: true, // LLM hallucinated "are you sure?" on a list — must be forced to false
        confirmation_message: '本当に？',
      }),
    );
    const result = await classifyIntent({ userText: '予約見せて', bridge });
    expect(result.confirmationNeeded).toBe(false);
    expect(result.confirmationMessage).toBeUndefined();
  });

  it('every member of DESTRUCTIVE_INTENTS produces confirmationNeeded=true', async () => {
    for (const intent of DESTRUCTIVE_INTENTS) {
      const bridge = makeBridge(JSON.stringify({ intent, args: {}, confirmation_needed: false }));
      const result = await classifyIntent({ userText: 'x', bridge });
      expect(result.confirmationNeeded, `intent=${intent}`).toBe(true);
    }
  });

  it('every member of DISPLAY_INTENTS produces confirmationNeeded=false', async () => {
    for (const intent of DISPLAY_INTENTS) {
      const bridge = makeBridge(JSON.stringify({ intent, args: {}, confirmation_needed: true }));
      const result = await classifyIntent({ userText: 'x', bridge });
      expect(result.confirmationNeeded, `intent=${intent}`).toBe(false);
    }
  });
});

describe('classifyIntent — fallbacks', () => {
  it('returns unknown on JSON parse failure', async () => {
    const bridge = makeBridge('not json at all');
    const result = await classifyIntent({ userText: '何か', bridge });
    expect(result.intent).toBe('unknown');
    expect(result.fallbackReason).toBe('invalid_json');
    expect(result.userMessage).toBeTruthy();
    expect(result.rawResponse).toBe('not json at all');
  });

  it('returns unknown on timeout', async () => {
    const bridge = makeFailingBridge(new LlmTimeoutError('timed out'));
    const result = await classifyIntent({ userText: '何か', bridge });
    expect(result.intent).toBe('unknown');
    expect(result.fallbackReason).toBe('timeout');
    expect(result.userMessage).toBeTruthy();
  });

  it('returns unknown on provider error', async () => {
    const bridge = makeFailingBridge(new Error('socket hangup'));
    const result = await classifyIntent({ userText: '何か', bridge });
    expect(result.intent).toBe('unknown');
    expect(result.fallbackReason).toBe('provider_error');
  });

  it('returns unknown on empty input', async () => {
    const bridge = makeBridge(
      JSON.stringify({ intent: 'schedule.list', args: {}, confirmation_needed: false }),
    );
    const result = await classifyIntent({ userText: '   ', bridge });
    expect(result.intent).toBe('unknown');
    expect(result.fallbackReason).toBe('empty_input');
    // bridge should not have been called
    expect(bridge.call).not.toHaveBeenCalled();
  });

  it('returns unknown when LLM emits an unsupported intent name', async () => {
    const bridge = makeBridge(
      JSON.stringify({ intent: 'launch.nuclear_codes', args: {}, confirmation_needed: false }),
    );
    const result = await classifyIntent({ userText: 'fire it up', bridge });
    expect(result.intent).toBe('unknown');
    expect(result.fallbackReason).toBe('unsupported_intent');
  });

  it('strips markdown code fences from LLM output', async () => {
    const bridge = makeBridge(
      '```json\n{"intent":"schedule.list","args":{},"confirmation_needed":false}\n```',
    );
    const result = await classifyIntent({ userText: '予約見せて', bridge });
    expect(result.intent).toBe('schedule.list');
  });
});

describe('INTENT_FEW_SHOTS coverage', () => {
  it('contains examples for seed.run / training.run / phase.questionnaire_* / regenerate knowledge', () => {
    const intents = new Set(INTENT_FEW_SHOTS.map((ex) => ex.result.intent));
    expect(intents.has('seed.run')).toBe(true);
    expect(intents.has('training.run')).toBe(true);
    expect(intents.has('phase.questionnaire_start')).toBe(true);
    expect(intents.has('phase.questionnaire_status')).toBe(true);
    expect(intents.has('system.regenerate_knowledge')).toBe(true);
  });
});

describe('classifyIntent — new few-shot intents (seed/training/phase)', () => {
  it('routes seed.run with count when LLM extracts it', async () => {
    const bridge = makeBridge(
      JSON.stringify({
        intent: 'seed.run',
        args: { count: 7 },
        confirmation_needed: false,
      }),
    );
    const result = await classifyIntent({ userText: '投稿案を 7 本作って', bridge });
    expect(result.intent).toBe('seed.run');
    expect(result.confirmationNeeded).toBe(false);
    expect(result.args.count).toBe(7);
  });

  it('routes training.run with no args', async () => {
    const bridge = makeBridge(
      JSON.stringify({
        intent: 'training.run',
        args: {},
        confirmation_needed: false,
      }),
    );
    const result = await classifyIntent({ userText: '過去投稿を学習', bridge });
    expect(result.intent).toBe('training.run');
    expect(result.confirmationNeeded).toBe(false);
  });

  it('routes phase.questionnaire_start with cadence=monthly', async () => {
    const bridge = makeBridge(
      JSON.stringify({
        intent: 'phase.questionnaire_start',
        args: { cadence: 'monthly' },
        confirmation_needed: false,
      }),
    );
    const result = await classifyIntent({ userText: '月次アンケート', bridge });
    expect(result.intent).toBe('phase.questionnaire_start');
    expect(result.confirmationNeeded).toBe(false);
    expect(result.args.cadence).toBe('monthly');
  });

  it('routes phase.questionnaire_status with no args', async () => {
    const bridge = makeBridge(
      JSON.stringify({
        intent: 'phase.questionnaire_status',
        args: {},
        confirmation_needed: false,
      }),
    );
    const result = await classifyIntent({ userText: 'アンケート状況', bridge });
    expect(result.intent).toBe('phase.questionnaire_status');
    expect(result.confirmationNeeded).toBe(false);
  });
});

describe('classifyIntent — arg normalization', () => {
  it('strips invalid time_hint on schedule.cancel', async () => {
    const bridge = makeBridge(
      JSON.stringify({
        intent: 'schedule.cancel',
        args: { time_hint: 'not-a-time' },
        confirmation_needed: true,
      }),
    );
    const result = await classifyIntent({ userText: 'x', bridge });
    expect(result.args.time_hint).toBeUndefined();
  });

  it('zero-pads single-digit hour in time_hint to HH:MM', async () => {
    const bridge = makeBridge(
      JSON.stringify({
        intent: 'schedule.cancel',
        args: { time_hint: '6:18' },
        confirmation_needed: true,
      }),
    );
    const result = await classifyIntent({ userText: 'x', bridge });
    expect(result.args.time_hint).toBe('06:18');
  });

  it('caps post.create topic to 120 chars', async () => {
    const longTopic = 'あ'.repeat(200);
    const bridge = makeBridge(
      JSON.stringify({
        intent: 'post.create',
        args: { topic: longTopic },
        confirmation_needed: false,
      }),
    );
    const result = await classifyIntent({ userText: 'x', bridge });
    expect((result.args.topic as string).length).toBe(120);
  });

  it('drops unknown scope on schedule.cancel', async () => {
    const bridge = makeBridge(
      JSON.stringify({
        intent: 'schedule.cancel',
        args: { scope: 'all_history_forever' },
        confirmation_needed: true,
      }),
    );
    const result = await classifyIntent({ userText: 'x', bridge });
    expect(result.args.scope).toBeUndefined();
  });
});
