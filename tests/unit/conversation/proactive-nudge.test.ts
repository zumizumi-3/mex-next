import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from 'pino';
import { emitNudge } from '../../../src/conversation/proactive-nudge.js';
import type { LlmProvider } from '../../../src/llm/bridge.js';
import type { DiscordPoster } from '../../../src/posting/collectors/types.js';
import { InMemoryAccountRepo } from '../fixtures/in-memory-repo.js';

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(() => makeLogger()),
  } as unknown as Logger;
}

function makeBridge(
  text = JSON.stringify({
    summary: '先週は専門性を出す方針でした。',
    options: ['維持', '実績を強める', '対象を変える'],
  }),
): LlmProvider {
  return {
    call: vi.fn(async () => ({ text, usage: { input: 0, output: 0 } })),
  };
}

function makePoster(): DiscordPoster {
  return {
    postThread: vi.fn(async () => ({ threadId: 'th-1', messageId: 'm-1', delivered: true })),
    postEscalation: vi.fn(async () => ({
      threadId: 'th-esc',
      messageId: 'm-esc',
      delivered: true,
    })),
  };
}

describe('emitNudge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-03T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('weekly_phase_review は直近 weekly phase_history を LLM に渡して Discord に投稿する', async () => {
    const repo = new InMemoryAccountRepo({
      account: {
        account_id: 'zumi-x',
        phase_history: [
          { cadence: 'monthly', summary: '月次', updated_at: '2026-04-01T00:00:00Z' },
          { cadence: 'weekly', summary: '週次', updated_at: '2026-04-28T00:00:00Z' },
        ],
      },
    });
    const bridge = makeBridge();
    const poster = makePoster();

    const result = await emitNudge(
      { repo, bridge, poster, logger: makeLogger() },
      'weekly_phase_review',
    );

    expect(result).toEqual({ posted: true });
    expect(bridge.call).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'proactive_nudge_generate',
        userPrompt: expect.stringContaining('"weekly_phase_review"'),
      }),
    );
    expect(bridge.call).toHaveBeenCalledWith(
      expect.objectContaining({
        userPrompt: expect.stringContaining('"週次"'),
      }),
    );
    expect(poster.postThread).toHaveBeenCalledWith(
      expect.objectContaining({
        channelRole: 'customer_attention',
        title: '週初の方針確認',
        content: expect.stringContaining('今週どうしますか?'),
      }),
    );
  });

  it('monthly_phase_review は monthly cadence の nudge を投稿する', async () => {
    const repo = new InMemoryAccountRepo({
      account: {
        account_id: 'zumi-x',
        phase_history: [
          { cadence: 'monthly', summary: '先月は採用向け', updated_at: '2026-05-01T00:00:00Z' },
        ],
      },
    });
    const bridge = makeBridge(
      JSON.stringify({
        summary: '先月は採用向けでした。',
        options: ['維持', '発信量を増やす', '読者を変える'],
      }),
    );
    const poster = makePoster();

    const result = await emitNudge(
      { repo, bridge, poster, logger: makeLogger() },
      'monthly_phase_review',
    );

    expect(result.posted).toBe(true);
    expect(bridge.call).toHaveBeenCalledWith(
      expect.objectContaining({ userPrompt: expect.stringContaining('"monthly_phase_review"') }),
    );
    expect(poster.postThread).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '月初の方針確認',
        content: expect.stringContaining('今月どうしますか?'),
      }),
    );
  });

  it('stale_target_review は 1 週間候補がない target の見直しを投稿し、LLM は呼ばない', async () => {
    const repo = new InMemoryAccountRepo({
      account: {
        account_id: 'zumi-x',
        x_action_system: { tracked_targets: { usernames: ['alice', 'bob'] } },
      },
      state: {
        target_discovery_sessions: {
          recent: {
            event_id: 'recent',
            target_handle: 'bob',
            created_at: '2026-05-01T00:00:00Z',
          },
        },
      },
    });
    const bridge = makeBridge();
    const poster = makePoster();

    const result = await emitNudge(
      { repo, bridge, poster, logger: makeLogger() },
      'stale_target_review',
    );

    expect(result).toEqual({ posted: true });
    expect(bridge.call).not.toHaveBeenCalled();
    expect(poster.postThread).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '追跡対象の見直し',
        content: expect.stringContaining('@alice'),
        metadata: expect.objectContaining({ handles: ['alice'] }),
      }),
    );
  });

  it('unanswered_phase_followup は 3 日以上止まった phase questionnaire を促す', async () => {
    const repo = new InMemoryAccountRepo({
      state: {
        phase_questionnaire_sessions: [
          {
            id: 'pq_1',
            cadence: 'weekly',
            status: 'awaiting_answers',
            startedAt: '2026-04-28T00:00:00Z',
          },
        ],
      },
    });
    const poster = makePoster();

    const result = await emitNudge(
      { repo, bridge: makeBridge(), poster, logger: makeLogger() },
      'unanswered_phase_followup',
    );

    expect(result).toEqual({ posted: true });
    expect(poster.postThread).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '途中の方針確認',
        content: expect.stringContaining('続きやりますか?'),
        metadata: expect.objectContaining({ sessionId: 'pq_1' }),
      }),
    );
  });

  it('エラー時は throw せず posted=false を返す', async () => {
    const repo = new InMemoryAccountRepo({
      account: {
        account_id: 'zumi-x',
        phase_history: [{ cadence: 'weekly', summary: 'x', updated_at: '2026-04-28T00:00:00Z' }],
      },
    });
    const poster = makePoster();
    const bridge: LlmProvider = {
      call: vi.fn(async () => {
        throw new Error('llm down');
      }),
    };

    await expect(
      emitNudge({ repo, bridge, poster, logger: makeLogger() }, 'weekly_phase_review'),
    ).resolves.toEqual({ posted: false, reason: 'error' });
    expect(poster.postThread).not.toHaveBeenCalled();
  });
});
