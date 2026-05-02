import type { AccountJson, HotZone } from './account-schema.js';

export interface KnowledgeBuildOptions {
  readonly recentExemplars?: ReadonlyArray<{
    readonly id: string;
    readonly topic: string;
    readonly createdAt: string;
    readonly relativePath: string;
  }>;
}

export interface KnowledgeFiles {
  readonly 'AGENTS.md': string;
  readonly 'CLAUDE.md': string;
  readonly 'persona.md': string;
  readonly 'brand.md': string;
  readonly 'voice-guide.md': string;
  readonly 'targets.md': string;
  readonly 'README.md': string;
}

interface PersonaKnowledge {
  readonly role: string;
  readonly archetypeLabel: string;
  readonly archetypeKey: string;
  readonly archetypeTagline: string;
  readonly background: string;
  readonly empathy: string;
  readonly avoid: string;
}

interface TargetRow {
  readonly handle: string;
  readonly relationship: string;
  readonly notes: string;
}

const DASH = '—';

const PERSONA_ARCHETYPES: Record<string, { label: string; tagline: string }> = {
  practical_operator: {
    label: '実務家',
    tagline: '副業は気合いより、先に導線設計だ。',
  },
  corporate_partner: {
    label: '伴走パートナー',
    tagline: '事業の詰まりは、気合いではなく設計でほどけます。',
  },
  industry_expert: {
    label: '専門家',
    tagline: '論点を外さなければ、判断はぶれません。',
  },
  sharp_mentor: {
    label: '厳しめメンター',
    tagline: '理想を語る前に、まず売れ。',
  },
  close_guide: {
    label: '伴走ガイド',
    tagline: '怖くて普通です。小さく始めれば大丈夫です。',
  },
  builder_experimenter: {
    label: '実験家',
    tagline: 'まず試す。比べる。残す。',
  },
};

export function buildKnowledgeFiles(account: AccountJson, opts: KnowledgeBuildOptions = {}): KnowledgeFiles {
  const accountId = text(account.account_id);
  const displayName = text(account.display_name) || accountId || DASH;
  const xHandle = normalizeHandle(valueAt(account, 'x_handle') ?? valueAt(account, 'x_username'));
  const persona = personaKnowledge(account);
  const primaryThemes = brandPrimaryThemes(account);
  const voiceTone = brandVoiceTone(account);
  const forbidden = forbiddenItems(account);
  const halfFocus = text(account.half_focus);
  const goals = goalItems(account);
  const cadenceProfile = text(account.operating_cadence?.profile);
  const hotZones = hotZoneItems(account.operating_cadence?.hot_zones);
  const targets = targetRows(account);

  const exemplarSection = buildExemplarSection(opts.recentExemplars ?? []);

  const agents = withFinalNewline(`# AGENTS.md — ${accountId || DASH}

このリポジトリは MeX Next が運用する **${displayName}** の X (Twitter) アカウント運用 OS データです。Codex / Claude Code がここで作業する時は、以下の **per-account ルール** を最優先で守ってください。

## ペルソナ
- 表示名: ${displayName}
- ユーザー名: @${xHandle || DASH}
- 役割: ${persona.role}
- 人格: ${persona.archetypeLabel} (${persona.archetypeKey}) — ${persona.archetypeTagline}

詳細: [persona.md](./persona.md)

## ブランド / 声
- 主力テーマ: ${inlineList(primaryThemes)}
- 口調: ${voiceTone}
- NG ワード / 禁忌: ${inlineList(forbidden)}
- 投稿ガイド: [brand.md](./brand.md) / [voice-guide.md](./voice-guide.md)

## 目標 / 運用
- 半期重点: ${halfFocus || DASH}
- 月間目標: ${inlineList(goals)}
- 投稿頻度プロファイル: ${cadenceProfile || DASH}
- ホットゾーン: ${inlineList(hotZones)}

## 追跡対象 (target accounts)
- 件数: ${targets.length}
- 詳細: [targets.md](./targets.md)

## 守ってほしい原則
1. 顧客は Discord でしか話さない。GitHub UI を触らせない。
2. 投稿案を作る時は brand.md / voice-guide.md / persona.md を必ず参照。
3. NG ワードを含む内容は生成しない。
4. 目標から外れる提案 (例: 違うジャンル) はしない。
5. 修正履歴は exemplars/ にあるので、似た過去の修正パターンを再現しない。

## state.json / account.json は触らない
これらは bot が runtime で読み書きする。手で編集しないこと。markdown 側の変更は bot が次回 finalize 時に上書きする。${exemplarSection}`);

  return {
    'AGENTS.md': agents,
    'CLAUDE.md': agents,
    'persona.md': buildPersonaMarkdown(displayName, xHandle, persona),
    'brand.md': buildBrandMarkdown(displayName, primaryThemes, voiceTone, forbidden, account),
    'voice-guide.md': buildVoiceGuideMarkdown(displayName, account),
    'targets.md': buildTargetsMarkdown(displayName, targets),
    'README.md': buildReadmeMarkdown(accountId || DASH),
  };
}

