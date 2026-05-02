import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildEmptyState,
  buildStarterAccount,
  launchAccount,
  updateRegistry,
} from '../../../src/onboarding/launch-wizard.js';

let workDir: string;
afterEach(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe('buildStarterAccount', () => {
  it('rejects invalid account_id', () => {
    expect(() => buildStarterAccount({ accountId: 'A B' })).toThrow();
    expect(() => buildStarterAccount({ accountId: 'ab' })).toThrow();
  });
  it('produces a schema-valid AccountJson', () => {
    const a = buildStarterAccount({ accountId: 'zumi-x', displayName: 'ずみさん' });
    expect(a.account_id).toBe('zumi-x');
    expect(a.display_name).toBe('ずみさん');
    expect(a.operating_cadence.profile).toBe('light');
    expect(a.approval_policy.low_risk_owner).toBe('director');
  });
});

describe('buildEmptyState', () => {
  it('returns a valid empty state', () => {
    const s = buildEmptyState('zumi-x');
    expect(s.account_id).toBe('zumi-x');
    expect(s.posting_sessions).toEqual([]);
    expect(s.onboarding_sessions).toEqual([]);
    expect(s.first_window_sessions).toEqual([]);
  });
});

describe('launchAccount', () => {
  it('creates skeleton account.json + state.json + registry', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'mex-launch-'));
    const accountDir = join(workDir, 'zumi-x');
    const result = await launchAccount({
      accountId: 'zumi-x',
      targetDir: accountDir,
      displayName: 'ずみさん',
    });
    expect(result.created).toBe(true);
    expect(result.registryUpdated).toBe(true);

    const accountRaw = await readFile(join(accountDir, 'account.json'), 'utf-8');
    expect(JSON.parse(accountRaw).account_id).toBe('zumi-x');

    const stateRaw = await readFile(join(accountDir, 'state.json'), 'utf-8');
    expect(JSON.parse(stateRaw).account_id).toBe('zumi-x');

    const registryRaw = await readFile(result.registryPath, 'utf-8');
    const registry = JSON.parse(registryRaw) as { accounts: Array<{ account_id: string }> };
    expect(registry.accounts.some((e) => e.account_id === 'zumi-x')).toBe(true);
  });

  it('is idempotent — re-running keeps account.json + reports unchanged registry', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'mex-launch-'));
    const accountDir = join(workDir, 'zumi-x');
    await launchAccount({
      accountId: 'zumi-x',
      targetDir: accountDir,
    });
    const second = await launchAccount({
      accountId: 'zumi-x',
      targetDir: accountDir,
    });
    expect(second.created).toBe(false);
    expect(second.registryUpdated).toBe(false);
  });

  it('rejects a malformed account_id', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'mex-launch-'));
    const accountDir = join(workDir, 'BAD');
    await expect(
      launchAccount({ accountId: 'BAD', targetDir: accountDir }),
    ).rejects.toThrow(/account_id/);
  });
});

describe('updateRegistry', () => {
  it('appends a new entry and skips when unchanged', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'mex-launch-'));
    const registryPath = join(workDir, 'accounts-registry.json');
    const first = await updateRegistry({
      registryPath,
      accountId: 'zumi-x',
      dir: '/tmp/zumi-x',
      nowIso: '2026-05-01T00:00:00Z',
    });
    expect(first).toBe(true);
    const second = await updateRegistry({
      registryPath,
      accountId: 'zumi-x',
      dir: '/tmp/zumi-x',
      nowIso: '2026-05-01T00:00:00Z',
    });
    expect(second).toBe(false);
  });
});
