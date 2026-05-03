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
    const persisted = JSON.parse(await readFile(join(scaf.workDir, 'state.json'), 'utf-8')) as {
      publish_queue: Array<{ status: string; last_error: string }>;
    };
    expect(persisted.publish_queue[0]?.status).toBe('failed_terminal');
    expect(persisted.publish_queue[0]?.last_error).toBe('cancelled_by_user');
  });

  it('対象が見つからなければ miss メッセージ', async () => {
    scaf = await setupHandlerTest({ state: { account_id: 'zumi-x', publish_queue: [] } });
    const result = await handleScheduleCancel(scaf.ctx, { publish_id: 'no_such' });
    expect(result.content).toContain('見つかりませんでした');
  });

  it("scope='all' で日付に関係なく active 全件を markFailed する", async () => {
    const now = Date.now();
    scaf = await setupHandlerTest({
      state: {
        account_id: 'zumi-x',
        publish_queue: [
          {
            publish_id: 'pub_today',
            content_id: 'c1',
            scheduled_at: new Date(now).toISOString(),
            status: 'scheduled',
            text_prefix: 'today',
            variant: 'primary',
            queued_at: '',
            executed_at: '',
            last_error: '',
          },
          {
            publish_id: 'pub_past',
            content_id: 'c2',
            scheduled_at: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
            status: 'held',
            text_prefix: 'past',
            variant: 'primary',
            queued_at: '',
            executed_at: '',
            last_error: '',
          },
          {
            publish_id: 'pub_done',
            content_id: 'c3',
            scheduled_at: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
            status: 'published',
            text_prefix: 'done',
            variant: 'primary',
            queued_at: '',
            executed_at: '',
            last_error: '',
          },
        ],
      },
    });
    const result = await handleScheduleCancel(scaf.ctx, { scope: 'all' });
    expect(result.tag).toBe('schedule.cancel.all');
    expect(result.content).toContain('2 件');

    const persisted = JSON.parse(await readFile(join(scaf.workDir, 'state.json'), 'utf-8')) as {
      publish_queue: Array<{ publish_id: string; status: string; last_error: string }>;
    };
    const byId = Object.fromEntries(persisted.publish_queue.map((item) => [item.publish_id, item]));
    expect(byId.pub_today?.status).toBe('failed_terminal');
    expect(byId.pub_today?.last_error).toBe('cancelled_by_user');
    expect(byId.pub_past?.status).toBe('failed_terminal');
    expect(byId.pub_past?.last_error).toBe('cancelled_by_user');
    expect(byId.pub_done?.status).toBe('published');
  });

  it("scope='today_all' は今日の active のみを markFailed する", async () => {
    const now = Date.now();
    scaf = await setupHandlerTest({
      state: {
        account_id: 'zumi-x',
        publish_queue: [
          {
            publish_id: 'pub_today',
            content_id: 'c1',
            scheduled_at: new Date(now).toISOString(),
            status: 'scheduled',
            text_prefix: 'today',
            variant: 'primary',
            queued_at: '',
            executed_at: '',
            last_error: '',
          },
          {
            publish_id: 'pub_past',
            content_id: 'c2',
            scheduled_at: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
            status: 'scheduled',
            text_prefix: 'past',
            variant: 'primary',
            queued_at: '',
            executed_at: '',
            last_error: '',
          },
        ],
      },
    });
    const result = await handleScheduleCancel(scaf.ctx, { scope: 'today_all' });
    expect(result.tag).toBe('schedule.cancel.today_all');
    expect(result.content).toContain('1 件');

    const persisted = JSON.parse(await readFile(join(scaf.workDir, 'state.json'), 'utf-8')) as {
      publish_queue: Array<{ publish_id: string; status: string; last_error: string }>;
    };
    const byId = Object.fromEntries(persisted.publish_queue.map((item) => [item.publish_id, item]));
    expect(byId.pub_today?.status).toBe('failed_terminal');
    expect(byId.pub_today?.last_error).toBe('cancelled_by_user');
    expect(byId.pub_past?.status).toBe('scheduled');
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