function buildExemplarSection(
  exemplars: ReadonlyArray<{
    readonly topic: string;
    readonly createdAt: string;
    readonly relativePath: string;
  }>,
): string {
  if (exemplars.length === 0) return '';
  const lines = exemplars.map((exemplar) => {
    const topic = text(exemplar.topic) || basenameWithoutExt(exemplar.relativePath) || DASH;
    const createdAt = text(exemplar.createdAt) || DASH;
    const path = exemplar.relativePath.startsWith('./')
      ? exemplar.relativePath
      : `./${exemplar.relativePath}`;
    return `- [${topic}](${path}) (${createdAt})`;
  });
  return `

## 学習素材 (exemplars)

過去の draft → 顧客修正の差分が markdown で残っています。投稿案を作る時は **直近の修正パターンを再現しないこと**:

${lines.join('\n')}`;
}

function buildPersonaMarkdown(
  displayName: string,
  xHandle: string,
  persona: PersonaKnowledge,
): string {
  return withFinalNewline(`# Persona — ${displayName}

## 基本情報
| 項目 | 値 |
|---|---|
| 表示名 | ${displayName} |
| ユーザー名 | @${xHandle || DASH} |
| 役割 | ${persona.role} |
| 人格タイプ | ${persona.archetypeLabel} (${persona.archetypeKey}) |

## 信念 / トーン
> ${persona.archetypeTagline}

## バックグラウンド
${persona.background}

## 共感ポイント
${persona.empathy}

## 避けたい印象
${persona.avoid}`);
}

function buildBrandMarkdown(
  displayName: string,
  primaryThemes: readonly string[],
  voiceTone: string,
  forbidden: readonly string[],
  account: AccountJson,
): string {
  const hashtagPolicy = text(
    valueAt(account.brand, 'hashtag_policy') ?? valueAt(account.brand, 'hashtags'),
  );
  const hotZones = account.operating_cadence?.hot_zones ?? [];
  const hotZoneLines = hotZones.length > 0
    ? hotZones.map((z) => `  - ${text(z.label) || DASH}: ${text(z.start) || DASH}-${text(z.end) || DASH}`).join('\n')
    : `  - ${DASH}`;

  return withFinalNewline(`# Brand — ${displayName}

## 主力テーマ
${bulletList(primaryThemes)}

## 口調 / 声色
${voiceTone}

## ストップワード / NG
${bulletList(forbidden)}

## ハッシュタグ運用
${hashtagPolicy || DASH}

## カデンス
- プロファイル: ${text(account.operating_cadence?.profile) || DASH}
- ホットゾーン:
${hotZoneLines}`);
}

function buildVoiceGuideMarkdown(displayName: string, account: AccountJson): string {
  const examples = voiceExamples(account);
  const body = examples.length > 0
    ? examples.map((example, index) => `${index + 1}. (${example.label}) ${example.text}`).join('\n')
    : '今後 exemplars/ から学習します。';

  return withFinalNewline(`# Voice Guide — ${displayName}

語尾 / 構文の典型例。bot が生成した投稿が この文体感から外れていたら brand.md の "口調" を見直してください。

## 例
${body}`);
}

