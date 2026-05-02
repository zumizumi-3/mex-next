/**
 * Prompt template smoke tests.
 *
 * We do not assert exact prompt wording (that would make tuning prompts
 * a chore); we only assert that every kind has a non-empty prompt and
 * that the intent classifier prompt contains the load-bearing keywords
 * (intent vocabulary, JSON contract, confirmation rules).
 */

import { describe, it, expect } from 'vitest';

import { ALL_LLM_KINDS } from '../../../src/llm/kinds.js';
import {
  buildIntentUserPrompt,
  INTENT_CLASSIFY_SYSTEM,
  INTENT_FEW_SHOTS,
  KIND_SYSTEM_PROMPT,
  SUPPORTED_INTENT_NAMES,
} from '../../../src/llm/prompts.js';

describe('KIND_SYSTEM_PROMPT', () => {
  it('every LlmKind has a non-empty system prompt', () => {
    for (const kind of ALL_LLM_KINDS) {
      const prompt = KIND_SYSTEM_PROMPT[kind];
      expect(prompt, `prompt for ${kind}`).toBeTruthy();
      expect(prompt.length, `prompt for ${kind} length`).toBeGreaterThan(40);
    }
  });

  it('quality judge mentions all 5 axes', () => {
    const prompt = KIND_SYSTEM_PROMPT.post_v2_quality_judge;
    for (const axis of [
      'stop_power',
      'specificity',
      'progression',
      'voice_match',
      'length_fit',
    ]) {
      expect(prompt).toContain(axis);
    }
  });

  it('retrospective prompt mentions every horizon', () => {
    const prompt = KIND_SYSTEM_PROMPT.periodic_retrospective_generate;
    for (const horizon of ['daily', 'weekly', 'monthly', 'quarterly', 'half']) {
      expect(prompt).toContain(horizon);
    }
  });

  it('plan writeback diff prompt mentions every target', () => {
    const prompt = KIND_SYSTEM_PROMPT.plan_writeback_diff;
    for (const target of ['active_window', 'goal_stack', 'brand', 'half_focus']) {
      expect(prompt).toContain(target);
    }
  });

  it('inbound risk prompt mentions every risk bucket', () => {
    const prompt = KIND_SYSTEM_PROMPT.inbound_risk_classify;
    for (const bucket of ['low_risk', 'medium_risk', 'high_risk']) {
      expect(prompt).toContain(bucket);
    }
  });
});

describe('INTENT_CLASSIFY_SYSTEM', () => {
  it('lists every supported intent', () => {
    for (const name of SUPPORTED_INTENT_NAMES) {
      expect(INTENT_CLASSIFY_SYSTEM).toContain(name);
    }
  });

  it('demands a single JSON object output', () => {
    expect(INTENT_CLASSIFY_SYSTEM.toLowerCase()).toContain('json');
    expect(INTENT_CLASSIFY_SYSTEM).toMatch(/no markdown/i);
  });

  it('describes destructive vs display confirmation rules', () => {
    expect(INTENT_CLASSIFY_SYSTEM).toMatch(/confirmation/i);
    expect(INTENT_CLASSIFY_SYSTEM).toContain('schedule.cancel');
    expect(INTENT_CLASSIFY_SYSTEM).toContain('schedule.list');
  });
});

describe('buildIntentUserPrompt', () => {
  it('includes few-shot examples and the user text', () => {
    const out = buildIntentUserPrompt('予約見せて');
    expect(out).toContain('予約見せて');
    expect(out).toContain('Examples');
    expect(out).toContain('JSON:');
  });

  it('every few-shot example references a supported intent', () => {
    for (const ex of INTENT_FEW_SHOTS) {
      expect(SUPPORTED_INTENT_NAMES).toContain(ex.result.intent);
    }
  });

  it('trims whitespace from user input', () => {
    const out = buildIntentUserPrompt('   予約見せて   ');
    expect(out).toContain('User: 予約見せて');
    expect(out).not.toContain('User:    予約見せて');
  });
});
