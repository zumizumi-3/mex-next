import { describe, expect, it, vi } from 'vitest';
import {
  createProgressIndicator,
  type EditableMessage,
  type ProgressChannel,
} from '../../../src/discord/progress-indicator.js';

interface MockMessage extends EditableMessage {
  edits: string[];
}

function makeMockChannelAndMessage(): { channel: ProgressChannel; message: MockMessage } {
  const message: MockMessage = {
    edits: [],
    edit: vi.fn(async (content: string) => {
      message.edits.push(content);
    }),
  };
  const channel: ProgressChannel = {
    send: vi.fn(async (_content: string) => message),
  };
  return { channel, message };
}

describe('createProgressIndicator', () => {
  it('sends a starting message and edits to ✅ on done', async () => {
    const { channel, message } = makeMockChannelAndMessage();
    const indicator = createProgressIndicator({ channel });
    await indicator.start();

    expect(channel.send).toHaveBeenCalledTimes(1);
    const sent = (channel.send as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(sent).toContain('⏳');

    await indicator.done();
    expect(message.edits.length).toBe(1);
    expect(message.edits[0]).toContain('✅');
    expect(indicator.state).toBe('done');
  });

  it('updates intermediate status before done', async () => {
    const { channel, message } = makeMockChannelAndMessage();
    const indicator = createProgressIndicator({ channel });
    await indicator.start();
    await indicator.updateStatus('考え中');
    await indicator.updateStatus('考え中'); // duplicate ignored
    await indicator.updateStatus('草稿生成中');
    await indicator.done();

    expect(message.edits.length).toBe(3);
    expect(message.edits[0]).toContain('考え中');
    expect(message.edits[1]).toContain('草稿生成中');
    expect(message.edits[2]).toContain('✅');
  });

  it('flips to ❌ on failed', async () => {
    const { channel, message } = makeMockChannelAndMessage();
    const indicator = createProgressIndicator({ channel });
    await indicator.start();
    await indicator.failed();
    expect(message.edits.at(-1)).toContain('❌');
    expect(indicator.state).toBe('failed');
  });

  it('flips to 🛑 on cancelled', async () => {
    const { channel, message } = makeMockChannelAndMessage();
    const indicator = createProgressIndicator({ channel });
    await indicator.start();
    await indicator.cancelled();
    expect(message.edits.at(-1)).toContain('🛑');
    expect(indicator.state).toBe('cancelled');
  });

  it('is a no-op when send fails (degrades silently)', async () => {
    const channel: ProgressChannel = {
      send: vi.fn(async () => {
        throw new Error('discord 503');
      }),
    };
    const indicator = createProgressIndicator({ channel });
    await indicator.start();
    // updateStatus and done must not throw
    await indicator.updateStatus('whatever');
    await indicator.done();
    expect(indicator.state).toBe('done');
  });

  it('ignores updateStatus before start()', async () => {
    const { channel, message } = makeMockChannelAndMessage();
    const indicator = createProgressIndicator({ channel });
    await indicator.updateStatus('too early');
    expect(channel.send).not.toHaveBeenCalled();
    expect(message.edits).toEqual([]);
  });

  it('ignores transitions after a terminal state', async () => {
    const { channel, message } = makeMockChannelAndMessage();
    const indicator = createProgressIndicator({ channel });
    await indicator.start();
    await indicator.done();
    await indicator.failed(); // ignored
    await indicator.cancelled(); // ignored
    expect(indicator.state).toBe('done');
    expect(message.edits.length).toBe(1);
  });

  it('applies an optional prefix to all messages', async () => {
    const { channel, message } = makeMockChannelAndMessage();
    const indicator = createProgressIndicator({ channel, prefix: '[Posting]' });
    await indicator.start();
    await indicator.done();
    const sent = (channel.send as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(sent.startsWith('[Posting] ')).toBe(true);
    expect(message.edits[0].startsWith('[Posting] ')).toBe(true);
  });
});