function buildTargetsMarkdown(displayName: string, targets: readonly TargetRow[]): string {
  if (targets.length === 0) {
    return withFinalNewline(`# Tracked Targets — ${displayName}

bot は以下のアカウントの投稿に反応する (引用 / リプ / いいね候補) ことを想定しています。

現在追跡対象はありません。\`/mex target add @username\` で追加できます。`);
  }

  const rows = targets
    .map((target) => `| @${target.handle} | ${target.relationship} | ${target.notes} |`)
    .join('\n');

  return withFinalNewline(`# Tracked Targets — ${displayName}

bot は以下のアカウントの投稿に反応する (引用 / リプ / いいね候補) ことを想定しています。

| handle | 関係性 | メモ |
|---|---|---|
${rows}`);
}

function buildReadmeMarkdown(accountId: string): string {
  return withFinalNewline(`# ${accountId} — MeX 運用データ

このリポジトリは MeX Next が運用する X アカウント運用データです。

## 構成
- \`AGENTS.md\` / \`CLAUDE.md\` — LLM (Codex / Claude Code) が自動読込する指示書
- \`persona.md\` / \`brand.md\` / \`voice-guide.md\` — ペルソナと文体の知識ベース
- \`targets.md\` — 追跡対象アカウント一覧
- \`account.json\` / \`state.json\` — bot の runtime state (人手で編集しない)
- \`content/<id>/\` — 投稿案のスナップショット
- \`exemplars/\`, \`retros/\`, \`decisions/\` — 学習・振り返り・判断のログ (markdown)

## 使い方
- 顧客側で触る場面はありません。Discord で \`/mex\` または bot にメンションしてください。
- 何かを変えたい時は markdown を直接編集するのではなく、bot に話しかけて反映を依頼してください。`);
}

function basenameWithoutExt(path: string): string {
  const last = path.split('/').pop() ?? '';
  return last.replace(/\.md$/i, '');
}

function personaKnowledge(account: AccountJson): PersonaKnowledge {
  const persona = objectOf(account.persona);
  const personaText = typeof account.persona === 'string' ? account.persona : '';
  const voice = objectOf(account.voice_profile);
  const key = text(
    valueAt(persona, 'archetype_key') ??
      valueAt(persona, 'style') ??
      valueAt(voice, 'default_character') ??
      parseLabeledValue(personaText, 'タイプ'),
  );
  const archetype = PERSONA_ARCHETYPES[key];
  const label = text(valueAt(persona, 'archetype_label')) || archetype?.label || DASH;
  const tagline = text(valueAt(persona, 'archetype_tagline')) || archetype?.tagline || DASH;

  return {
    role: text(valueAt(persona, 'role') ?? parseLabeledValue(personaText, '役割')) || DASH,
    archetypeLabel: label,
    archetypeKey: key || DASH,
    archetypeTagline: tagline,
    background: text(valueAt(persona, 'background')) || DASH,
    empathy: text(valueAt(persona, 'empathy')) || DASH,
    avoid: text(valueAt(persona, 'avoid')) || DASH,
  };
}

function brandPrimaryThemes(account: AccountJson): string[] {
  const brand = objectOf(account.brand);
  return firstNonEmptyList(
    valueAt(brand, 'primary_themes'),
    valueAt(brand, 'core_thesis'),
    valueAt(brand, 'problem_space'),
    valueAt(brand, 'promise'),
  );
}

