import { describe, it, expect, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { handleAutomationStatus, handleAutomationEnableAll } from '../../../src/handlers/index.js';
import { setupHandlerTest, type TestHandlerScaffold } from './test-helpers.js';

let scaf: TestHandlerScaffold;
afterEach(async () => {
  await scaf?.cleanup();
});

describe('handleAutomationStatus', () => {
  it('status を行ごとに表示', async () => {
    scaf = await setupHandlerTest({
      account: {
        account_id: 'zumi-x',
        approval_policy: { publish_requires_approval: true },
      },
    });
    const result = await handleAutomationStatus(scaf.ctx, {});
    expect(result.content).toContain('publish_requires_approval');
    expect(result.content).toContain('manual');
  });
});

describe('handleAutomationEnableAll', () => {
  it('operator (allowlist + matching requesterUserId) の場合に全 gate を auto に切替', async () => {
    scaf = await setupHandlerTest({
      account: {
        account_id: 'zumi-x',
        approval_policy: { publish_requires_approval: true, reply_requires_approval: true },
      },
    });
    const ctx = {
      ...scaf.ctx,
      operatorDiscordUserIds: ['op-1'],
      requesterUserId: 'op-1',
    };
    const result = await handleAutomationEnableAll(ctx, {});
    expect(result.content).toContain('一括 ON');
    const persisted = JSON.parse(await readFile(join(scaf.workDir, 'account.json'), 'utf-8')) as {
      approval_policy: Record<string, unknown>;
    };
    expect(persisted.approval_policy.publish_requires_approval).toBe(false);
    expect(persisted.approval_policy.reply_requires_approval).toBe(false);
  });

  it('non-operator は拒否され、approval_policy は変更されない', async () => {
    scaf = await setupHandlerTest({
      account: {
        account_id: 'zumi-x',
        approval_policy: { publish_requires_approval: true, reply_requires_approval: true },
      },
    });
    const ctx = {
      ...scaf.ctx,
      operatorDiscordUserIds: ['op-1'],
      requesterUserId: 'attacker-99',
    };
    const result = await handleAutomationEnableAll(ctx, {});
    expect(result.tag).toBe('automation.enable_all.unauthorized');
    const persisted = JSON.parse(await readFile(join(scaf.workDir, 'account.json'), 'utf-8')) as {
      approval_policy: Record<string, unknown>;
    };
    // unchanged
    expect(persisted.approval_policy.publish_requires_approval).toBe(true);
    expect(persisted.approval_policy.reply_requires_approval).toBe(true);
  });

  it('operator allowlist が空の場合は誰でも拒否される', async () => {
    scaf = await setupHandlerTest({
      account: {
        account_id: 'zumi-x',
        approval_policy: { publish_requires_approval: true },
      },
    });
    const ctx = {
      ...scaf.ctx,
      operatorDiscordUserIds: [],
      requesterUserId: 'anyone',
    };
    const result = await handleAutomationEnableAll(ctx, {});
    expect(result.tag).toBe('automation.enable_all.unauthorized');
  });
});
