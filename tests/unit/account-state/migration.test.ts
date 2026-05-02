/**
 * schema-migration の挙動 test。
 *
 * 古い形式 (Python の dict<id, session>) → 新形式 (array) 変換、
 * 欠落 field の default 補完、不正値の修復を確認する。
 */

import { describe, it, expect } from 'vitest';
import {
  migrateAccount,
  migrateState,
} from '../../../src/account-state/index.js';

describe('migrateState', () => {
  it('dict<id, session> 形式の posting_sessions を array に変換', () => {
    const old = {
      account_id: 'x',
      posting_sessions: {
        'sess-1': { state: 'created', topic: 'foo' },
        'sess-2': { state: 'published', topic: 'bar' },
      },
    };
    const { value, changes } = migrateState(old);
    expect(Array.isArray(value.posting_sessions)).toBe(true);
    expect(value.posting_sessions).toHaveLength(2);
    expect(value.posting_sessions[0]!.id).toBe('sess-1');
    expect(value.posting_sessions[1]!.id).toBe('sess-2');
    expect(changes.some((c) => c.startsWith('posting_sessions:'))).toBe(true);
  });

  it('publish_queue の dict 形式を array に変換', () => {
    const old = {
      publish_queue: {
        'p-1': {
          content_id: 'c-1',
          scheduled_at: '2026-05-01T07:00:00+09:00',
          status: 'scheduled',
        },
      },
    };
    const { value, changes } = migrateState(old);
    expect(Array.isArray(value.publish_queue)).toBe(true);
    expect(value.publish_queue[0]!.publish_id).toBe('p-1');
    expect(changes.some((c) => c.startsWith('publish_queue:'))).toBe(true);
  });

  it('欠落 field を default で埋める', () => {
    const { value, changes } = migrateState({});
    expect(value.posting_sessions).toEqual([]);
    expect(value.publish_queue).toEqual([]);
    expect(value.skip_dates).toEqual([]);
    expect(value.last_retrospective_at).toEqual({});
    expect(value.publish_failure_tracking).toEqual({});
    expect(value.seen_event_ids).toEqual([]);
    expect(changes.length).toBeGreaterThan(0);
  });

  it('root が non-object でも空 state を返す', () => {
    const { value, changes } = migrateState(null);
    expect(value.posting_sessions).toEqual([]);
    expect(changes).toContain('root: invalid type → {}');
  });

  it('不正な session 型 (string) は空配列に置換', () => {
    const { value } = migrateState({
      posting_sessions: 'not-an-object',
    });
    expect(value.posting_sessions).toEqual([]);
  });

  it('passthrough で未知 field を保持', () => {
    const { value } = migrateState({
      account_id: 'x',
      future_runtime: { foo: 'bar' },
    });
    expect((value as Record<string, unknown>).future_runtime).toEqual({
      foo: 'bar',
    });
  });
});

describe('migrateAccount', () => {
  it('external_reference_assets の string → object 変換', () => {
    const old = {
      account_id: 'x',
      source_assets: {
        external_reference_assets: ['https://example.com/foo'],
      },
    };
    const { value, changes } = migrateAccount(old);
    const refs = (value as Record<string, unknown>).source_assets as Record<
      string,
      unknown
    >;
    const arr = refs.external_reference_assets as Array<Record<string, unknown>>;
    expect(arr[0]!.url).toBe('https://example.com/foo');
    expect(arr[0]!.label).toBe('');
    expect(
      changes.some((c) =>
        c.startsWith('source_assets.external_reference_assets[')
      )
    ).toBe(true);
  });

  it('欠落 field を default で埋める', () => {
    const { value } = migrateAccount({ account_id: 'x' });
    expect(value.operating_cadence.profile).toBe('light');
    expect(value.approval_policy.publish_requires_approval).toBe(false);
    expect(value.engagement_policy.retweet_notification).toBe('summary');
  });

  it('non-object 入力は空 account として復旧', () => {
    const { value, changes } = migrateAccount(null);
    expect(value.operating_cadence.profile).toBe('light');
    expect(changes).toContain('root: invalid type → {}');
  });
});
