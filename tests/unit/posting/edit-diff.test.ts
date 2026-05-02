import { describe, expect, it } from 'vitest';
import { computeEditDiff } from '../../../src/posting/edit-diff.js';

describe('computeEditDiff', () => {
  it('returns empty hunks (only context) for identical input', () => {
    const diff = computeEditDiff('hello', 'hello');
    expect(diff.summary.noop).toBe(true);
    expect(diff.summary.addedLines).toBe(0);
    expect(diff.summary.removedLines).toBe(0);
  });

  it('detects pure addition', () => {
    const diff = computeEditDiff('a\nb', 'a\nb\nc');
    expect(diff.summary.addedLines).toBe(1);
    expect(diff.summary.removedLines).toBe(0);
    expect(diff.summary.charDelta).toBe(2);
    const added = diff.hunks.find((h) => h.kind === 'added');
    expect(added?.text).toBe('c');
  });

  it('detects pure removal', () => {
    const diff = computeEditDiff('a\nb\nc', 'a\nc');
    expect(diff.summary.addedLines).toBe(0);
    expect(diff.summary.removedLines).toBe(1);
    const removed = diff.hunks.find((h) => h.kind === 'removed');
    expect(removed?.text).toBe('b');
  });

  it('detects substitution as remove+add', () => {
    const diff = computeEditDiff('hello\nworld', 'hello\nfriend');
    expect(diff.summary.addedLines).toBe(1);
    expect(diff.summary.removedLines).toBe(1);
    expect(diff.summary.contextLines).toBe(1);
  });

  it('is deterministic — same input → same output', () => {
    const a = computeEditDiff('one\ntwo\nthree', 'one\ntwo prime\nthree');
    const b = computeEditDiff('one\ntwo\nthree', 'one\ntwo prime\nthree');
    expect(a).toEqual(b);
  });

  it('records charDelta correctly for trim', () => {
    const diff = computeEditDiff('long original text', 'short final');
    expect(diff.summary.charDelta).toBe('short final'.length - 'long original text'.length);
    expect(diff.summary.noop).toBe(false);
  });

  it('does not mutate input strings', () => {
    const original = 'a\nb';
    const final = 'a\nb\nc';
    computeEditDiff(original, final);
    // strings are immutable in JS but we verify the property holds
    expect(original).toBe('a\nb');
    expect(final).toBe('a\nb\nc');
  });
});
