import { describe, expect, it } from 'vitest';
import {
  ACTIVE_STATES,
  POSTING_STATES,
  TERMINAL_STATES,
  VALID_TRANSITIONS,
  assertTransition,
  canTransition,
  isActive,
  isTerminal,
} from '../../../src/posting/states.js';

describe('posting states', () => {
  it('exposes 11 distinct states', () => {
    expect(POSTING_STATES.length).toBe(11);
    expect(new Set(POSTING_STATES).size).toBe(POSTING_STATES.length);
  });

  it('active and terminal sets are disjoint (no state is both)', () => {
    // Note: `scheduled` is in NEITHER set — it's a waiting-room state
    // (queued in publish_queue, waiting for the scheduler to publish
    // or fail). It's neither active-customer-facing nor terminal.
    for (const state of POSTING_STATES) {
      const active = ACTIVE_STATES.has(state);
      const terminal = TERMINAL_STATES.has(state);
      expect(active && terminal).toBe(false);
    }
    expect(ACTIVE_STATES.has('scheduled')).toBe(false);
    expect(TERMINAL_STATES.has('scheduled')).toBe(false);
  });

  it('terminal states have no outbound transitions', () => {
    for (const t of TERMINAL_STATES) {
      expect(VALID_TRANSITIONS[t]).toEqual([]);
    }
  });

  it('active states all have at least one transition to failed_terminal', () => {
    for (const a of ACTIVE_STATES) {
      expect(VALID_TRANSITIONS[a]).toContain('failed_terminal');
    }
  });

  it('canTransition allows happy path created → indexing_context → generating', () => {
    expect(canTransition('created', 'indexing_context')).toBe(true);
    expect(canTransition('indexing_context', 'generating')).toBe(true);
    expect(canTransition('generating', 'validating')).toBe(true);
    expect(canTransition('validating', 'awaiting_decision')).toBe(true);
    expect(canTransition('awaiting_decision', 'scheduled')).toBe(true);
    expect(canTransition('scheduled', 'published')).toBe(true);
  });

  it('canTransition rejects illegal jumps', () => {
    expect(canTransition('created', 'scheduled')).toBe(false);
    expect(canTransition('created', 'published')).toBe(false);
    expect(canTransition('published', 'failed_terminal')).toBe(false);
    expect(canTransition('expired', 'scheduled')).toBe(false);
  });

  it('assertTransition throws on illegal transition', () => {
    expect(() => assertTransition('created', 'published')).toThrow(/invalid posting transition/);
  });

  it('isActive / isTerminal helpers agree with the sets', () => {
    expect(isActive('created')).toBe(true);
    expect(isTerminal('published')).toBe(true);
    expect(isActive('published')).toBe(false);
    expect(isTerminal('created')).toBe(false);
  });
});
