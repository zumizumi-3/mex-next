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
  it('全 gate を auto (false) に切替', async () => {
    scaf = await setupHandlerTest({
      account: {
        account_id: 'zumi-x',
        approval_policy: { publish_requires_approval: true, reply_requires_approval: true },
      },
    });
    const result = await handleAutomationEnableAll(scaf.ctx, {});
    expect(result.content).toContain('一括 ON');
    const persisted = JSON.parse(await readFile(join(scaf.workDir, 'account.json'), 'utf-8')) as {
      approval_policy: Record<string, unknown>;
    };
    expect(persisted.approval_policy.publish_requires_approval).toBe(false);
    expect(persisted.approval_policy.reply_requires_approval).toBe(false);
  });
});
