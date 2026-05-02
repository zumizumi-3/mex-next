/**
 * Atomic IO の test。
 *
 * - readJson + writeJsonAtomic round-trip
 * - 同時 5 並列 write でロスト更新が起きない
 * - withStateLock で例外時は state.json が元のまま
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readJson,
  writeJsonAtomic,
  withStateLock,
} from '../../../src/account-state/index.js';
import { z } from 'zod';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'mex-next-io-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const Schema = z
  .object({
    counter: z.number().int().default(0),
    items: z.array(z.string()).default([]),
  })
  .passthrough();

describe('writeJsonAtomic + readJson', () => {
  it('round-trip で値が保たれる', async () => {
    const path = join(workDir, 'a.json');
    await writeJsonAtomic(path, { counter: 1, items: ['a', 'b'] });
    const loaded = await readJson(path, Schema);
    expect(loaded.counter).toBe(1);
    expect(loaded.items).toEqual(['a', 'b']);
  });

  it('schema 違反は throw する', async () => {
    const path = join(workDir, 'bad.json');
    await writeJsonAtomic(path, { counter: 'not-a-number' });
    await expect(readJson(path, Schema)).rejects.toThrow();
  });

  it('schema を渡すと write 時に validate される', async () => {
    const path = join(workDir, 'validated.json');
    await expect(
      writeJsonAtomic(path, { counter: 'wrong' }, Schema)
    ).rejects.toThrow();
  });
});

describe('writeJsonAtomic concurrency', () => {
  it('同時 5 並列 write でファイルが壊れない (last-writer-wins)', async () => {
    const path = join(workDir, 'race.json');
    await writeJsonAtomic(path, { counter: 0, items: [] });

    const writers = Array.from({ length: 5 }, (_, i) =>
      writeJsonAtomic(path, { counter: i, items: [`item-${i}`] })
    );
    await Promise.all(writers);

    // ファイルは valid JSON として残る (壊れていない = atomic)
    const final = await readJson(path, Schema);
    expect(final).toBeDefined();
    expect(typeof final.counter).toBe('number');
    expect(final.counter).toBeGreaterThanOrEqual(0);
    expect(final.counter).toBeLessThanOrEqual(4);
  });
});

describe('withStateLock', () => {
  it('flock 内 read-modify-write でロスト更新が起きない', async () => {
    // state.json に counter を持たせ、5 並列で +1 する。
    // 全部完了後、counter == 5 になっているはず (flock 必須)。
    const statePath = join(workDir, 'state.json');
    await writeJsonAtomic(statePath, { counter: 0 });

    const ops = Array.from({ length: 5 }, () =>
      withStateLock(workDir, async () => {
        const current = JSON.parse(
          await readFile(statePath, 'utf-8')
        ) as { counter: number };
        // 微小な delay を入れて race を誘発
        await new Promise((r) => setTimeout(r, 5));
        await writeJsonAtomic(statePath, {
          counter: current.counter + 1,
        });
      })
    );
    await Promise.all(ops);

    const final = JSON.parse(
      await readFile(statePath, 'utf-8')
    ) as { counter: number };
    expect(final.counter).toBe(5);
  });

  it('callback が throw すると state は変更されない', async () => {
    const statePath = join(workDir, 'state.json');
    await writeJsonAtomic(statePath, { counter: 42 });

    await expect(
      withStateLock(workDir, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    const after = JSON.parse(
      await readFile(statePath, 'utf-8')
    ) as { counter: number };
    expect(after.counter).toBe(42);
  });

  it('state.json が存在しなくても初期化して lock を取得', async () => {
    // state.json が無い repo でも withStateLock は動く
    const result = await withStateLock(workDir, async () => 'ok');
    expect(result).toBe('ok');
  });
});
