import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PendingTurnStore } from '../../../src/conversation/pending-turn-store.js';

describe('PendingTurnStore', () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mex-pending-turn-'));
    storePath = join(tempDir, 'pending.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('starts empty and lists nothing', () => {
    const store = new PendingTurnStore({ filePath: storePath });
    expect(store.listRecords()).toEqual([]);
    expect(store.getRecord('any')).toBeNull();
  });

  it('persists a record across instances', () => {
    const store1 = new PendingTurnStore({ filePath: storePath });
    store1.setRecord('thread-1', {
      replyChannelId: 'ch-1',
      accountId: 'zumi-x',
      requestedAt: '2026-05-02T10:00:00.000Z',
      kind: 'user-message',
    });
    expect(store1.getRecord('thread-1')?.replyChannelId).toBe('ch-1');

    // Re-open the store: the record must survive.
    const store2 = new PendingTurnStore({ filePath: storePath });
    const record = store2.getRecord('thread-1');
    expect(record).not.toBeNull();
    expect(record?.kind).toBe('user-message');
    expect(record?.accountId).toBe('zumi-x');
  });

  it('deletes a record (completion marking)', () => {
    const store = new PendingTurnStore({ filePath: storePath });
    store.setRecord('thread-x', {
      replyChannelId: 'ch-x',
      accountId: 'zumi-x',
      requestedAt: '2026-05-02T10:00:00.000Z',
      kind: 'user-message',
    });
    expect(store.getRecord('thread-x')).not.toBeNull();
    store.delete('thread-x');
    expect(store.getRecord('thread-x')).toBeNull();
    expect(store.listRecords()).toEqual([]);
  });

  it('writes valid JSON atomically', () => {
    const store = new PendingTurnStore({ filePath: storePath });
    store.setRecord('thread-1', {
      replyChannelId: 'ch-1',
      accountId: 'acct-1',
      requestedAt: '2026-05-02T10:00:00.000Z',
      kind: 'user-message',
    });
    expect(existsSync(storePath)).toBe(true);
    const raw = readFileSync(storePath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed['thread-1']).toMatchObject({
      conversationKey: 'thread-1',
      replyChannelId: 'ch-1',
    });
  });

  it('rejects records missing required fields via zod', () => {
    const store = new PendingTurnStore({ filePath: storePath });
    expect(() =>
      store.setRecord('thread-y', {
        replyChannelId: '',
        accountId: 'a',
        requestedAt: 'now',
        kind: 'user-message',
      }),
    ).toThrow();
  });

  it('survives a corrupt store file by treating it as empty', () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(storePath, 'not-json {{{');
    const store = new PendingTurnStore({ filePath: storePath });
    expect(store.listRecords()).toEqual([]);
  });
});
