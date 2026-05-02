import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountRepo } from '../../../src/account-state/repo.js';
import type { GitSync } from '../../../src/account-state/git-sync.js';
import { AccountJsonSchema } from '../../../src/account-state/account-schema.js';

let workDir: string;

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('AccountRepo.writeKnowledgeFiles', () => {
  it('writes all knowledge markdown files and triggers git sync', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'mex-repo-knowledge-'));
    await writeFile(join(workDir, 'account.json'), JSON.stringify({ account_id: 'zumi-x' }), 'utf-8');
    await writeFile(join(workDir, 'state.json'), JSON.stringify({ account_id: 'zumi-x' }), 'utf-8');
    const syncMutation = vi.fn(async () => ({
      committed: true,
      pushed: true,
      commitHash: 'abc123',
    }));
    const repo = new AccountRepo(workDir, {
      gitSync: { syncMutation } as unknown as GitSync,
    });

    await repo.writeKnowledgeFiles(AccountJsonSchema.parse({
      account_id: 'zumi-x',
      display_name: 'ずみ',
      x_handle: 'zumi_ops',
    }));

    for (const name of [
      'AGENTS.md',
      'CLAUDE.md',
      'persona.md',
      'brand.md',
      'voice-guide.md',
      'targets.md',
      'README.md',
    ]) {
      const body = await readFile(join(workDir, name), 'utf-8');
      expect(body.length).toBeGreaterThan(0);
      expect(body.endsWith('\n')).toBe(true);
    }
    expect(await readFile(join(workDir, 'AGENTS.md'), 'utf-8')).toContain('@zumi_ops');
    expect(syncMutation).toHaveBeenCalledTimes(1);
    expect(syncMutation).toHaveBeenCalledWith(
      'chore(knowledge): regenerate AGENTS / CLAUDE / persona / brand / targets',
    );
  });

  it('passes recent exemplars into generated AGENTS.md', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'mex-repo-knowledge-'));
    await writeFile(join(workDir, 'account.json'), JSON.stringify({ account_id: 'zumi-x' }), 'utf-8');
    await writeFile(join(workDir, 'state.json'), JSON.stringify({ account_id: 'zumi-x' }), 'utf-8');
    const repo = new AccountRepo(workDir, {
      exemplarWriter: {
        listRecent: vi.fn(async () => [
          {
            id: 'exm_01',
            topic: '修正例',
            createdAt: '2026-05-03T00:00:00.000Z',
            relativePath: 'exemplars/2026-05-03-example.md',
          },
        ]),
      },
    });

    await repo.writeKnowledgeFiles(AccountJsonSchema.parse({ account_id: 'zumi-x' }));

    const agents = await readFile(join(workDir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('## 学習素材 (exemplars)');
    expect(agents).toContain('[修正例](./exemplars/2026-05-03-example.md)');
  });
});
