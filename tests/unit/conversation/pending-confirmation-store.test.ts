/**
 * pending-confirmation-store unit tests.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyConfirmationReply,
  createPendingConfirmationStore,
} from '../../../src/conversation/pending-confirmation-store.js';

describe('createPendingConfirmationStore', () => {
  it('round-trips an entry through set / get / delete', () => {
    const store = createPendingConfirmationStore();
    store.set({
      conversationKey: 'c1',
      intent: 'system.update',
      args: {},
      promptShown: 'really?',
    });
    const got = store.get('c1');
    expect(got?.intent).toBe('system.update');
    store.delete('c1');
    expect(store.get('c1')).toBeNull();
  });

  it('expires entries after the TTL', () => {
    let now = 1_000;
    const store = createPendingConfirmationStore({ ttlMs: 100, now: () => now });
    store.set({
      conversationKey: 'c1',
      intent: 'schedule.cancel',
      args: {},
      promptShown: 'really?',
    });
    now = 1_050;
    expect(store.get('c1')?.intent).toBe('schedule.cancel');
    now = 1_200;
    expect(store.get('c1')).toBeNull();
  });

  it('replaces on second set for the same conversationKey', () => {
    const store = createPendingConfirmationStore();
    store.set({
      conversationKey: 'c1',
      intent: 'system.update',
      args: {},
      promptShown: 'a',
    });
    store.set({
      conversationKey: 'c1',
      intent: 'cadence.skip_today',
      args: {},
      promptShown: 'b',
    });
    expect(store.get('c1')?.intent).toBe('cadence.skip_today');
  });

  it('round-trips a tool pending entry', () => {
    const store = createPendingConfirmationStore();
    store.set({
      conversationKey: 'c1',
      pendingTool: { name: 'cancel_publish_items', input: { scope: 'all' } },
      promptShown: 'really?',
    });
    expect(store.get('c1')?.pendingTool).toEqual({
      name: 'cancel_publish_items',
      input: { scope: 'all' },
    });
  });
});

describe('classifyConfirmationReply', () => {
  it('treats a clear yes as affirmative', () => {
    expect(classifyConfirmationReply('はい、お願いします')).toBe('affirmative');
    expect(classifyConfirmationReply('はい')).toBe('affirmative');
    expect(classifyConfirmationReply('yes')).toBe('affirmative');
    expect(classifyConfirmationReply('OK')).toBe('affirmative');
    expect(classifyConfirmationReply('お願いします')).toBe('affirmative');
    expect(classifyConfirmationReply('やって')).toBe('affirmative');
    expect(classifyConfirmationReply('進めて')).toBe('affirmative');
    expect(classifyConfirmationReply('実行')).toBe('affirmative');
  });

  it('treats a clear no as negative', () => {
    expect(classifyConfirmationReply('いいえ')).toBe('negative');
    expect(classifyConfirmationReply('やめて')).toBe('negative');
    expect(classifyConfirmationReply('キャンセル')).toBe('negative');
    expect(classifyConfirmationReply('やっぱりやめる')).toBe('negative');
    expect(classifyConfirmationReply('no')).toBe('negative');
  });

  it('returns ambiguous for unrelated messages', () => {
    expect(classifyConfirmationReply('予約見せて')).toBe('ambiguous');
    expect(classifyConfirmationReply('')).toBe('ambiguous');
    expect(classifyConfirmationReply('うーん')).toBe('ambiguous');
  });
});
