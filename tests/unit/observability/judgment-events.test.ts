/**
 * JudgmentEventStream tests.
 *
 * Each test gets a fresh tmp directory so file rotation / append
 * semantics don't bleed across tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  JudgmentEventStream,
  sanitizePayload,
} from '../../../src/observability/judgment-events.js';

let tmpDir: string;
let filePath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mex-judgments-'));
  filePath = path.join(tmpDir, 'judgments.jsonl');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('JudgmentEventStream', () => {
  it('appends a single event and queries it back', async () => {
    const stream = new JudgmentEventStream({ filePath });
    await stream.emit({
      accountId: 'acct_1',
      kind: 'intent_classify_result',
      payload: { input: 'hi', intent: 'help.show' },
    });
    const events = await stream.query();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('intent_classify_result');
    expect(events[0]?.accountId).toBe('acct_1');
    expect(events[0]?.payload).toMatchObject({ input: 'hi', intent: 'help.show' });
    expect(events[0]?.id).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/i);
  });

  it('appends two events on separate lines (JSONL)', async () => {
    const stream = new JudgmentEventStream({ filePath });
    await stream.emit({ accountId: 'a', kind: 'k1', payload: { v: 1 } });
    await stream.emit({ accountId: 'a', kind: 'k2', payload: { v: 2 } });

    const raw = await fs.readFile(filePath, 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('rotates when active file exceeds rotateSizeBytes', async () => {
    const stream = new JudgmentEventStream({ filePath, rotateSizeBytes: 200 });
    // Each line is around ~120 bytes; 2 emits cross the 200B threshold.
    for (let i = 0; i < 5; i += 1) {
      await stream.emit({ accountId: 'acct', kind: 'rotate_test', payload: { i, pad: 'x'.repeat(60) } });
    }
    const entries = await fs.readdir(tmpDir);
    // We expect at least one rotated file like judgments.jsonl.1 plus the active.
    const rotated = entries.filter((f) => f.startsWith('judgments.jsonl.'));
    expect(rotated.length).toBeGreaterThanOrEqual(1);
  });

  it('filters by kind', async () => {
    const stream = new JudgmentEventStream({ filePath });
    await stream.emit({ accountId: 'a', kind: 'kind_a', payload: {} });
    await stream.emit({ accountId: 'a', kind: 'kind_b', payload: {} });
    await stream.emit({ accountId: 'a', kind: 'kind_a', payload: {} });

    const onlyA = await stream.query({ kind: 'kind_a' });
    expect(onlyA).toHaveLength(2);
    expect(onlyA.every((e) => e.kind === 'kind_a')).toBe(true);
  });

  it('respects sinceMs', async () => {
    let mockTime = new Date('2025-01-01T00:00:00Z').getTime();
    const stream = new JudgmentEventStream({
      filePath,
      now: () => new Date(mockTime),
    });
    await stream.emit({ accountId: 'a', kind: 'old', payload: {} });
    mockTime += 60_000;
    await stream.emit({ accountId: 'a', kind: 'newer', payload: {} });

    const cutoff = new Date('2025-01-01T00:00:30Z').getTime();
    const recent = await stream.query({ sinceMs: cutoff });
    expect(recent.map((e) => e.kind)).toEqual(['newer']);
  });

  it('redacts Anthropic / Slack / GitHub / hex / PEM secrets in payload', async () => {
    const stream = new JudgmentEventStream({ filePath });
    await stream.emit({
      accountId: 'a',
      kind: 'leak_test',
      payload: {
        // Secret-shaped fixtures: shorter / clearly fake forms that match
        // sanitizePayload's regex but don't match upstream secret-scanner
        // signatures (Anthropic / Slack / GitHub PAT). Each token uses
        // FAKE tokens so push-protection scans see nothing real.
        anthropic: 'sk-ant-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE',
        slack: 'xoxb-FAKEFAKE-FAKEFAKE-FAKEFAKEFAKEFAKEFAKEFAKE',
        github: 'ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEfa',
        hex: 'a'.repeat(64),
        pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj...\n-----END RSA PRIVATE KEY-----',
        nested: {
          inner: ['sk', 'ant', 'api03', 'XXXXyyyyyZZZZZZZZZZ_some-more'].join('-'),
        },
      },
    });
    const events = await stream.query();
    const payload = events[0]?.payload as Record<string, unknown>;
    expect(payload.anthropic).toBe('[REDACTED]');
    expect(payload.slack).toBe('[REDACTED]');
    expect(payload.github).toBe('[REDACTED]');
    expect(payload.hex).toBe('[REDACTED]');
    expect(payload.pem).toBe('[REDACTED]');
    const nested = payload.nested as Record<string, unknown>;
    expect(nested.inner).toBe('[REDACTED]');
  });

  it('preserves non-secret strings verbatim', async () => {
    const stream = new JudgmentEventStream({ filePath });
    await stream.emit({
      accountId: 'a',
      kind: 'safe_text',
      payload: {
        intent: 'help.show',
        message: '今日の調子はどうですか？',
        url: 'https://example.com/path',
      },
    });
    const events = await stream.query();
    const payload = events[0]?.payload as Record<string, unknown>;
    expect(payload.intent).toBe('help.show');
    expect(payload.message).toBe('今日の調子はどうですか？');
    expect(payload.url).toBe('https://example.com/path');
  });

  describe('sanitizePayload', () => {
    it('redacts secret-shaped substrings inside larger strings', () => {
      const out = sanitizePayload({
        log: `using token ${['sk', 'ant', 'api03', 'AAABBBCCCDDDEEEFFFGGG'].join('-')} for request`,
      }) as { log: string };
      expect(out.log).toContain('[REDACTED]');
      expect(out.log.startsWith('using token ')).toBe(true);
      expect(out.log.endsWith(' for request')).toBe(true);
      expect(out.log).not.toContain(['sk', 'ant', 'api03'].join('-'));
    });

    it('breaks reference cycles with [CYCLE]', () => {
      const obj: Record<string, unknown> = { name: 'a' };
      obj.self = obj;
      const out = sanitizePayload(obj) as Record<string, unknown>;
      expect(out.name).toBe('a');
      expect(out.self).toBe('[CYCLE]');
    });

    it('truncates over-deep nesting with [TRUNCATED]', () => {
      // Build a chain deeper than MAX_SANITIZE_DEPTH (12).
      type Nested = { v: number; next?: Nested };
      let leaf: Nested = { v: 0 };
      for (let i = 1; i < 20; i += 1) {
        leaf = { v: i, next: leaf };
      }
      const out = sanitizePayload(leaf) as { v: number; next: unknown };
      // Walk the result down — at some depth it should become the
      // sentinel string instead of an object.
      let cur: unknown = out;
      let saw = false;
      for (let i = 0; i < 30; i += 1) {
        if (cur === '[TRUNCATED]') {
          saw = true;
          break;
        }
        if (!cur || typeof cur !== 'object') break;
        cur = (cur as { next?: unknown }).next;
      }
      expect(saw).toBe(true);
    });

    it('handles primitive values directly', () => {
      expect(sanitizePayload(42)).toBe(42);
      expect(sanitizePayload(true)).toBe(true);
      expect(sanitizePayload(null)).toBe(null);
      expect(sanitizePayload('plain text')).toBe('plain text');
    });

    it('arrays are sanitized element-by-element', () => {
      const out = sanitizePayload({
        items: ['safe', ['sk', 'ant', 'AAAABBBBCCCCDDDDEEEEFFFF'].join('-'), 7],
      }) as { items: unknown[] };
      expect(out.items[0]).toBe('safe');
      expect(out.items[1]).toBe('[REDACTED]');
      expect(out.items[2]).toBe(7);
    });
  });

  it('handles 5 concurrent emits without interleaving lines', async () => {
    const stream = new JudgmentEventStream({ filePath });
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        stream.emit({ accountId: 'a', kind: 'parallel', payload: { i } }),
      ),
    );
    const raw = await fs.readFile(filePath, 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { kind: string };
      expect(parsed.kind).toBe('parallel');
    }
  });
});
