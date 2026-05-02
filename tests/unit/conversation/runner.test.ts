/**
 * Conversation runner — bypass keyword unit tests.
 *
 * The full IntentDrivenRunner is exercised by integration tests; here we
 * pin down the onboarding bypass keyword sets so we don't accidentally
 * lose coverage when refactoring the wizard escape hatches.
 */

import { describe, expect, it } from 'vitest';
import {
  ONBOARDING_CANCEL_KEYWORDS,
  ONBOARDING_CANCEL_KEYWORDS_LOWER,
  ONBOARDING_STATUS_KEYWORDS,
  ONBOARDING_STATUS_KEYWORDS_LOWER,
} from '../../../src/conversation/runner.js';

describe('ONBOARDING_CANCEL_KEYWORDS', () => {
  it('includes the original five entries', () => {
    expect(ONBOARDING_CANCEL_KEYWORDS.has('やめる')).toBe(true);
    expect(ONBOARDING_CANCEL_KEYWORDS.has('中止')).toBe(true);
    expect(ONBOARDING_CANCEL_KEYWORDS.has('オンボーディング中止')).toBe(true);
    expect(ONBOARDING_CANCEL_KEYWORDS.has('オンボやめる')).toBe(true);
    expect(ONBOARDING_CANCEL_KEYWORDS_LOWER.has('cancel')).toBe(true);
  });

  it('adds the new conversational variants', () => {
    expect(ONBOARDING_CANCEL_KEYWORDS.has('やめたい')).toBe(true);
    expect(ONBOARDING_CANCEL_KEYWORDS.has('終わる')).toBe(true);
    expect(ONBOARDING_CANCEL_KEYWORDS.has('終わりたい')).toBe(true);
    expect(ONBOARDING_CANCEL_KEYWORDS.has('ストップ')).toBe(true);
    expect(ONBOARDING_CANCEL_KEYWORDS_LOWER.has('stop')).toBe(true);
  });

  it('does not accidentally swallow common answers', () => {
    expect(ONBOARDING_CANCEL_KEYWORDS.has('はい')).toBe(false);
    expect(ONBOARDING_CANCEL_KEYWORDS.has('いいえ')).toBe(false);
    expect(ONBOARDING_CANCEL_KEYWORDS.has('わかりません')).toBe(false);
  });
});

describe('ONBOARDING_STATUS_KEYWORDS', () => {
  it('includes the original entries', () => {
    expect(ONBOARDING_STATUS_KEYWORDS.has('状態')).toBe(true);
    expect(ONBOARDING_STATUS_KEYWORDS.has('進捗')).toBe(true);
    expect(ONBOARDING_STATUS_KEYWORDS.has('今どこ')).toBe(true);
    expect(ONBOARDING_STATUS_KEYWORDS_LOWER.has('status')).toBe(true);
  });

  it('adds the new natural-language status queries', () => {
    expect(ONBOARDING_STATUS_KEYWORDS.has('いまどこ')).toBe(true);
    expect(ONBOARDING_STATUS_KEYWORDS.has('どこまで進んだ')).toBe(true);
    expect(ONBOARDING_STATUS_KEYWORDS.has('いまの状況')).toBe(true);
    expect(ONBOARDING_STATUS_KEYWORDS.has('やり直し')).toBe(true);
  });

  it('cancel and status sets do not overlap', () => {
    for (const kw of ONBOARDING_STATUS_KEYWORDS) {
      expect(ONBOARDING_CANCEL_KEYWORDS.has(kw)).toBe(false);
    }
    for (const kw of ONBOARDING_STATUS_KEYWORDS_LOWER) {
      expect(ONBOARDING_CANCEL_KEYWORDS_LOWER.has(kw)).toBe(false);
    }
  });
});
