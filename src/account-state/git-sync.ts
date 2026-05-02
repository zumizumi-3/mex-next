import { execa } from 'execa';
import type { Logger } from 'pino';

export interface GitSyncOptions {
  readonly accountRepoPath: string;
  readonly logger: Logger;
  readonly enabled?: boolean;
  readonly remoteName?: string;
  readonly branch?: string;
  readonly authorName?: string;
  readonly authorEmail?: string;
  readonly failureCallback?: (reason: string) => Promise<void>;
}

export interface GitSyncResult {
  readonly committed: boolean;
  readonly pushed: boolean;
  readonly commitHash?: string;
  readonly reason?: string;
}

const DEFAULT_AUTHOR_NAME = 'mex-next bot';
const DEFAULT_AUTHOR_EMAIL = 'mex-next@example.invalid';

export class GitSync {
  private readonly accountRepoPath: string;
  private readonly logger: Logger;
  private readonly enabled: boolean;
  private readonly remoteName: string;
  private readonly branch: string;
  private readonly authorName: string;
  private readonly authorEmail: string;
  private readonly failureCallback?: (reason: string) => Promise<void>;
  private consecutiveFailures = 0;
  private failureCallbackEmitted = false;

  constructor(opts: GitSyncOptions) {
    this.accountRepoPath = opts.accountRepoPath;
    this.logger = opts.logger;
    this.enabled = opts.enabled ?? true;
    this.remoteName = opts.remoteName ?? 'origin';
    this.branch = opts.branch ?? 'main';
    this.authorName = opts.authorName ?? DEFAULT_AUTHOR_NAME;
    this.authorEmail = opts.authorEmail ?? DEFAULT_AUTHOR_EMAIL;
    this.failureCallback = opts.failureCallback;
  }

  async syncMutation(message: string): Promise<GitSyncResult> {
    if (!this.enabled) {
      return this.finish({ committed: false, pushed: false, reason: 'disabled' });
    }

    try {
      if (!(await this.isGitRepo())) {
        return this.finish({ committed: false, pushed: false, reason: 'not_a_repo' });
      }

      try {
        await this.git(['add', '-A']);
      } catch (err) {
        return this.fail({ committed: false, reason: `add_failed: ${errorMessage(err)}` });
      }

      const diff = await this.git(['diff', '--cached', '--quiet'], { reject: false });
      if (diff.exitCode === 0) {
        return this.finish({ committed: false, pushed: false, reason: 'no_changes' });
      }
      if (diff.exitCode !== 1) {
        return this.fail({
          committed: false,
          reason: `diff_failed: ${commandOutputOrError(diff.stderr, diff.stdout)}`,
        });
      }

      let committed = false;
      try {
        await this.git([
          'commit',
          '-m',
          message,
          '--author',
          `${this.authorName} <${this.authorEmail}>`,
        ]);
        committed = true;
      } catch (err) {
        return this.fail({ committed, reason: `commit_failed: ${errorMessage(err)}` });
      }

      const commitHash = await this.currentCommitHash();
      if (!(await this.hasRemote())) {
        return this.finish({
          committed: true,
          pushed: false,
          commitHash,
          reason: 'no_remote',
        });
      }

      try {
        await this.git(['push', '--no-verify', this.remoteName, this.branch], {
          timeout: 30_000,
        });
      } catch (err) {
        return this.fail({
          committed: true,
          commitHash,
          reason: `push_failed: ${errorMessage(err)}`,
        });
      }

      return this.finish({ committed: true, pushed: true, commitHash });
    } catch (err) {
      return this.fail({ committed: false, reason: `git_sync_failed: ${errorMessage(err)}` });
    }
  }

  async healthCheck(): Promise<{ ok: boolean; reason?: string }> {
    try {
      if (!this.enabled) return { ok: false, reason: 'disabled' };
      if (!(await this.isGitRepo())) return { ok: false, reason: 'not_a_repo' };
      if (!(await this.hasRemote())) return { ok: false, reason: 'no_remote' };
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `health_check_failed: ${errorMessage(err)}` };
    }
  }

  private async isGitRepo(): Promise<boolean> {
    const result = await this.git(['rev-parse', '--is-inside-work-tree'], {
      reject: false,
    });
    return result.exitCode === 0 && result.stdout.trim() === 'true';
  }

  private async hasRemote(): Promise<boolean> {
    const result = await this.git(['remote', 'get-url', this.remoteName], {
      reject: false,
    });
    return result.exitCode === 0 && result.stdout.trim().length > 0;
  }

  private async currentCommitHash(): Promise<string | undefined> {
    const result = await this.git(['rev-parse', 'HEAD'], { reject: false });
    if (result.exitCode !== 0) return undefined;
    const hash = result.stdout.trim();
    return hash.length > 0 ? hash : undefined;
  }

  private git(args: readonly string[], opts: { reject?: boolean; timeout?: number } = {}) {
    return execa('git', ['-C', this.accountRepoPath, ...args], {
      reject: opts.reject,
      timeout: opts.timeout,
      env: {
        GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_NAME: this.authorName,
        GIT_AUTHOR_EMAIL: this.authorEmail,
        GIT_COMMITTER_NAME: this.authorName,
        GIT_COMMITTER_EMAIL: this.authorEmail,
      },
    });
  }

  private async fail(input: {
    readonly committed: boolean;
    readonly commitHash?: string;
    readonly reason: string;
  }): Promise<GitSyncResult> {
    this.logger.warn(
      { reason: input.reason, committed: input.committed, accountRepoPath: this.accountRepoPath },
      'git_sync_failed',
    );
    return this.finish({
      committed: input.committed,
      pushed: false,
      commitHash: input.commitHash,
      reason: input.reason,
    });
  }

  private async finish(result: GitSyncResult): Promise<GitSyncResult> {
    await this.recordResult(result);
    return result;
  }

  private async recordResult(result: GitSyncResult): Promise<void> {
    if (result.pushed) {
      this.consecutiveFailures = 0;
      this.failureCallbackEmitted = false;
      return;
    }

    if (result.reason === 'disabled' || result.reason === 'no_changes') {
      this.consecutiveFailures = 0;
      this.failureCallbackEmitted = false;
      return;
    }

    this.consecutiveFailures += 1;
    if (this.consecutiveFailures < 3 || this.failureCallbackEmitted || !this.failureCallback) {
      return;
    }

    this.failureCallbackEmitted = true;
    try {
      await this.failureCallback(result.reason ?? 'unknown');
    } catch (err) {
      this.logger.warn(
        { err: errorMessage(err), reason: result.reason },
        'git_sync_failure_callback_failed',
      );
    }
  }
}

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const withStderr = err as { stderr?: unknown; shortMessage?: unknown; message?: unknown };
    if (typeof withStderr.stderr === 'string' && withStderr.stderr.trim().length > 0) {
      return withStderr.stderr.trim();
    }
    if (typeof withStderr.shortMessage === 'string' && withStderr.shortMessage.length > 0) {
      return withStderr.shortMessage;
    }
    if (typeof withStderr.message === 'string' && withStderr.message.length > 0) {
      return withStderr.message;
    }
  }
  return String(err);
}

function commandOutputOrError(stderr: string, stdout: string): string {
  const text = stderr.trim() || stdout.trim();
  return text.length > 0 ? text : 'unknown';
}
