import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ApprovalStore,
  buildApprovalCustomId,
  buildApprovalMessagePayload,
  parseApprovalCustomId,
} from '../../../src/discord/approval.js';

describe('ApprovalStore', () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mex-approval-'));
    storePath = join(tempDir, 'approvals.jsonl');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates a pending approval and finds it again', () => {
    const store = new ApprovalStore({ filePath: storePath });
    const created = store.createApproval({
      capabilityId: 'schedule.cancel',
      accountId: 'zumi-x',
      requestedByDiscordUserId: 'user-1',
      conversationKey: 'thread-1',
      payloadPreview: 'topic=...',
    });
    expect(created.status).toBe('pending');
    expect(store.getApproval(created.approvalId)).not.toBeNull();
    expect(store.listPending().length).toBe(1);
  });

  it('marks approve and is idempotent', () => {
    const store = new ApprovalStore({ filePath: storePath });
    const created = store.createApproval({
      capabilityId: 'schedule.cancel',
      accountId: 'zumi-x',
    });
    const first = store.resolveApproval(created.approvalId, {
      status: 'approved',
      resolvedBy: 'op-1',
    });
    expect(first.didResolve).toBe(true);
    expect(first.record?.status).toBe('approved');
    expect(first.record?.resolvedBy).toBe('op-1');

    const second = store.resolveApproval(created.approvalId, {
      status: 'denied',
      resolvedBy: 'op-2',
    });
    expect(second.didResolve).toBe(false);
    expect(second.record?.status).toBe('approved'); // unchanged
  });

  it('marks deny', () => {
    const store = new ApprovalStore({ filePath: storePath });
    const created = store.createApproval({
      capabilityId: 'cap-1',
      accountId: 'a',
    });
    const result = store.resolveApproval(created.approvalId, {
      status: 'denied',
      resolvedBy: 'op',
    });
    expect(result.record?.status).toBe('denied');
    expect(store.listPending()).toHaveLength(0);
  });

  it('persists approvals across instances (replay JSONL)', () => {
    const store1 = new ApprovalStore({ filePath: storePath });
    const created = store1.createApproval({
      capabilityId: 'cap',
      accountId: 'a',
    });
    store1.resolveApproval(created.approvalId, {
      status: 'approved',
      resolvedBy: 'op',
    });

    // Verify the file has lines (append-only)
    const lines = readFileSync(storePath, 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(2);

    const store2 = new ApprovalStore({ filePath: storePath });
    expect(store2.getApproval(created.approvalId)?.status).toBe('approved');
  });

  it('builds and parses approval custom ids', () => {
    const customId = buildApprovalCustomId('abc-123', 'approve');
    expect(parseApprovalCustomId(customId)).toEqual({
      approvalId: 'abc-123',
      action: 'approve',
    });
    expect(parseApprovalCustomId('foo:bar:baz')).toBeNull();
    expect(parseApprovalCustomId('')).toBeNull();
  });

  it('renders an approval message payload with the right buttons', () => {
    const store = new ApprovalStore({ filePath: storePath });
    const approval = store.createApproval({
      capabilityId: 'cap',
      accountId: 'a',
    });
    const payload = buildApprovalMessagePayload(approval);
    expect(payload.embeds.length).toBe(1);
    expect(payload.components.length).toBe(1);
    const buttons = (payload.components[0].components ?? []) as Array<{
      custom_id?: string;
      label?: string;
    }>;
    expect(buttons.length).toBe(2);
    expect(buttons[0].custom_id).toContain('mex.approval');
    expect(buttons[0].label).toContain('承認');
    expect(buttons[1].label).toContain('拒否');
  });

  it('waitForResolution returns the resolved record', async () => {
    const store = new ApprovalStore({ filePath: storePath });
    const approval = store.createApproval({
      capabilityId: 'cap',
      accountId: 'a',
    });
    const promise = store.waitForResolution(approval.approvalId, { timeoutMs: 5_000 });
    // Resolve from another tick
    setImmediate(() => {
      store.resolveApproval(approval.approvalId, {
        status: 'approved',
        resolvedBy: 'op',
      });
    });
    const record = await promise;
    expect(record?.status).toBe('approved');
  });

  it('waitForResolution times out and writes a timeout record', async () => {
    const store = new ApprovalStore({ filePath: storePath });
    const approval = store.createApproval({
      capabilityId: 'cap',
      accountId: 'a',
    });
    let timedOutRecord: unknown = null;
    const record = await store.waitForResolution(approval.approvalId, {
      timeoutMs: 10,
      onTimeout: (rec) => {
        timedOutRecord = rec;
      },
    });
    expect(record?.status).toBe('timeout');
    expect(timedOutRecord).not.toBeNull();
  });
});
