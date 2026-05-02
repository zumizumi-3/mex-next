import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  handleScheduleList,
  handleScheduleCancel,
  handleScheduleDetail,
  handleSchedulePublishNow,
} from '../../../src/handlers/index.js';
import { setupHandlerTest, type TestHandlerScaffold } from './test-helpers.js';

let scaf: TestHandlerScaffold;

afterEach(async () => {
  await scaf?.cleanup();
});

beforeEach(() => {
  scaf = undefined as unknown as TestHandlerScaffold;
});

describe('handleScheduleList', () => {
  it('予約が無いときは「予約はありません」', async () => {
    scaf = await setupHandlerTest({
      state: { account_id: 'zumi-x', publish_queue: [] },
    });
    const result = await handleScheduleList(scaf.ctx, {});
    expect(result.content).toContain('予約はありません');
    expect(result.tag).toBe('schedule.list');
  });

  it('active items が markdown line として並ぶ', async () => {
    scaf = await setupHandlerTest({
      state: {
        account_id: 'zumi-x',
        publish_queue: [
          {
            publish_id: 'pub_001',
            content_id: 'c1',
            scheduled_at: '2026-05-03T00:00:00Z',
            status: 'scheduled',
            text_prefix: 'こんにちは世界',
            variant: 'primary',
            queued_at: '',
            executed_at: '',
            last_error: '',
          },
          {
            publish_id: 'pub_002',
            content_id: 'c2',
            scheduled_at: '2026-05-03T01:00:00Z',
            status: 'published',
            text_prefix: 'もう終わったやつ',
            variant: 'primary',
            queued_at: '',
            executed_at: '',
            last_error: '',
          },
        ],
      },
    });
    const result = await handleScheduleList(scaf.ctx, {});
    expect(result.content).toContain('pub_001');
    expect(result.content).not.toContain('pub_002'); // already published
  });
});

describe('handleScheduleCancel', () => {
  it('publish_id 指定で markFailed が反映される', async () => {
    scaf = await setupHandlerTest({
      state: {
        account_id: 'zumi-x',
        publish_queue: [
          {
            publish_id: 'pub_x',
            content_id: 'c',
            scheduled_at: '2026-05-03T00:00:00Z',
            status: 'scheduled',
            text_prefix: 'foo',
            variant: 'primary',
            queued_at: '',
            executed_at: '',
            last_error: '',
          },
        ],
      },
    });
    const result = await handleScheduleCancel(scaf.ctx, { publish_id: 'pub_x' });
    expect(result.content).toContain('pub_x');
    const persisted = JSON.parse(
      await readFile(join(scaf.workDir, 'state.json'), 'utf-8'),
    ) as { publish_queue: Array<{ status: string; last_error: string }> };
    expect(persisted.publish_queue[0]?.status).toBe('failed_terminal');
    expect(persisted.publish_queue[0]?.last_error).toBe('cancelled_by_user');
  });

  it('対象が見つからなければ miss メッセージ', async () => {
    scaf = await setupHandlerTest({ state: { account_id: 'zumi-x', publish_queue: [] } });
    const result = await handleScheduleCancel(scaf.ctx, { publish_id: 'no_such' });
    expect(result.content).toContain('見つかりませんでした');
  });
});

describe('handleScheduleDetail', () => {
  it('detail の preview を含む', async () => {
    scaf = await setupHandlerTest({
      state: {
        account_id: 'zumi-x',
        publish_queue: [
          {
            publish_id: 'pub_d',
            content_id: 'c',
            scheduled_at: '2026-05-03T00:00:00Z',
            status: 'scheduled',
            text_prefix: 'this is preview',
            variant: 'primary',
            queued_at: '',
            executed_at: '',
            last_error: '',
          },
        ],
      },
    });
    const result = await handleScheduleDetail(scaf.ctx, { publish_id: 'pub_d' });
    expect(result.content).toContain('pub_d');
    expect(result.content).toContain('preview');
  });
});

describe('handleSchedulePublishNow', () => {
  it('X API 未設定なら警告', async () => {
    scaf = await setupHandlerTest();
    const ctxNoXApi = { ...scaf.ctx };
    delete (ctxNoXApi as Partial<typeof ctxNoXApi>).xApi;
    const result = await handleSchedulePublishNow(ctxNoXApi, { publish_id: 'pub_x' });
    expect(result.content).toContain('X API client');
  });
});