function brandVoiceTone(account: AccountJson): string {
  const brand = objectOf(account.brand);
  const voice = objectOf(account.voice_profile);
  const direct = text(valueAt(brand, 'voice_tone') ?? valueAt(brand, 'tone'));
  if (direct) return direct;
  const parts = [
    text(valueAt(voice, 'distance_to_reader')) ? `距離感: ${text(valueAt(voice, 'distance_to_reader'))}` : '',
    text(valueAt(voice, 'assertiveness')) ? `主張: ${text(valueAt(voice, 'assertiveness'))}` : '',
    text(valueAt(voice, 'warmth')) ? `温度感: ${text(valueAt(voice, 'warmth'))}` : '',
    text(valueAt(voice, 'humor')) ? `ユーモア: ${text(valueAt(voice, 'humor'))}` : '',
    text(valueAt(voice, 'emoji_policy')) ? `絵文字: ${text(valueAt(voice, 'emoji_policy'))}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' / ') : DASH;
}

function forbiddenItems(account: AccountJson): string[] {
  const brand = objectOf(account.brand);
  const voice = objectOf(account.voice_profile);
  return unique([
    ...listOf(valueAt(brand, 'forbidden')),
    ...listOf(valueAt(brand, 'avoid_topics')),
    ...listOf(valueAt(brand, 'stop_words')),
    ...listOf(valueAt(voice, 'forbidden_tones')),
  ]);
}

function goalItems(account: AccountJson): string[] {
  const goalStack = objectOf(account.goal_stack);
  const direct = listOf(goalStack);
  if (direct.length > 0) return direct;

  return unique([
    text(valueAt(goalStack, 'objective')),
    text(valueAt(goalStack, 'recognition')),
    text(valueAt(goalStack, 'trust')),
    text(valueAt(goalStack, 'relationship')),
    text(valueAt(goalStack, 'action')),
    text(valueAt(valueAt(goalStack, 'account_goal'), 'recognition_goal')),
    ...listOf(valueAt(valueAt(goalStack, 'operating_goal'), 'current_focus')),
  ].filter(Boolean));
}

function hotZoneItems(zones: readonly HotZone[] | undefined): string[] {
  if (!zones || zones.length === 0) return [];
  return zones.map((zone) => {
    const label = text(zone.label);
    const range = `${text(zone.start) || DASH}-${text(zone.end) || DASH}`;
    return label ? `${label}: ${range}` : range;
  });
}

function targetRows(account: AccountJson): TargetRow[] {
  const directTargets = valueAt(account, 'tracked_targets');
  const xTargets = account.x_action_system?.tracked_targets;
  const source = Array.isArray(directTargets) ? directTargets : Array.isArray(xTargets) ? xTargets : null;
  if (source) {
    return source
      .map((item) => {
        const target = objectOf(item);
        const handle = normalizeHandle(valueAt(target, 'handle') ?? valueAt(target, 'username'));
        if (!handle) return null;
        return {
          handle,
          relationship: text(valueAt(target, 'relationship')) || DASH,
          notes: text(valueAt(target, 'notes') ?? valueAt(target, 'memo')) || DASH,
        };
      })
      .filter((item): item is TargetRow => item !== null);
  }

  const tracked = objectOf(xTargets);
  return listOf(valueAt(tracked, 'usernames')).map((handle) => ({
    handle: normalizeHandle(handle),
    relationship: '追跡対象',
    notes: DASH,
  })).filter((row) => row.handle.length > 0);
}

function voiceExamples(account: AccountJson): Array<{ label: string; text: string }> {
  const voice = objectOf(account.voice_profile);
  const examples = listOf(valueAt(voice, 'examples') ?? valueAt(voice, 'example_sentences'));
  if (examples.length > 0) {
    return examples.map((example, index) => ({
      label: exampleLabel(index),
      text: example,
    }));
  }

  const keyed = [
    text(valueAt(voice, 'example_sentence_1')),
    text(valueAt(voice, 'example_sentence_2')),
    text(valueAt(voice, 'example_sentence_3')),
  ].filter(Boolean);
  return keyed.map((example, index) => ({ label: exampleLabel(index), text: example }));
}

function exampleLabel(index: number): string {
  if (index === 0) return '短文';
  if (index === 1) return '中文';
  return '長文';
}

function firstNonEmptyList(...values: readonly unknown[]): string[] {
  for (const value of values) {
    const items = listOf(value);
    if (items.length > 0) return items;
  }
  return [];
}

function listOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => text(item)).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/[,、\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>)
      .flatMap((item) => listOf(item))
      .filter(Boolean);
  }
  return [];
}

function bulletList(items: readonly string[]): string {
  if (items.length === 0) return `- ${DASH}`;
  return items.map((item) => `- ${item}`).join('\n');
}

function inlineList(items: readonly string[]): string {
  return items.length > 0 ? items.join(', ') : DASH;
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function normalizeHandle(value: unknown): string {
  const raw = text(value);
  return raw.startsWith('@') ? raw.slice(1) : raw;
}

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function objectOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function valueAt(value: unknown, key: string): unknown {
  return objectOf(value)[key];
}

function parseLabeledValue(raw: string, label: string): string {
  if (!raw) return '';
  const pattern = new RegExp(`${escapeRegExp(label)}:\\s*([^/]+)`);
  return pattern.exec(raw)?.[1]?.trim() ?? '';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function withFinalNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}
