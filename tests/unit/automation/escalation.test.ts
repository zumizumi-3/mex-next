/**
 * Tests for escalation-state (dedup window) と operator-escalation (poster wiring)。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountRepo } from '../../../src/account-state/repo.js';
import {
  shouldEscalate,
  recordEscalation,
} from '../../../src/automation/escalation-state.js';
import { escalateOperator } from '../../../src/automation/operator-escalation.js';
import type { AppConfig } from '../../../src/config.js';
import type { DiscordPoster } from '../../../src/posting/collectors/types.js';

let workDir: string;
let repo: AccountRepo;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'mex-next-escalation-'));
  await writeFile(
    join(workDir, 'account.json'),
    JSON.stringify({ account_id: 'zumi-x' }),
    'utf-8',
  );
  await writeFile(
    join(workDir, 'state.json'),
    JSON.stringify({ account_id: 'zumi-x' }),
    'utf-8',
  );
  repo = new AccountRepo(workDir);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function makeConfig(): AppConfig {
  return {
    accountId: 'zumi-x',
    accountRepo: workDir,
    discordBotToken: 'tok',
    anthropicApiKey: 'anth',
    xApiConsumerKey: 'ck',
    xApiConsumerSecret: 'cs',
    xApiAccessToken: 'at',
    xApiAccessTokenSecret: 'ats',
    operatorDiscordUserIds: ['oper-1'],
    githubToken: undefined,
    logLevel: 'info',
  };
}

function makePoster(): DiscordPoster & {
  postEscalation: ReturnType<typeof vi.fn>;
  postThread: ReturnType<typeof vi.fn>;
} {
  return {
    postThread: vi.fn(async () => ({ threadId: 't', messageId: 'm', delivered: true })),
    postEscalation: vi.fn(async () => ({
      threadId: 't-esc',
      messageId: 'm-esc',
      delivered: true,
    })),
  };
}

describe('shouldEscalate', () => {
  it('初回 → shouldEmit=true, failCount=1', async () => {
    const result = await shouldEscalate({
      repo,
      reason: 'doppler down',
    });
    expect(result.shouldEmit).toBe(true);
    expect(result.failCount).toBe(1);
  });

  it('10 分以内に同 reason → shouldEmit=false, failCount 増加', async () => {
    const t0 = new Date('2026-05-02T10:00:00Z');
    const t1 = new Date('2026-05-02T10:05:00Z');
    await shouldEscalate({ repo, reason: 'doppler down', now: () => t0 });
    const second = await shouldEscalate({
      repo,
      reason: 'doppler down',
      now: () => t1,
    });
    expect(second.shouldEmit).toBe(false);
    expect(second.failCount).toBe(2);
  });

  it('window 経過後は再度 emit', async () => {
    const t0 = new Date('2026-05-02T10:00:00Z');
    const t1 = new Date('2026-05-02T10:11:00Z');
    await shouldEscalate({ repo, reason: 'x api down', now: () => t0 });
    const second = await shouldEscalate({
      repo,
      reason: 'x api down',
      now: () => t1,
    });
    expect(second.shouldEmit).toBe(true);
    expect(second.failCount).toBe(2);
  });

  it('windowMinutes を override 可能', async () => {
    const t0 = new Date('2026-05-02T10:00:00Z');
    const t1 = new Date('2026-05-02T10:01:30Z');
    await shouldEscalate({
      repo,
      reason: 'fast',
      windowMinutes: 1,
      now: () => t0,
    });
    const second = await shouldEscalate({
      repo,
      reason: 'fast',
      windowMinutes: 1,
      now: () => t1,
    });
    expect(second.shouldEmit).toBe(true);
  });

  it('別 reason は独立した dedup', async () => {
    const t0 = new Date('2026-05-02T10:00:00Z');
    await shouldEscalate({ repo, reason: 'r1', now: () => t0 });
    const r2 = await shouldEscalate({ repo, reason: 'r2', now: () => t0 });
    expect(r2.shouldEmit).toBe(true);
    expect(r2.failCount).toBe(1);
  });

  it('recordEscalation で emitted=true を反映できる', async () => {
    const t0 = new Date('2026-05-02T10:00:00Z');
    await recordEscalation({
      repo,
      reason: 'manual',
      emitted: true,
      now: () => t0,
    });
    const state = await repo.readStateWithMigration();
    const recent = (state.value as unknown as Record<string, unknown>)
      .operator_escalation_recent as Array<{ reason: string; lastEmittedAt: string }>;
    expect(recent).toHaveLength(1);
    expect(recent[0].reason).toBe('manual');
    expect(recent[0].lastEmittedAt).toBe(t0.toISOString());
  });
});

describe('escalateOperator', () => {
  it('poster.postEscalation を 1 回呼び、operator mention を含む', async () => {
    const poster = makePoster();
    const result = await escalateOperator({
      reason: 'preflight failed',
      detail: 'gate:doppler_token_alive — invalid token',
      hint: 'Doppler dashboard で token 再発行',
      accountId: 'zumi-x',
      poster,
      config: makeConfig(),
      repo,
    });
    expect(result.emitted).toBe(true);
    expect(poster.postEscalation).toHaveBeenCalledTimes(1);
    const call = poster.postEscalation.mock.calls[0][0];
    expect(call.channelRole).toBe('operator');
    expect(call.content).toContain('<@oper-1>');
    expect(call.content).toContain('preflight failed');
    expect(call.content).toContain('Doppler dashboard');
    expect(call.metadata).toMatchObject({
      reason: 'preflight failed',
      accountId: 'zumi-x',
      failCount: 1,
    });
  });

  it('operator id 未設定 → mention skipped (skip 文言を含む)', async () => {
    const poster = makePoster();
    const config = { ...makeConfig(), operatorDiscordUserIds: [] };
    const result = await escalateOperator({
      reason: 'no operator',
      accountId: 'zumi-x',
      poster,
      config,
      repo,
    });
    expect(result.emitted).toBe(true);
    const call = poster.postEscalation.mock.calls[0][0];
    expect(call.content).toContain('mention skipped');
    expect(call.content).not.toContain('<@>');
  });

  it('10 分以内の重複は skip — postEscalation 呼ばれない', async () => {
    const poster = makePoster();
    const t0 = new Date('2026-05-02T10:00:00Z');
    const t1 = new Date('2026-05-02T10:03:00Z');
    await escalateOperator({
      reason: 'dup',
      accountId: 'zumi-x',
      poster,
      config: makeConfig(),
      repo,
      now: () => t0,
    });
    const second = await escalateOperator({
      reason: 'dup',
      accountId: 'zumi-x',
      poster,
      config: makeConfig(),
      repo,
      now: () => t1,
    });
    expect(second.emitted).toBe(false);
    expect(second.skipped).toBe(true);
    expect(second.failCount).toBe(2);
    expect(poster.postEscalation).toHaveBeenCalledTimes(1);
  });

  it('failCount >= 2 のときは header に倍率を表示', async () => {
    const poster = makePoster();
    const t0 = new Date('2026-05-02T10:00:00Z');
    const t1 = new Date('2026-05-02T10:11:00Z');
    await escalateOperator({
      reason: 'spam',
      accountId: 'zumi-x',
      poster,
      config: makeConfig(),
      repo,
      now: () => t0,
    });
    await escalateOperator({
      reason: 'spam',
      accountId: 'zumi-x',
      poster,
      config: makeConfig(),
      repo,
      now: () => t1,
    });
    const secondCall = poster.postEscalation.mock.calls[1][0];
    expect(secondCall.content).toContain('x2');
  });

  it('windowMinutes を override すると dedup window が短くなる', async () => {
    const poster = makePoster();
    const t0 = new Date('2026-05-02T10:00:00Z');
    const t1 = new Date('2026-05-02T10:02:00Z');
    await escalateOperator({
      reason: 'fast-dup',
      accountId: 'zumi-x',
      poster,
      config: makeConfig(),
      repo,
      windowMinutes: 1,
      now: () => t0,
    });
    const second = await escalateOperator({
      reason: 'fast-dup',
      accountId: 'zumi-x',
      poster,
      config: makeConfig(),
      repo,
      windowMinutes: 1,
      now: () => t1,
    });
    expect(second.emitted).toBe(true);
    expect(poster.postEscalation).toHaveBeenCalledTimes(2);
  });

  it('detail を含めたとき code-fence で囲む', async () => {
    const poster = makePoster();
    await escalateOperator({
      reason: 'with detail',
      detail: 'Error: stack trace line 1\n  at foo()',
      accountId: 'zumi-x',
      poster,
      config: makeConfig(),
      repo,
    });
    const call = poster.postEscalation.mock.calls[0][0];
    expect(call.content).toContain('```');
    expect(call.content).toContain('stack trace');
  });

  it('poster が throw すると EscalateDeliveryError を再 throw', async () => {
    const poster: DiscordPoster = {
      postThread: vi.fn(),
      postEscalation: vi.fn(async () => {
        throw new Error('discord 500');
      }),
    };
    await expect(
      escalateOperator({
        reason: 'err',
        accountId: 'zumi-x',
        poster,
        config: makeConfig(),
        repo,
      }),
    ).rejects.toMatchObject({ name: 'EscalateDeliveryError' });
  });
});
