import { describe, expect, it } from 'vitest';
import { buildKnowledgeFiles } from '../../../src/account-state/knowledge-builder.js';
import { AccountJsonSchema, type AccountJson } from '../../../src/account-state/account-schema.js';

function account(input: Record<string, unknown>): AccountJson {
  return AccountJsonSchema.parse(input);
}

function uncheckedAccount(input: Record<string, unknown>): AccountJson {
  return input as unknown as AccountJson;
}

describe('buildKnowledgeFiles', () => {
  it('minimum account generates all files with fallbacks', () => {
    const files = buildKnowledgeFiles(account({ account_id: 'zumi-x' }));

    expect(Object.keys(files).sort()).toEqual([
      'AGENTS.md',
      'CLAUDE.md',
      'README.md',
      'brand.md',
      'persona.md',
      'targets.md',
      'voice-guide.md',
    ].sort());
    expect(files['AGENTS.md']).toContain('# AGENTS.md — zumi-x');
    expect(files['AGENTS.md']).toContain('- ユーザー名: @—');
    expect(files['persona.md']).toContain('| 役割 | — |');
    expect(files['brand.md']).toContain('- プロファイル: light');
    expect(files['voice-guide.md']).toContain('今後 exemplars/ から学習します。');
    expect(files['targets.md']).toContain('現在追跡対象はありません。`/mex target add @username`');
    expect(files['CLAUDE.md']).toBe(files['AGENTS.md']);
  });

  it('rich account reflects persona, brand, cadence and goal values', () => {
    const files = buildKnowledgeFiles(uncheckedAccount({
      account_id: 'acme-x',
      display_name: 'Acme運用',
      x_handle: 'acme_ops',
      persona: {
        role: 'SaaS創業者',
        archetype_label: '専門家',
        archetype_key: 'industry_expert',
        archetype_tagline: '論点を外さず判断する。',
        background: 'B2B SaaS を運営。',
        empathy: '現場の迷いに寄り添う。',
        avoid: '上から目線。',
      },
      brand: {
        primary_themes: ['SaaS営業', '導入設計'],
        voice_tone: '静かで実務的',
        forbidden: ['煽り', '断言しすぎ'],
        hashtag_policy: '原則使わない',
      },
      half_focus: '商談化率の改善',
      goal_stack: {
        objective: '月10件の相談獲得',
        recognition: '導入設計の人',
      },
      operating_cadence: {
        profile: 'standard',
        hot_zones: [{ label: '朝', start: '06:00', end: '09:00' }],
      },
    }));

    expect(files['AGENTS.md']).toContain('- 表示名: Acme運用');
    expect(files['AGENTS.md']).toContain('- ユーザー名: @acme_ops');
    expect(files['AGENTS.md']).toContain('- 主力テーマ: SaaS営業, 導入設計');
    expect(files['AGENTS.md']).toContain('- 月間目標: 月10件の相談獲得, 導入設計の人');
    expect(files['persona.md']).toContain('| 役割 | SaaS創業者 |');
    expect(files['persona.md']).toContain('B2B SaaS を運営。');
    expect(files['brand.md']).toContain('- SaaS営業');
    expect(files['brand.md']).toContain('静かで実務的');
  });

  it('targets markdown changes for empty, one and multiple targets', () => {
    const empty = buildKnowledgeFiles(account({ account_id: 'zumi-x' }));
    expect(empty['targets.md']).toContain('現在追跡対象はありません');

    const one = buildKnowledgeFiles(account({
      account_id: 'zumi-x',
      x_action_system: { tracked_targets: { usernames: ['alice'] } },
    }));
    expect(one['targets.md']).toContain('| @alice | 追跡対象 | — |');

    const many = buildKnowledgeFiles(account({
      account_id: 'zumi-x',
      tracked_targets: [
        { handle: '@alice', relationship: '競合', notes: '投稿型を見る' },
        { username: 'bob', relationship: '顧客候補', memo: 'リプ候補' },
      ],
    }));
    expect(many['targets.md']).toContain('| @alice | 競合 | 投稿型を見る |');
    expect(many['targets.md']).toContain('| @bob | 顧客候補 | リプ候補 |');
  });

  it('voice-guide uses examples when voice_profile has them', () => {
    const empty = buildKnowledgeFiles(account({ account_id: 'zumi-x' }));
    expect(empty['voice-guide.md']).toContain('今後 exemplars/ から学習します。');

    const rich = buildKnowledgeFiles(account({
      account_id: 'zumi-x',
      voice_profile: {
        examples: ['まず小さく試します。', '導入前に論点をそろえます。'],
      },
    }));
    expect(rich['voice-guide.md']).toContain('1. (短文) まず小さく試します。');
    expect(rich['voice-guide.md']).toContain('2. (中文) 導入前に論点をそろえます。');
  });
});
