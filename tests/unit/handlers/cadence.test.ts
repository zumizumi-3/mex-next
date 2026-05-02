import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  handleCadenceSkipToday,
  makeCadenceSetHandler,
} from '../../../src/handlers/index.js';
import { setupHandlerTest, type TestHandlerScaffold } from './test-helpers.js';

let scaf: TestHandlerScaffold;
afterEach(async () => {
  await scaf?.cleanup();
});

describe('handleCadenceSkipToday', () => {
  it('skip_dates に今日が追加される', async () => {
    scaf = await setupHandlerTest();
    const writeKnowledgeFiles = vi.spyOn(scaf.repo, 'writeKnowledgeFiles');
    const result = await handleCadenceSkipToday(scaf.ctx, {});
    expect(result.content).toContain('skip');
    expect(writeKnowledgeFiles).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(await readFile(join(scaf.workDir, 'state.json'), 'utf-8')) as {
      skip_dates: string[];
    };
    expect(persisted.skip_dates.length).toBeGreaterThan(0);
  });
});

describe('makeCadenceSetHandler(standard)', () => {
  it('account.json の operating_cadence.profile が standard になる', async () => {
    scaf = await setupHandlerTest();
    const writeKnowledgeFiles = vi.spyOn(scaf.repo, 'writeKnowledgeFiles');
    const handler = makeCadenceSetHandler('standard');
    const result = await handler(scaf.ctx, {});
    expect(result.content).toContain('standard');
    expect(writeKnowledgeFiles).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(await readFile(join(scaf.workDir, 'account.json'), 'utf-8')) as {
      operating_cadence?: { profile?: string };
    };
    expect(persisted.operating_cadence?.profile).toBe('standard');
  });
});
