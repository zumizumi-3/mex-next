/**
 * account-schema / state-schema の compat test。
 *
 * Python 版 starter (`templates/starter/{account,state}.json`) を fixture として
 * 読み込み、migrate → parse が成功することを確認する。
 */

import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AccountJsonSchema,
  StateJsonSchema,
  migrateAccount,
  migrateState,
} from '../../../src/account-state/index.js';

const FIXTURES_DIR = join(process.cwd(), 'tests', 'fixtures');

async function loadFixture(name: string): Promise<unknown> {
  const raw = await readFile(join(FIXTURES_DIR, name), 'utf-8');
  return JSON.parse(raw);
}

describe('AccountJsonSchema', () => {
  it('Python starter account.json を migrate して parse できる', async () => {
    const raw = await loadFixture('python-mex-account.json');
    const { value, changes } = migrateAccount(raw);

    expect(value.account_id).toBe('replace_me');
    expect(value.operating_cadence.profile).toBe('light');
    expect(value.operating_cadence.hot_zones).toEqual([
      { start: '06:00', end: '09:00', label: '朝' },
    ]);
    // Python 側に `persona` field は無いので default で埋まる
    expect(value.persona).toBe('');
    // changes は migration log として返る
    expect(Array.isArray(changes)).toBe(true);
  });

  it('未知 field は passthrough で保持する (forward compat)', () => {
    const input = {
      account_id: 'zumi-x',
      future_field: { foo: 'bar' },
      brand: { target_reader: ['副業者'] },
    };
    const parsed = AccountJsonSchema.parse(input);
    expect((parsed as Record<string, unknown>).future_field).toEqual({
      foo: 'bar',
    });
  });

  it('欠落 field は default で埋まる', () => {
    const parsed = AccountJsonSchema.parse({ account_id: 'x' });
    expect(parsed.operating_cadence.profile).toBe('light');
    expect(parsed.approval_policy.publish_requires_approval).toBe(false);
    expect(parsed.x_action_system.tracked_targets.usernames).toEqual([]);
  });
});

describe('StateJsonSchema', () => {
  it('Python starter state.json を migrate して parse できる', async () => {
    const raw = await loadFixture('python-mex-state.json');
    const { value, changes } = migrateState(raw);

    expect(value.account_id).toBe('replace_me');
    expect(value.current_phase).toBe('needs_diagnosis');
    expect(Array.isArray(value.posting_sessions)).toBe(true);
    expect(Array.isArray(value.publish_queue)).toBe(true);
    // Python 版に無い field が migration で追加された
    expect(changes.length).toBeGreaterThan(0);
  });

  it('TERMINAL state 列挙を持つ', async () => {
    const { TERMINAL_POSTING_STATES } = await import(
      '../../../src/account-state/index.js'
    );
    expect(TERMINAL_POSTING_STATES).toContain('published');
    expect(TERMINAL_POSTING_STATES).toContain('failed_terminal');
    expect(TERMINAL_POSTING_STATES).toContain('expired');
  });

  it('publish_queue の status enum を validate', () => {
    const parsed = StateJsonSchema.parse({
      publish_queue: [
        {
          publish_id: 'p-1',
          content_id: 'c-1',
          scheduled_at: '2026-05-02T07:00:00+09:00',
          status: 'scheduled',
        },
      ],
    });
    expect(parsed.publish_queue[0]!.status).toBe('scheduled');
  });
});
