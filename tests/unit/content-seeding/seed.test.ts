/**
 * Tests for content-seeding/seed.ts.
 *
 * The fake bridge returns a generated draft body for `post_v2_generate`
 * and a passing 5-axis judge for `post_v2_quality_judge`. By providing
 * `request.topics` we skip the topic-resolution LLM call entirely so
 * tests stay deterministic.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { runSeed } from '../../../src/content-seeding/seed.js';
import { AccountRepo } from '../../../src/account-state/repo.js';
import type { LlmProvider } from '../../../src/llm/bridge.js';

const SAMPLE_DRAFT_TEXT = '朝の30分で1日の体感が変わる。先に紙で整理してから手を動かすと早い。';
const PASSING_JUDGE = JSON.stringify({
  scores: { stop_power: 4, specificity: 4, progression: 4, voice_match: 4, length_fit: 4 },
  weakest_axis: 'stop_power',
  regenerate_hint: 'もっと具体的に',
});

interface Scaffold {
  workDir: string;
  repo: AccountRepo;
  bridge: LlmProvider;
  calls: Array<{ kind: string; userPrompt: string }>;
  cleanup: () => Promise<void>;
}

async function setup(opts?: {
  draftBody?: string;
  judgePass?: boolean;
  failKinds?: ReadonlySet<string>;
  perCallDraftOverride?: (callIndex: number) => string | null;
}): Promise<Scaffold> {
  const workDir = await mkdtemp(join(tmpdir(), 'mex-seed-'));
  await writeFile(
    join(workDir, 'account.json'),
    JSON.stringify(
      {
        account_id: 'zumi-x',
        display_name: 'tester',
        voice_profile: { tone: 'calm', first_person: '私', forbidden_tones: [] },
        brand: {},
        goal_stack: [],
        writing_exemplars: [],
      },
      null,
      2,
    ),
    'utf-8',
  );
  await writeFile(
    join(workDir, 'state.json'),
    JSON.stringify({ account_id: 'zumi-x', current_phase: 'needs_diagnosis' }, null, 2),
    'utf-8',
  );

  const repo = new AccountRepo(workDir);
  const calls: Array<{ kind: string; userPrompt: string }> = [];

  let draftCallIndex = 0;
  const draftBody = opts?.draftBody ?? SAMPLE_DRAFT_TEXT;
  const judgePass = opts?.judgePass ?? true;
  const failKinds = opts?.failKinds ?? new Set<string>();

  const bridge: LlmProvider = {
    async call(opt) {
      calls.push({ kind: opt.kind, userPrompt: opt.userPrompt });
      if (failKinds.has(opt.kind)) {
        throw new Error(`forced_fail:${opt.kind}`);
      }
      if (opt.kind === 'post_v2_generate') {
        const override = opts?.perCallDraftOverride?.(draftCallIndex);
        draftCallIndex += 1;
        const body = override ?? draftBody;
        return { text: JSON.stringify({ text: body }), usage: { input: 0, output: 0 } };
      }
      if (opt.kind === 'post_v2_quality_judge') {
        const judgeText = judgePass
          ? PASSING_JUDGE
          : JSON.stringify({
              scores: { stop_power: 1, specificity: 1, progression: 1, voice_match: 4, length_fit: 4 },
              weakest_axis: 'stop_power',
              regenerate_hint: 'もっと具体的に',
            });
        return { text: judgeText, usage: { input: 0, output: 0 } };
      }
      if (opt.kind === 'content_seeding_topics') {
        return {
          text: JSON.stringify({ topics: ['朝のルーチン', '段取りの設計', '失敗の分解'] }),
          usage: { input: 0, output: 0 },
        };
      }
      return { text: '{}', usage: { input: 0, output: 0 } };
    },
  };

  return {
    workDir,
    repo,
    bridge,
    calls,
    cleanup: async () => {
      await rm(workDir, { recursive: true, force: true });
    },
  };
}

let scaf: Scaffold;
afterEach(async () => {
  await scaf?.cleanup();
});

describe('runSeed — basic generation', () => {
  it('指定 count 本のドラフトを生成する', async () => {
    scaf = await setup();
    const logger = pino({ level: 'silent' });
    const result = await runSeed({
      repo: scaf.repo,
      bridge: scaf.bridge,
      logger,
      request: { count: 3, topics: ['朝', '段取り', '失敗'] },
    });
    expect(result.generated).toHaveLength(3);
    expect(result.failed).toHaveLength(0);
    expect(result.sessionIds).toHaveLength(3);
    for (const item of result.generated) {
      expect(item.text).toContain('朝の30分');
      expect(item.state).toBe('awaiting_decision');
    }
  });

  it('失敗 1 件あっても他の topic は続行する', async () => {
    // Make the second draft body empty → validate fail → repairing state,
    // counted as generated (with state=repairing) since it produced a candidate.
    // To make a hard failure, force the draft generate kind to throw on the
    // second call by temporarily replacing the bridge.
    scaf = await setup();
    let callIndex = 0;
    const bridge: LlmProvider = {
      async call(opt) {
        scaf.calls.push({ kind: opt.kind, userPrompt: opt.userPrompt });
        if (opt.kind === 'post_v2_generate') {
          callIndex += 1;
          if (callIndex === 2) {
            throw new Error('forced_fail');
          }
          return {
            text: JSON.stringify({ text: SAMPLE_DRAFT_TEXT }),
            usage: { input: 0, output: 0 },
          };
        }
        if (opt.kind === 'post_v2_quality_judge') {
          return { text: PASSING_JUDGE, usage: { input: 0, output: 0 } };
        }
        return { text: '{}', usage: { input: 0, output: 0 } };
      },
    };
    const result = await runSeed({
      repo: scaf.repo,
      bridge,
      request: { count: 3, topics: ['t1', 't2', 't3'] },
    });
    expect(result.generated).toHaveLength(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.topic).toBe('t2');
  });

  it('count を 13 を超えて指定するとクランプされる', async () => {
    scaf = await setup();
    const result = await runSeed({
      repo: scaf.repo,
      bridge: scaf.bridge,
      request: { count: 99, topics: Array.from({ length: 13 }, (_, i) => `topic_${i}`) },
    });
    expect(result.generated.length).toBeLessThanOrEqual(13);
  });
});

describe('runSeed — approve_all', () => {
  it('approve_all=true で全ドラフトが scheduled に遷移する', async () => {
    scaf = await setup();
    const result = await runSeed({
      repo: scaf.repo,
      bridge: scaf.bridge,
      request: { count: 2, topics: ['t1', 't2'], approveAll: true },
    });
    expect(result.generated).toHaveLength(2);
    for (const item of result.generated) {
      expect(item.state).toBe('scheduled');
    }
  });

  it('seed_sessions 配列が state.json に保存される', async () => {
    scaf = await setup();
    await runSeed({
      repo: scaf.repo,
      bridge: scaf.bridge,
      request: { count: 1, topics: ['t1'] },
    });
    const persisted = JSON.parse(
      await readFile(join(scaf.workDir, 'state.json'), 'utf-8'),
    ) as { seed_sessions?: unknown[] };
    expect(Array.isArray(persisted.seed_sessions)).toBe(true);
    expect(persisted.seed_sessions!.length).toBe(1);
  });
});
