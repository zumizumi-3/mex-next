import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import pino from 'pino';
import { GitSync } from '../../../src/account-state/git-sync.js';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'mex-next-git-sync-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('GitSync', () => {
  it('normal mutation commits and pushes', async () => {
    const repoDir = join(workDir, 'repo');
    const bareDir = join(workDir, 'remote.git');
    await initRepo(repoDir);
    await initBareRemote(bareDir);
    await git(repoDir, ['remote', 'add', 'origin', bareDir]);
    await writeFile(join(repoDir, 'state.json'), '{"account_id":"zumi-x"}\n', 'utf-8');

    const sync = makeSync(repoDir);
    const result = await sync.syncMutation('chore(state): mutation');

    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.commitHash).toMatch(/^[0-9a-f]{40}$/);
    const remoteHead = await execa('git', ['--git-dir', bareDir, 'rev-parse', 'main']);
    expect(remoteHead.stdout.trim()).toBe(result.commitHash);
  });

  it('no .git returns not_a_repo', async () => {
    const repoDir = join(workDir, 'plain');
    await mkdir(repoDir, { recursive: true });
    await writeFile(join(repoDir, 'state.json'), '{}\n', 'utf-8');

    const result = await makeSync(repoDir).syncMutation('chore(state): mutation');

    expect(result).toEqual({ committed: false, pushed: false, reason: 'not_a_repo' });
  });

  it('no remote commits and returns no_remote', async () => {
    const repoDir = join(workDir, 'repo');
    await initRepo(repoDir);
    await writeFile(join(repoDir, 'state.json'), '{}\n', 'utf-8');

    const result = await makeSync(repoDir).syncMutation('chore(state): mutation');

    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(false);
    expect(result.reason).toBe('no_remote');
    expect(result.commitHash).toMatch(/^[0-9a-f]{40}$/);
  });

  it('stage clean skips commit', async () => {
    const repoDir = join(workDir, 'repo');
    await initRepo(repoDir);

    const result = await makeSync(repoDir).syncMutation('chore(state): mutation');

    expect(result).toEqual({ committed: false, pushed: false, reason: 'no_changes' });
  });

  it('push failure returns pushed false and does not throw', async () => {
    const repoDir = join(workDir, 'repo');
    await initRepo(repoDir);
    await git(repoDir, ['remote', 'add', 'origin', join(workDir, 'missing.git')]);
    await writeFile(join(repoDir, 'state.json'), '{}\n', 'utf-8');

    const result = await makeSync(repoDir).syncMutation('chore(state): mutation');

    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(false);
    expect(result.reason).toMatch(/^push_failed: /);
  });

  it('three consecutive push failures call failureCallback exactly once', async () => {
    const repoDir = join(workDir, 'repo');
    await initRepo(repoDir);
    await git(repoDir, ['remote', 'add', 'origin', join(workDir, 'missing.git')]);
    const failureCallback = vi.fn(async (_reason: string) => undefined);
    const sync = makeSync(repoDir, { failureCallback });

    for (let i = 0; i < 4; i += 1) {
      await writeFile(join(repoDir, 'state.json'), `{"version":${i}}\n`, 'utf-8');
      const result = await sync.syncMutation(`chore(state): mutation ${i}`);
      expect(result.pushed).toBe(false);
    }

    expect(failureCallback).toHaveBeenCalledTimes(1);
    expect(failureCallback.mock.calls[0]?.[0]).toMatch(/^push_failed: /);
  });
});

function makeSync(
  repoDir: string,
  opts: { failureCallback?: (reason: string) => Promise<void> } = {},
): GitSync {
  return new GitSync({
    accountRepoPath: repoDir,
    logger: pino({ enabled: false }),
    failureCallback: opts.failureCallback,
  });
}

async function initRepo(repoDir: string): Promise<void> {
  await mkdir(repoDir, { recursive: true });
  await git(repoDir, ['init']);
  await git(repoDir, ['checkout', '-B', 'main']);
}

async function initBareRemote(bareDir: string): Promise<void> {
  await mkdir(bareDir, { recursive: true });
  await execa('git', ['init', '--bare', bareDir]);
}

function git(repoDir: string, args: readonly string[]) {
  return execa('git', ['-C', repoDir, ...args], {
    env: {
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
}
