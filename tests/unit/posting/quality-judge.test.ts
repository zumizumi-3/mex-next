import { describe, expect, it, vi } from 'vitest';
import {
  QUALITY_AXES,
  QUALITY_PASS_THRESHOLD,
  REQUIRED_PASSING_AXES,
  judgeQuality,
} from '../../../src/posting/quality-judge.js';
import type { LlmProvider } from '../../../src/posting/types.js';

function mockBridge(responseText: string): LlmProvider {
  return {
    generate: vi.fn(async () => ({ text: responseText })),
  };
}

function judgeResponse(scores: Partial<Record<string, number>>, hint = 'もっと具体例を1つ'): string {
  return JSON.stringify({
    scores: {
      stop_power: 4,
      specificity: 4,
      progression: 4,
      voice_match: 4,
      length_fit: 4,
      ...scores,
    },
    weakest_axis: 'stop_power',
    regenerate_hint: hint,
  });
}

const ACCOUNT = {
  display_name: 'tester',
  voice_profile: { tone: 'calm', first_person: '私', forbidden_tones: [] },
};

describe('judgeQuality', () => {
  it('marks pass when all 5 axes score >= threshold', async () => {
    const bridge = mockBridge(judgeResponse({}));
    const result = await judgeQuality({
      candidateText: '今日は淡々と書く。',
      account: ACCOUNT,
      bridge,
    });
    expect(result.pass).toBe(true);
    expect(result.failureAxes).toEqual([]);
    expect(result.scores).toHaveLength(QUALITY_AXES.length);
    expect(result.regenerateHint).toBe('もっと具体例を1つ');
  });

  it('marks pass when exactly REQUIRED_PASSING_AXES (3 of 5) pass', async () => {
    const bridge = mockBridge(
      judgeResponse({
        stop_power: 4,
        specificity: 4,
        progression: 4,
        voice_match: 1,
        length_fit: 1,
      }),
    );
    const result = await judgeQuality({ candidateText: 't', account: ACCOUNT, bridge });
    expect(result.pass).toBe(true);
    expect(result.failureAxes).toEqual(['voice_match', 'length_fit']);
  });

  it('marks fail when fewer than REQUIRED_PASSING_AXES pass', async () => {
    const bridge = mockBridge(
      judgeResponse({
        stop_power: 4,
        specificity: 4,
        progression: 1,
        voice_match: 1,
        length_fit: 1,
      }),
    );
    const result = await judgeQuality({ candidateText: 't', account: ACCOUNT, bridge });
    expect(result.pass).toBe(false);
    expect(result.failureAxes.length).toBeGreaterThanOrEqual(QUALITY_AXES.length - REQUIRED_PASSING_AXES + 1);
  });

  it('clamps out-of-range scores into 0..5', async () => {
    const bridge = mockBridge(
      JSON.stringify({
        scores: { stop_power: 99, specificity: -3, progression: 4, voice_match: 4, length_fit: 4 },
      }),
    );
    const result = await judgeQuality({ candidateText: 't', account: ACCOUNT, bridge });
    const stop = result.scores.find((s) => s.axis === 'stop_power')!;
    const spec = result.scores.find((s) => s.axis === 'specificity')!;
    expect(stop.score).toBe(5);
    expect(spec.score).toBe(0);
  });

  it('parses JSON wrapped in fenced code blocks', async () => {
    const fenced = '```json\n' + judgeResponse({}) + '\n```';
    const bridge = mockBridge(fenced);
    const result = await judgeQuality({ candidateText: 't', account: ACCOUNT, bridge });
    expect(result.pass).toBe(true);
  });

  it('returns deterministic fail when bridge throws', async () => {
    const bridge: LlmProvider = {
      generate: vi.fn(async () => {
        throw new Error('llm down');
      }),
    };
    const result = await judgeQuality({ candidateText: 't', account: ACCOUNT, bridge });
    expect(result.pass).toBe(false);
    expect(result.failureAxes).toEqual([...QUALITY_AXES]);
    expect(result.scores.every((s) => s.score === 0)).toBe(true);
  });

  it('marks retryable=true when bridge throws (transient transport error)', async () => {
    const bridge: LlmProvider = {
      generate: vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    };
    const result = await judgeQuality({ candidateText: 't', account: ACCOUNT, bridge });
    expect(result.pass).toBe(false);
    expect(result.retryable).toBe(true);
  });

  it('marks retryable=false when JSON parse fails (schema-level failure)', async () => {
    // Pure prose response with no `{...}` block at all → unparseable.
    const bridge = mockBridge('judge declined to score');
    const result = await judgeQuality({ candidateText: 't', account: ACCOUNT, bridge });
    expect(result.retryable).toBe(false);
  });

  it('omits retryable on a normal pass (only set on failures)', async () => {
    const bridge = mockBridge(judgeResponse({}));
    const result = await judgeQuality({ candidateText: 't', account: ACCOUNT, bridge });
    expect(result.pass).toBe(true);
    expect(result.retryable).toBeUndefined();
  });

  it('falls back to threshold for missing scores (still fails since others are missing too)', async () => {
    const bridge = mockBridge(JSON.stringify({ scores: {} }));
    const result = await judgeQuality({ candidateText: 't', account: ACCOUNT, bridge });
    // All axes default to threshold, which is the pass cutoff (>=).
    expect(result.scores.every((s) => s.score === QUALITY_PASS_THRESHOLD)).toBe(true);
    expect(result.pass).toBe(true);
  });
});
