import { describe, expect, it, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  regenerateKnowledgeCli,
  runRegenerateKnowledge,
} from '../../../src/scripts/regenerate-knowledge.js';

let workDir = '';

afterEach(async () => {
  vi.restoreAllMocks();
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

describe('regenerate-knowledge', () => {
  it('writes the knowledge markdown and workflow files from account.json', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'mex-knowledge-'));
    await writeFile(
      join(workDir, 'account.json'),
      JSON.stringify({
        account_id: 'zumi-x',
        display_name: 'Zumi X',
        x_handle: 'zumi',
      }),
      'utf-8',
    );

    const report = await runRegenerateKnowledge({ accountRepo: workDir });

    expect(report.written).toHaveLength(10);
    const agents = await readFile(join(workDir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('# AGENTS.md — zumi-x');
    expect(agents).toContain('- 表示名: Zumi X');
    expect(await readFile(join(workDir, 'CLAUDE.md'), 'utf-8')).toBe(agents);
    await expect(readFile(join(workDir, 'persona.md'), 'utf-8')).resolves.toContain(
      '# Persona — Zumi X',
    );
    await expect(readFile(join(workDir, 'brand.md'), 'utf-8')).resolves.toContain(
      '# Brand — Zumi X',
    );
    await expect(readFile(join(workDir, 'voice-guide.md'), 'utf-8')).resolves.toContain(
      '# Voice Guide — Zumi X',
    );
    await expect(readFile(join(workDir, 'targets.md'), 'utf-8')).resolves.toContain(
      '# Tracked Targets — Zumi X',
    );
    await expect(readFile(join(workDir, 'README.md'), 'utf-8')).resolves.toContain(
      '# zumi-x — MeX 運用データ',
    );
    await expect(
      readFile(join(workDir, '.github/workflows/weekly-retro.yml'), 'utf-8'),
    ).resolves.toContain('weekly_retro');
    await expect(
      readFile(join(workDir, '.github/workflows/monthly-retro.yml'), 'utf-8'),
    ).resolves.toContain('monthly_retro');
    await expect(
      readFile(join(workDir, '.github/workflows/phase-questionnaire.yml'), 'utf-8'),
    ).resolves.toContain('phase_questionnaire');
  });

  it('returns exit code 1 with an explanatory message when account.json is missing', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'mex-knowledge-'));
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((() => true) as typeof process.stderr.write);

    const code = await regenerateKnowledgeCli(['--account-repo', workDir]);

    expect(code).toBe(1);
    expect(String(stderr.mock.calls[0]?.[0])).toContain('account.json not found');
  });
});
