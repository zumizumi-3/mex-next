import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCrossAccountReport } from '../../../src/scripts/cross-account-report.js';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'mex-cross-report-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function seedAccount(
  accountId: string,
  opts: {
    voiceTone: string;
    publishQueue: unknown[];
    postingSessions: unknown;
    retroMarkdown?: string;
  },
): Promise<string> {
  const dir = join(workDir, accountId);
  await mkdir(join(dir, 'retros'), { recursive: true });
  await writeFile(
    join(dir, 'account.json'),
    JSON.stringify({ account_id: accountId, brand: { voice_tone: opts.voiceTone } }),
    'utf-8',
  );
  await writeFile(
    join(dir, 'state.json'),
    JSON.stringify({
      account_id: accountId,
      publish_queue: opts.publishQueue,
      posting_sessions: opts.postingSessions,
    }),
    'utf-8',
  );
  if (opts.retroMarkdown) {
    await writeFile(join(dir, 'retros', '2026-05.md'), opts.retroMarkdown, 'utf-8');
  }
  return dir;
}

describe('runCrossAccountReport', () => {
  it('aggregates account posts, terminal failures, quality scores, zones, and retro headers', async () => {
    const zumiRepo = await seedAccount('zumi-x', {
      voiceTone: '落ち着き',
      publishQueue: [
        { publish_id: 'p1', status: 'published', scheduled_at: '2026-05-01T21:18:00+09:00' },
        { publish_id: 'p2', status: 'failed_terminal', scheduled_at: '2026-05-02T06:18:00+09:00' },
      ],
      postingSessions: [
        {
          id: 's1',
          candidates: [
            {
              quality_scores: {
                stop_power: 4,
                specificity: 3,
                progression: 4,
                voice_match: 5,
                length_fit: 4,
              },
            },
          ],
        },
      ],
      retroMarkdown: '# Monthly retro\n\n## 朝の予約\n本文',
    });
    const tanakaRepo = await seedAccount('tanaka-x', {
      voiceTone: '煽り',
      publishQueue: [
        { publish_id: 'p3', status: 'published', scheduled_at: '2026-05-01T06:30:00+09:00' },
      ],
      postingSessions: {
        s2: {
          candidates: [
            {
              qualityResult: {
                scores: [
                  { axis: 'stop_power', score: 3 },
                  { axis: 'specificity', score: 3 },
                ],
              },
            },
          ],
        },
      },
    });
    const registryPath = join(workDir, 'accounts-registry.json');
    await writeFile(
      registryPath,
      JSON.stringify({
        accounts: {
          'zumi-x': { account_id: 'zumi-x', account_repo: zumiRepo },
          'tanaka-x': { account_id: 'tanaka-x', account_repo: tanakaRepo },
        },
      }),
      'utf-8',
    );

    const result = await runCrossAccountReport({
      registryPath,
      outputDir: workDir,
      now: new Date('2026-05-03T00:30:00Z'),
    });

    expect(result.reportPath).toBe(join(workDir, 'cross-account-report-2026-05-03.md'));
    expect(result.markdown).toContain('# Cross-account report — 2026-05-03');
    expect(result.markdown).toContain('- zumi-x: posts 1 / failed 1 / avg quality 4.0');
    expect(result.markdown).toContain('- tanaka-x: posts 1 / failed 0 / avg quality 3.0');
    expect(result.markdown).toContain('06:00-09:00 zone は publish 失敗率 50% (1/2)');
    expect(result.markdown).toContain('voice_tone="落ち着き" は average quality 4.0');
    expect(result.markdown).toContain('2026-05.md: Monthly retro');

    await expect(readFile(result.reportPath, 'utf-8')).resolves.toBe(result.markdown);
  });
});
