/**
 * DiscordPosterImpl unit tests.
 *
 * The discord.js Client surface is mocked: `client.channels.fetch`
 * returns a fake text channel that records what was sent.
 */

import { describe, it, expect, vi } from 'vitest';
import { ChannelType } from 'discord.js';
import { DiscordPosterImpl, parseChannelMap } from '../../../src/discord/poster.js';

interface FakeMessage {
  id: string;
  startThread: ReturnType<typeof vi.fn>;
  edit: ReturnType<typeof vi.fn>;
}

interface FakeChannel {
  type: ChannelType;
  send: ReturnType<typeof vi.fn>;
  messages: { fetch: ReturnType<typeof vi.fn> };
}

function buildFakeChannel(): { channel: FakeChannel; sent: Array<unknown> } {
  const sent: Array<unknown> = [];
  const channel: FakeChannel = {
    type: ChannelType.GuildText,
    send: vi.fn(async (payload: unknown) => {
      sent.push(payload);
      const msg: FakeMessage = {
        id: 'msg_1',
        startThread: vi.fn(async () => ({ id: 'thread_1' })),
        edit: vi.fn(),
      };
      return msg;
    }),
    messages: {
      fetch: vi.fn(),
    },
  };
  return { channel, sent };
}

function buildFakeClient(channel: FakeChannel): { channels: { fetch: ReturnType<typeof vi.fn> } } {
  return {
    channels: {
      fetch: vi.fn(async () => channel),
    },
  };
}

describe('parseChannelMap', () => {
  it('DISCORD_CHANNEL_<ROLE> env を role -> id map に', () => {
    const env = {
      DISCORD_CHANNEL_CUSTOMER_MAIN: 'C1',
      DISCORD_CHANNEL_OPERATOR_ALERT: 'C2',
      OTHER_VAR: 'X',
    };
    const map = parseChannelMap(env as never);
    expect(map.customer_main).toBe('C1');
    expect(map.operator_alert).toBe('C2');
    expect(map.other_var).toBeUndefined();
  });
});

describe('DiscordPosterImpl', () => {
  it('postThread sends to resolved channel and creates thread', async () => {
    const { channel, sent } = buildFakeChannel();
    const fakeClient = buildFakeClient(channel);
    const poster = new DiscordPosterImpl(fakeClient as never, {
      channelMap: { customer_main: 'C1' },
    });
    const result = await poster.postThread({
      channelRole: 'customer_main',
      title: 'thread title',
      content: 'hello',
    });
    expect(sent).toHaveLength(1);
    expect((sent[0] as { content: string }).content).toBe('hello');
    expect(result.threadId).toBe('thread_1');
    expect(result.delivered).toBe(true);
  });

  it('postMessage applies silent flag', async () => {
    const { channel, sent } = buildFakeChannel();
    const fakeClient = buildFakeClient(channel);
    const poster = new DiscordPosterImpl(fakeClient as never, {
      channelMap: { customer_passive: 'CP' },
    });
    await poster.postMessage({
      channelRole: 'customer_passive',
      content: 'silent',
      silent: true,
    });
    const payload = sent[0] as { content: string; flags?: number };
    expect(payload.content).toBe('silent');
    expect(payload.flags).toBe(4096);
  });

  it('resolveChannelId throws on missing role', () => {
    const { channel } = buildFakeChannel();
    const fakeClient = buildFakeClient(channel);
    const poster = new DiscordPosterImpl(fakeClient as never, { channelMap: {} });
    expect(() => poster.resolveChannelId('missing_role')).toThrow(/channel role not configured/);
  });

  it('postEscalation posts a single message (no thread)', async () => {
    const { channel, sent } = buildFakeChannel();
    const fakeClient = buildFakeClient(channel);
    const poster = new DiscordPosterImpl(fakeClient as never, {
      channelMap: { operator: 'OP1' },
    });
    const result = await poster.postEscalation({
      channelRole: 'operator',
      content: 'urgent',
    });
    expect(sent).toHaveLength(1);
    expect(result.delivered).toBe(true);
    // postEscalation maps messageId == threadId since there's no thread
    expect(result.threadId).toBe(result.messageId);
  });
});
