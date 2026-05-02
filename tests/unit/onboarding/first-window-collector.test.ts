import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pino from 'pino';
import { AccountRepo } from '../../../src/account-state/repo.js';
import {
  FIRST_WINDOW_QUESTIONS,
  FIRST_WINDOW_QUESTION_COUNT,
  FirstWindowCollector,
} from '../../../src/onboarding/first-window-collector.js';

const logger = pino({ level: 'silent' });

let workDir: string;
async function makeRepo(): Promise<AccountRepo> {
  workDir = await mkdtemp(join(tmpdir(), 'mex-fw-'));
  await writeFile(
    join(workDir, 'account.json'),
    JSON.stringify({ account_id: 'zumi-x' }, null, 2),
    'utf-8',
  );
  await writeFile(
    join(workDir, 'state.json'),
    JSON.stringify({ account_id: 'zumi-x', current_phase: 'needs_diagnosis' }, null, 2),
    'utf-8',
  );
  return new AccountRepo(workDir);
}
afterEach(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe('FirstWindowCollector', () => {
  it('catalog has 5 questions', () => {
    expect(FIRST_WINDOW_QUESTION_COUNT).toBe(5);
    expect(FIRST_WINDOW_QUESTIONS.length).toBe(5);
  });

  it('start → answer × 5 → finalize updates account.active_window', async () => {
    const repo = await makeRepo();
    const collector = new FirstWindowCollector({ repo, logger });
    const session = await collector.start();
    expect(session.state).toBe('asking');

    await collector.answerCurrent(session.id, '副業の最初の一歩を見せる');
    await collector.answerCurrent(session.id, '具体例の蓄積');
    await collector.answerCurrent(session.id, '月 30 本投稿し、固定読者を 500 増やす');
    await collector.answerCurrent(session.id, '順番設計, 売る前の言語化');
    await collector.answerCurrent(session.id, '政治, 競合批判');

    const final = await collector.finalize(session.id);
    expect(final.session.state).toBe('completed');
    const window = final.account.active_window as Record<string, unknown>;
    expect(window.status).toBe('active');
    expect(window.label).toBe('副業の最初の一歩を見せる');
    expect(window.expertise_priority).toEqual(['順番設計', '売る前の言語化']);
    expect(window.suppress).toEqual(['政治', '競合批判']);
  });

  it('cancel marks active session cancelled', async () => {
    const repo = await makeRepo();
    const collector = new FirstWindowCollector({ repo, logger });
    const s = await collector.start();
    await collector.cancel(s.id);
    const active = await collector.getActive();
    expect(active).toBeNull();
  });

  it('required-question empty answer throws', async () => {
    const repo = await makeRepo();
    const collector = new FirstWindowCollector({ repo, logger });
    const s = await collector.start();
    await expect(collector.answerCurrent(s.id, '')).rejects.toThrow();
  });
});
