import { describe, it, expect, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { handleTargetAdd, handleTargetList, handleTargetRemove } from '../../../src/handlers/index.js';
import { setupHandlerTest, type TestHandlerScaffold } from './test-helpers.js';

let scaf: TestHandlerScaffold;
afterEach(async () => {
  await scaf?.cleanup();
});

describe('handleTargetAdd', () => {
  it('account.json に handle が追記される', async () => {
    scaf = await setupHandlerTest();
    const result = await handleTargetAdd(scaf.ctx, { handle: '@tanaka_san' });
    expect(result.content).toContain('@tanaka_san');
    const persisted = JSON.parse(await readFile(join(scaf.workDir, 'account.json'), 'utf-8')) as {
      x_action_system?: { tracked_targets?: { usernames?: string[] } };
    };
    expect(persisted.x_action_system?.tracked_targets?.usernames).toContain('tanaka_san');
  });

  it('空 handle なら警告', async () => {
    scaf = await setupHandlerTest();
    const result = await handleTargetAdd(scaf.ctx, { handle: '   ' });
    expect(result.content).toContain('認識できません');
  });
});

describe('handleTargetList', () => {
  it('登録済 handle を一覧表示', async () => {
    scaf = await setupHandlerTest({
      account: {
        account_id: 'zumi-x',
        x_action_system: {
          tracked_targets: { usernames: ['alice', 'bob'] },
        },
      },
    });
    const result = await handleTargetList(scaf.ctx, {});
    expect(result.content).toContain('@alice');
    expect(result.content).toContain('@bob');
  });

  it('空のときは empty メッセージ', async () => {
    scaf = await setupHandlerTest();
    const result = await handleTargetList(scaf.ctx, {});
    expect(result.content).toContain('登録されていません');
  });
});

describe('handleTargetRemove', () => {
  it('指定 handle を外す', async () => {
    scaf = await setupHandlerTest({
      account: {
        account_id: 'zumi-x',
        x_action_system: {
          tracked_targets: { usernames: ['alice', 'bob'] },
        },
      },
    });
    const result = await handleTargetRemove(scaf.ctx, { handle: 'alice' });
    expect(result.content).toContain('@alice');
    const persisted = JSON.parse(await readFile(join(scaf.workDir, 'account.json'), 'utf-8')) as {
      x_action_system?: { tracked_targets?: { usernames?: string[] } };
    };
    expect(persisted.x_action_system?.tracked_targets?.usernames).toEqual(['bob']);
  });
});
