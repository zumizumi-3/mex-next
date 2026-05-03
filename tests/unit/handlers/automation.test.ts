import { describe, it, expect, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  handleAutomationStatus,
  handleAutomationEnableAll,
  handleAutomationSetLevel,
} from '../../../src/handlers/index.js';
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
      state: {
        account_id: 'zumi-x',
        current_phase: 'needs_diagnosis',
        publish_queue: [
          {
            publish_id: 'p_held',
            content_id: 'c1',
            variant: 'primary',
            scheduled_at: '2026-05-02T07:00:00Z',
            status: 'held',
            queued_at: '2026-05-01T00:00:00Z',
            executed_at: '',
            last_error: 'automation paused',
            text_prefix: 'held body',
          },
        ],
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
    const state = JSON.parse(await readFile(join(scaf.workDir, 'state.json'), 'utf-8')) as {
      publish_queue: Array<Record<string, unknown>>;
    };
    expect(state.publish_queue[0]?.status).toBe('scheduled');
    expect(state.publish_queue[0]?.last_error).toBe('');
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

describe('handleAutomationSetLevel', () => {
  it.each(['manual', 'semi_auto', 'full_auto'] as const)(
    'automation_level を %s に切替できる',
    async (level) => {
      scaf = await setupHandlerTest({
        account: {
          account_id: 'zumi-x',
          x_action_system: { automation_level: 'semi_auto' },
        },
      });

      const result = await handleAutomationSetLevel(scaf.ctx, { level });

      expect(result.tag).toBe('automation.set_level');
      const persisted = JSON.parse(await readFile(join(scaf.workDir, 'account.json'), 'utf-8')) as {
        x_action_system?: { automation_level?: string };
      };
      expect(persisted.x_action_system?.automation_level).toBe(level);
    },
  );

  it('不正 level は保存しない', async () => {
    scaf = await setupHandlerTest({
      account: {
        account_id: 'zumi-x',
        x_action_system: { automation_level: 'semi_auto' },
      },
    });

    const result = await handleAutomationSetLevel(scaf.ctx, { level: 'auto' });

    expect(result.tag).toBe('automation.set_level.invalid');
    const persisted = JSON.parse(await readFile(join(scaf.workDir, 'account.json'), 'utf-8')) as {
      x_action_system?: { automation_level?: string };
    };
    expect(persisted.x_action_system?.automation_level).toBe('semi_auto');
  });
});
