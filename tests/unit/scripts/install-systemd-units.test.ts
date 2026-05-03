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
});
