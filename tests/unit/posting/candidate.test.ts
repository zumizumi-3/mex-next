import { describe, expect, it } from 'vitest';
import {
  type Candidate,
  type ValidateContextIndex,
  validateCandidate,
} from '../../../src/posting/candidate.js';

function makeCandidate(text: string): Candidate {
  return {
    id: 'cand_test',
    text,
    topic: 'topic_test',
    createdAt: '2026-05-02T00:00:00.000Z',
    status: 'draft',
  };
}

function makeContextIndex(overrides: Partial<ValidateContextIndex> = {}): ValidateContextIndex {
  return {
    recentMemory: {
      publishedPrefixes: [],
      scheduledPublishedPrefixes: [],
      failedTopics: [],
      ...overrides.recentMemory,
    },
    ...(overrides.account !== undefined ? { account: overrides.account } : {}),
  };
}

describe('validateCandidate', () => {
  it('passes a normal short post', () => {
    const result = validateCandidate({
      candidate: makeCandidate('今日も淡々と進める。具体的には朝一に整理して、午後に手を動かす。'),
      contextIndex: makeContextIndex(),
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('flags empty_text on whitespace-only body', () => {
    const result = validateCandidate({
      candidate: makeCandidate('   \n\t  '),
      contextIndex: makeContextIndex(),
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe('empty_text');
    // empty_text short-circuits other checks
    expect(result.errors).toHaveLength(1);
  });

  it('flags template_like on placeholder tokens', () => {
    const result = validateCandidate({
      candidate: makeCandidate('今日のテーマは zx_topic です。'),
      contextIndex: makeContextIndex(),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'template_like')).toBe(true);
  });

  it('flags template_like on known fallback phrases', () => {
    const result = validateCandidate({
      candidate: makeCandidate('気合いより順番。今日も静かに整える。'),
      contextIndex: makeContextIndex(),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'template_like')).toBe(true);
  });

  it('flags too_similar_recent on prefix collision', () => {
    const text = '朝の30分で1日の体感が変わる。先に紙で整理してから手を動かす方が早いと最近気付いた。';
    const prefix = text.replace(/\s+/g, ' ').trim().slice(0, 80);
    const result = validateCandidate({
      candidate: makeCandidate(text),
      contextIndex: makeContextIndex({
        recentMemory: {
          publishedPrefixes: [],
          scheduledPublishedPrefixes: [prefix],
          failedTopics: [],
        },
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'too_similar_recent')).toBe(true);
  });

  it('flags over_length on >280 char body', () => {
    const longText = 'あ'.repeat(281);
    const result = validateCandidate({
      candidate: makeCandidate(longText),
      contextIndex: makeContextIndex(),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'over_length')).toBe(true);
  });

  it('flags forbidden_token from account.risk_rules.manual_if_contains', () => {
    const result = validateCandidate({
      candidate: makeCandidate('今日は◯◯銀行の話をします。'),
      contextIndex: makeContextIndex({
        account: {
          risk_rules: { manual_if_contains: ['◯◯銀行'] },
        },
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'forbidden_token')).toBe(true);
  });

  it('does NOT mutate inputs', () => {
    const candidate = makeCandidate('普通に書ける本文です。');
    const ctx = makeContextIndex();
    const snapshotCandidate = JSON.stringify(candidate);
    const snapshotCtx = JSON.stringify(ctx);
    validateCandidate({ candidate, contextIndex: ctx });
    expect(JSON.stringify(candidate)).toBe(snapshotCandidate);
    expect(JSON.stringify(ctx)).toBe(snapshotCtx);
  });
});
