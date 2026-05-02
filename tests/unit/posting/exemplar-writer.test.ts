import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { computeEditDiff } from '../../../src/posting/edit-diff.js';
import { ExemplarWriter, type ExemplarRecord } from '../../../src/posting/exemplar-writer.js';
import { NOOP_LOGGER } from '../../../src/posting/types.js';

let workDir: string;

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function record(input: Partial<ExemplarRecord> = {}): ExemplarRecord {
  const original = input.original ?? '朝はまず予定を見る。';
  const final = input.final ?? '朝はまず予定を見て、手順を決める。';
  return {
    id: input.id ?? 'exm_01',
    createdAt: input.createdAt ?? '2026-05-03T00:00:00.000Z',
    topic: input.topic ?? 'Morning Routine',
    original,
    final,
    diff: input.diff ?? computeEditDiff(original, final),
    ...(input.note ? { note: input.note } : {}),
  };
}

describe('ExemplarWriter', () => {
  it('writes markdown with original, final and unified diff', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'mex-exemplar-writer-'));
    const writer = new ExemplarWriter({ accountRepoPath: workDir, logger: NOOP_LOGGER });

    const result = await writer.write(record({ note: '助詞を自然にする' }));

    expect(basename(result.path)).toBe('2026-05-03-morning-routine.md');
    const body = await readFile(result.path, 'utf-8');
    expect(body).toContain('# Exemplar — Morning Routine');
    expect(body).toContain('## bot 原案');
    expect(body).toContain('朝はまず予定を見る。');
    expect(body).toContain('## 顧客修正後');
    expect(body).toContain('朝はまず予定を見て、手順を決める。');
    expect(body).toContain('```diff');
    expect(body).toContain('--- bot');
    expect(body).toContain('+++ final');
    expect(body).toContain('-朝はまず予定を見る。');
    expect(body).toContain('+朝はまず予定を見て、手順を決める。');
    expect(body).toContain('- 助詞を自然にする');
  });

  it('adds numeric suffixes when the slug already exists', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'mex-exemplar-writer-'));
    const writer = new ExemplarWriter({ accountRepoPath: workDir, logger: NOOP_LOGGER });

    const first = await writer.write(record());
    const second = await writer.write(record({ id: 'exm_02' }));
    const third = await writer.write(record({ id: 'exm_03' }));

    expect(basename(first.path)).toBe('2026-05-03-morning-routine.md');
    expect(basename(second.path)).toBe('2026-05-03-morning-routine-2.md');
    expect(basename(third.path)).toBe('2026-05-03-morning-routine-3.md');
  });

  it('lists recent exemplars newest first with a limit', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'mex-exemplar-writer-'));
    const writer = new ExemplarWriter({ accountRepoPath: workDir, logger: NOOP_LOGGER });

    await writer.write(record({ id: 'exm_old', topic: 'Old Topic', createdAt: '2026-05-01T00:00:00.000Z' }));
    await writer.write(record({ id: 'exm_new', topic: 'New Topic', createdAt: '2026-05-03T00:00:00.000Z' }));
    await writer.write(record({ id: 'exm_mid', topic: 'Middle Topic', createdAt: '2026-05-02T00:00:00.000Z' }));

    const recent = await writer.listRecent(2);

    expect(recent.map((item) => item.id)).toEqual(['exm_new', 'exm_mid']);
    expect(recent[0]).toMatchObject({
      topic: 'New Topic',
      createdAt: '2026-05-03T00:00:00.000Z',
      relativePath: 'exemplars/2026-05-03-new-topic.md',
    });
  });
});
