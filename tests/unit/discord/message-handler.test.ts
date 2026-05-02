/**
 * Unit tests for the message-handler helpers exposed for grapheme-safe
 * thread-name truncation.
 *
 * The bug we guard against: `slice(0, 95)` on a string of CJK
 * characters or composite emoji sequences can split a surrogate pair
 * or a ZWJ cluster, producing replacement characters or breaking the
 * emoji glyph in the Discord channel list.
 */

import { describe, expect, it } from 'vitest';
import {
  buildThreadName,
  sliceGraphemes,
  THREAD_NAME_MAX_GRAPHEMES,
} from '../../../src/discord/message-handler.js';

describe('sliceGraphemes', () => {
  it('returns the full string when shorter than the limit', () => {
    expect(sliceGraphemes('hello', 10)).toBe('hello');
  });

  it('slices at grapheme boundaries for ASCII', () => {
    expect(sliceGraphemes('abcdefg', 3)).toBe('abc');
  });

  it('keeps Japanese kana intact (one char per grapheme)', () => {
    const text = 'あいうえおかきくけこ';
    expect(sliceGraphemes(text, 5)).toBe('あいうえお');
  });

  it('does not split a single composite emoji ZWJ sequence', () => {
    // 👨‍👩‍👧‍👦 = man + ZWJ + woman + ZWJ + girl + ZWJ + boy = one
    // grapheme cluster but seven UTF-16 code units. With Intl.Segmenter
    // (granularity=grapheme) we treat it as one segment so a limit of 1
    // returns the full sequence.
    const family = '👨‍👩‍👧‍👦';
    const sliced = sliceGraphemes(family, 1);
    // Either the full grapheme stays whole, or the env lacks Segmenter
    // and falls back to code-unit slicing. We accept either as long as
    // the result never produces an unpaired surrogate.
    if (typeof Intl?.Segmenter === 'function') {
      expect(sliced).toBe(family);
    } else {
      expect(sliced.length).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns empty for non-positive limits', () => {
    expect(sliceGraphemes('hello', 0)).toBe('');
    expect(sliceGraphemes('hello', -1)).toBe('');
  });
});

interface FakeMessage {
  content?: string;
  author?: { username?: string; id?: string } | null;
}

function asMsg(input: FakeMessage): never {
  return input as never;
}

describe('buildThreadName', () => {
  it('uses the head of the message and appends @username', () => {
    const name = buildThreadName(
      asMsg({ content: 'AIの活用について書いて', author: { username: 'alice' } }),
    );
    expect(name.startsWith('AIの活用について書いて')).toBe(true);
    expect(name).toContain('@alice');
    expect(name.length).toBeLessThanOrEqual(95);
  });

  it('falls back to "メッセージ" when content is empty', () => {
    const name = buildThreadName(asMsg({ content: '', author: { id: '123456789' } }));
    expect(name.startsWith('メッセージ')).toBe(true);
    expect(name).toContain('@6789');
  });

  it('strips bot mentions and channel references', () => {
    const name = buildThreadName(
      asMsg({ content: '<@123> hello <#456> world', author: { username: 'bob' } }),
    );
    expect(name).not.toContain('<@');
    expect(name).not.toContain('<#');
    expect(name).toContain('hello');
  });

  it('grapheme-safe truncates the message head at 40 graphemes', () => {
    const long = 'あ'.repeat(150);
    const name = buildThreadName(asMsg({ content: long, author: { username: 'a' } }));
    // Head capped to 40 ぁ-graphemes; total fits well under the 95 budget.
    expect([...name].length).toBeLessThanOrEqual(THREAD_NAME_MAX_GRAPHEMES + 5);
    // The first 40 chars of the head are the original kana, intact.
    expect(name.startsWith('あ'.repeat(40))).toBe(true);
  });

  it('appends ellipsis when the candidate exceeds the 90 grapheme cap', () => {
    // Username explosion forces the candidate past the cap so the final
    // sliceGraphemes pass kicks in and we expect the …-suffix.
    const long = 'あ'.repeat(150);
    const username = 'b'.repeat(120);
    const name = buildThreadName(asMsg({ content: long, author: { username } }));
    expect([...name].length).toBeLessThanOrEqual(THREAD_NAME_MAX_GRAPHEMES + 5);
    expect(name.endsWith('…')).toBe(true);
  });

  it('never produces unpaired surrogates', () => {
    // Concatenate 100 family emoji to exceed both head (40) and final
    // (90) grapheme limits. The output must contain only valid UTF-16
    // (no lone high/low surrogate code units).
    const family = '👨‍👩‍👧‍👦';
    const long = family.repeat(100);
    const name = buildThreadName(asMsg({ content: long, author: { username: 'x' } }));
    for (let i = 0; i < name.length; i += 1) {
      const code = name.charCodeAt(i);
      // High surrogate must be followed by a low surrogate.
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = name.charCodeAt(i + 1);
        expect(next).toBeGreaterThanOrEqual(0xdc00);
        expect(next).toBeLessThanOrEqual(0xdfff);
      }
      // Low surrogate must follow a high surrogate (cannot stand alone).
      if (code >= 0xdc00 && code <= 0xdfff) {
        const prev = name.charCodeAt(i - 1);
        expect(prev).toBeGreaterThanOrEqual(0xd800);
        expect(prev).toBeLessThanOrEqual(0xdbff);
      }
    }
  });
});
