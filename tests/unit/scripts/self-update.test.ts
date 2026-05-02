/**
 * self-update.sh — fallback restart behaviour test.
 *
 * Strategy: source the script in a non-interactive bash subprocess
 * with a fake `systemctl` on PATH that we control via env vars. The
 * script exposes `restart_bot_with_fallback` so we can call it
 * directly without running the full `main` (which would also try to
 * `git fetch` / `npm ci`).
 *
 * Three scenarios:
 *  1. restart succeeds              → exit 0, only the first call.
 *  2. restart fails, fallback succ  → exit 0, both calls observed.
 *  3. both fail                     → exit 1, both calls observed.
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const SCRIPT_PATH = new URL('../../../scripts/self-update.sh', import.meta.url).pathname;

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runFallback(opts: {
  restartFails: boolean;
  startFails: boolean;
}): Promise<{ result: RunResult; calls: string[] }> {
  const workDir = await mkdtemp(join(tmpdir(), 'mex-self-update-'));
  const callLog = join(workDir, 'calls.log');
  const fakeSystemctl = join(workDir, 'systemctl');
  // Bash fake: log every invocation, exit per env flag depending on
  // the first arg (`restart` vs `start`).
  const fakeBody = `#!/usr/bin/env bash
echo "$@" >> "${callLog}"
case "$1" in
  restart) exit ${opts.restartFails ? 1 : 0} ;;
  start)   exit ${opts.startFails ? 1 : 0} ;;
  *)       exit 0 ;;
esac
`;
  await writeFile(fakeSystemctl, fakeBody, 'utf-8');
  await chmod(fakeSystemctl, 0o755);

  // Source the script and call restart_bot_with_fallback. `set -uo
  // pipefail` from the script + `|| true` lets us observe non-zero
  // exit without bash aborting before we capture it.
  const cmd = `source "${SCRIPT_PATH}"; restart_bot_with_fallback; echo "RC:$?"`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${workDir}:${process.env.PATH ?? ''}`,
    BOT_SERVICE: 'mex-bot.service',
    OPERATOR_DISCORD_WEBHOOK: '',
  };

  const result: RunResult = await new Promise((resolve) => {
    const proc = spawn('bash', ['-c', cmd], { env });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (b) => { stdout += b.toString(); });
    proc.stderr.on('data', (b) => { stderr += b.toString(); });
    proc.on('close', (code) => {
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });

  let calls: string[] = [];
  try {
    const raw = await readFile(callLog, 'utf-8');
    calls = raw.split('\n').filter((l) => l.length > 0);
  } catch {
    calls = [];
  }
  await rm(workDir, { recursive: true, force: true });
  return { result, calls };
}

describe('self-update.sh — restart_bot_with_fallback', () => {
  it('restart 成功時は 1 回のみ呼ばれて RC:0', async () => {
    const { result, calls } = await runFallback({
      restartFails: false,
      startFails: false,
    });
    expect(result.stdout).toContain('RC:0');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe('restart mex-bot.service');
  });

  it('restart 失敗 → start fallback 成功で RC:0 + 両方呼ばれる', async () => {
    const { result, calls } = await runFallback({
      restartFails: true,
      startFails: false,
    });
    expect(result.stdout).toContain('RC:0');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe('restart mex-bot.service');
    expect(calls[1]).toBe('start --no-block mex-bot.service');
    // log line is emitted before fallback for operator traceability.
    expect(result.stderr).toContain('restart failed');
  });

  it('両方失敗で RC:1 + 2 回呼ばれる', async () => {
    const { result, calls } = await runFallback({
      restartFails: true,
      startFails: true,
    });
    expect(result.stdout).toContain('RC:1');
    expect(calls).toHaveLength(2);
    expect(result.stderr).toContain('fallback start also failed');
  });
});

describe('self-update.sh — send_alert helper', () => {
  it('OPERATOR_DISCORD_WEBHOOK 未設定なら何もしない (silent return 0)', async () => {
    const cmd = `source "${SCRIPT_PATH}"; send_alert "test"; echo "RC:$?"`;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OPERATOR_DISCORD_WEBHOOK: '',
    };
    const result: RunResult = await new Promise((resolve) => {
      const proc = spawn('bash', ['-c', cmd], { env });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (b) => { stdout += b.toString(); });
      proc.stderr.on('data', (b) => { stderr += b.toString(); });
      proc.on('close', (code) => {
        resolve({ exitCode: code ?? -1, stdout, stderr });
      });
    });
    expect(result.stdout).toContain('RC:0');
  });
});
