import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('install-systemd-units.sh', () => {
  it('dry-run renders account-suffixed service/timer filenames', async () => {
    const { stdout } = await execFileAsync('bash', ['scripts/install-systemd-units.sh'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ACCOUNT_ID: 'zumi-x',
        MEX_SYSTEMD_DRY_RUN: '1',
      },
      maxBuffer: 1024 * 1024,
    });

    expect(stdout).toContain('/etc/systemd/system/mex-publish-zumi-x.service');
    expect(stdout).toContain('/etc/systemd/system/mex-publish-zumi-x.timer');
    expect(stdout).toContain('/etc/systemd/system/mex-phase-questionnaire-weekly-zumi-x.service');
    expect(stdout).toContain('/etc/systemd/system/mex-proactive-nudge-weekly-zumi-x.service');
    expect(stdout).toContain('/etc/systemd/system/mex-proactive-nudge-monthly-zumi-x.timer');
    expect(stdout).toContain('/etc/systemd/system/mex-proactive-nudge-stale-target-zumi-x.service');
    expect(stdout).toContain(
      '/etc/systemd/system/mex-proactive-nudge-unanswered-phase-zumi-x.timer',
    );
    expect(stdout).toContain('systemctl enable --now mex-publish-zumi-x.timer');
  });

  it('--dry-run flag renders unit names and contents without env dry-run', async () => {
    const { stdout } = await execFileAsync(
      'bash',
      ['scripts/install-systemd-units.sh', 'zumi-x', '--dry-run'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ACCOUNT_ID: '',
          MEX_SYSTEMD_DRY_RUN: '',
        },
        maxBuffer: 1024 * 1024,
      },
    );

    expect(stdout).toContain('===== /etc/systemd/system/mex-publish-zumi-x.service =====');
    expect(stdout).toContain('===== /etc/systemd/system/mex-publish-zumi-x.timer =====');
    expect(stdout).toContain('[Unit]');
    expect(stdout).toContain('systemctl enable --now mex-publish-zumi-x.timer');
  });

  it('invalid ACCOUNT_ID exits non-zero before rendering', async () => {
    try {
      await execFileAsync(
        'bash',
        ['scripts/install-systemd-units.sh', 'bad id', '--dry-run'],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            ACCOUNT_ID: '',
            MEX_SYSTEMD_DRY_RUN: '',
          },
          maxBuffer: 1024 * 1024,
        },
      );
      throw new Error('expected install-systemd-units.sh to fail');
    } catch (error: unknown) {
      const err = error as { code?: number; stderr?: string; stdout?: string };
      expect(err.code).not.toBe(0);
      expect(err.stderr).toContain('invalid ACCOUNT_ID');
      expect(err.stdout ?? '').not.toContain('mex-publish-bad id.service');
    }
  });
});
