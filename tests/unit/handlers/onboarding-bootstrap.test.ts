/**
 * Tests for the fire-and-forget bootstrap path in onboarding handler.
 *
 * Goals:
 *  1. `runBootstrapFirstDraftInBackground` returns *before* the LLM
 *     bridge has resolved — proves we don't block the customer-facing
 *     reply on a 30-second pipeline.
 *  2. On failure inside the pipeline, an operator escalation post is
 *     emitted via `discordPoster.postEscalation` so the operator can
 *     investigate before the customer notices.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { AccountRepo } from '../../../src/account-state/repo.js';
import { runBootstrapFirstDraftInBackground } from '../../../src/handlers/onboarding.js';
import type { HandlerContext } from '../../../src/handlers/types.js';
import type { LlmProvider } from '../../../src/llm/bridge.js';
import type { DiscordPoster } from '../../../src/posting/collectors/types.js';
import type { XApiSurface } from '../../../src/x-api/types.js';

interface Scaffold {
  ctx: HandlerContext;
  workDir: string;
  postEscalation: ReturnType<typeof vi.fn>;
  postThread: ReturnType<typeof vi.fn>;
  cleanup: () => Promise<void>;
}

async function setup(opts: {
  bridgeBehaviour: 'fail-fast' | 'slow-success';
}): Promise<Scaffold> {
  const workDir = await mkdtemp(join(tmpdir(), 'mex-bootstrap-'));
  await writeFile(
    join(workDir, 'account.json'),
    JSON.stringify({ account_id: 'zumi-x', display_name: 'tester', voice_profile: { tone: 'calm', first_person: '私', forbidden_tones: [] }, brand: {}, goal_stack: [], writing_exemplars: [] }, null, 2),
    'utf-8',
  );
  await writeFile(
    join(workDir, 'state.json'),
    JSON.stringify({ account_id: 'zumi-x', current_phase: 'needs_diagnosis' }, null, 2),
    'utf-8',
  );

  const repo = new AccountRepo(workDir);

  const bridge: LlmProvider = {
    async call(opt) {
      if (opts.bridgeBehaviour === 'fail-fast') {
        throw new Error('forced LLM failure');
      }
      // slow-success — sleep 200ms so we can prove the foreground
      // handler returned earlier than this resolves.
      await new Promise((r) => setTimeout(r, 200));
      if (opt.kind === 'post_v2_generate') {
        return { text: JSON.stringify({ text: '朝の30分で動きが変わる。先に紙で整理。' }), usage: { input: 0, output: 0 } };
      }
      if (opt.kind === 'post_v2_quality_judge') {
        return {
          text: JSON.stringify({
            scores: { stop_power: 4, specificity: 4, progression: 4, voice_match: 4, length_fit: 4 },
            weakest_axis: 'stop_power',
            regenerate_hint: '',
          }),
          usage: { input: 0, output: 0 },
        };
      }
      return { text: '{}', usage: { input: 0, output: 0 } };
    },
  };

  const xApi: XApiSurface = {
    async post() { return { id: 't1' }; },
    async getMentions() { return []; },
    async searchRecent() { return []; },
    async getUserTweets() { return []; },
    async getUserByHandle(handle) { return { id: 'u1', name: 't', handle }; },
    async getTrends() { return []; },
    async deleteTweet() { return undefined; },
    async likeTweet() { return undefined; },
  };

  const postThread = vi.fn(async () => ({ threadId: 'th_1', messageId: 'msg_1', delivered: true }));
  const postEscalation = vi.fn(async () => ({ threadId: 'th_e', messageId: 'msg_e', delivered: true }));
  const discordPoster: DiscordPoster = { postThread, postEscalation };

  const ctx: HandlerContext = {
    accountId: 'zumi-x',
    repo,
    bridge,
    xApi,
    discordPoster,
    logger: pino({ level: 'silent' }),
    operatorDiscordUserIds: ['oper-1'],
  };

  return {
    ctx,
    workDir,
    postEscalation,
    postThread,
    cleanup: async () => {
      await rm(workDir, { recursive: true, force: true });
    },
  };
}

let scaf: Scaffold;
afterEach(async () => {
  await scaf?.cleanup();
});

describe('runBootstrapFirstDraftInBackground', () => {
  it('does not block the foreground caller (returns before slow LLM resolves)', async () => {
    scaf = await setup({ bridgeBehaviour: 'slow-success' });

    const t0 = Date.now();
    const tracking = runBootstrapFirstDraftInBackground(scaf.ctx);
    const elapsed = Date.now() - t0;
    // Foreground returns immediately — must be well under the bridge's
    // 200ms-per-call delay (3 LLM calls = 600ms baseline).
    expect(elapsed).toBeLessThan(80);

    // Wait for background to settle so we don't leak into other tests.
    await tracking;

    // The slow-success path should have posted the draft thread.
    expect(scaf.postThread).toHaveBeenCalled();
  });

  it('escalates to operator on pipeline failure', async () => {
    scaf = await setup({ bridgeBehaviour: 'fail-fast' });

    await runBootstrapFirstDraftInBackground(scaf.ctx);

    expect(scaf.postEscalation).toHaveBeenCalledTimes(1);
    const call = scaf.postEscalation.mock.calls[0][0] as { content: string; channelRole: string };
    expect(call.channelRole).toBe('operator');
    expect(call.content).toContain('onboarding bootstrap');
    expect(call.content).toContain('<@oper-1>');
  });
});
