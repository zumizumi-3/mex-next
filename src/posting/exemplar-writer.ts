import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import type { EditDiff } from './edit-diff.js';
import type { Logger } from './types.js';

export interface ExemplarRecord {
  readonly id: string;
  readonly createdAt: string;
  readonly topic: string;
  readonly original: string;
  readonly final: string;
  readonly diff: EditDiff;
  readonly note?: string;
}

export interface ExemplarWriterDeps {
  readonly accountRepoPath: string;
  readonly logger: Logger;
}

export interface RecentExemplar {
  readonly id: string;
  readonly topic: string;
  readonly createdAt: string;
  readonly relativePath: string;
}

export class ExemplarWriter {
  private readonly accountRepoPath: string;
  private readonly logger: Logger;

  constructor(deps: ExemplarWriterDeps) {
    this.accountRepoPath = deps.accountRepoPath;
    this.logger = deps.logger;
  }

  /** Persist one exemplar as markdown under `exemplars/`. */
  async write(record: ExemplarRecord): Promise<{ path: string }> {
    const dir = join(this.accountRepoPath, 'exemplars');
    await fs.mkdir(dir, { recursive: true });

    const date = datePart(record.createdAt);
    const slug = slugify(record.topic) || slugify(record.note ?? '') || slugify(record.id) || 'exemplar';
    const path = await uniquePath(dir, `${date}-${slug}`);
    await fs.writeFile(path, renderMarkdown(record), 'utf-8');
    this.logger.info({ path: `exemplars/${basename(path)}`, id: record.id }, 'exemplar_markdown_written');
    return { path };
  }

  /** List recent exemplars (newest first) for AGENTS.md regen. */
  async listRecent(limit = 20): Promise<ReadonlyArray<RecentExemplar>> {
    const dir = join(this.accountRepoPath, 'exemplars');
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const records: RecentExemplar[] = [];
    await Promise.all(
      entries
        .filter((name) => name.endsWith('.md'))
        .map(async (name) => {
          const body = await fs.readFile(join(dir, name), 'utf-8');
          records.push({
            id: parseLine(body, /^- id: `([^`]+)`/m) || name.replace(/\.md$/, ''),
            topic: parseLine(body, /^# Exemplar — (.*)$/m) || name.replace(/\.md$/, ''),
            createdAt: parseLine(body, /^- 作成: (.*)$/m) || dateFromFilename(name),
            relativePath: `exemplars/${name}`,
          });
        }),
    );

    return records
      .sort((a, b) => {
        const byDate = Date.parse(b.createdAt) - Date.parse(a.createdAt);
        if (Number.isFinite(byDate) && byDate !== 0) return byDate;
        return b.relativePath.localeCompare(a.relativePath);
      })
      .slice(0, Math.max(0, limit));
  }
}

function renderMarkdown(record: ExemplarRecord): string {
  const textFence = fenceFor(record.original, record.final);
  const diffText = unifiedDiff(record.diff);
  const diffFence = fenceFor(diffText);
  const { addedLines, removedLines, charDelta } = record.diff.summary;

  return `# Exemplar — ${record.topic || record.id}

- 作成: ${record.createdAt}
- id: \`${record.id}\`
- 文字数差: +${addedLines} / -${removedLines} / Δ${charDelta}

## bot 原案
${textFence}text
${record.original}
${textFence}

## 顧客修正後
${textFence}text
${record.final}
${textFence}

## 修正差分 (Unified)
${diffFence}diff
${diffText}
${diffFence}

## 学び
- ${record.note?.trim() || '—'}
`;
}

function unifiedDiff(diff: EditDiff): string {
  const lines = ['--- bot', '+++ final'];
  for (const hunk of diff.hunks) {
    const prefix = hunk.kind === 'added' ? '+' : hunk.kind === 'removed' ? '-' : ' ';
    lines.push(`${prefix}${hunk.text}`);
  }
  return lines.join('\n');
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 80);
}

function datePart(value: string): string {
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return value.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? new Date().toISOString().slice(0, 10);
}

async function uniquePath(dir: string, base: string): Promise<string> {
  for (let suffix = 1; ; suffix++) {
    const path = join(dir, suffix === 1 ? `${base}.md` : `${base}-${suffix}.md`);
    try {
      const handle = await fs.open(path, 'wx');
      await handle.close();
      return path;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
  }
}

function fenceFor(...values: string[]): string {
  const longest = Math.max(
    3,
    ...values.map((v) => Math.max(0, ...Array.from(v.matchAll(/`+/g), (m) => m[0].length))),
  );
  return '`'.repeat(longest + 1);
}

function parseLine(body: string, pattern: RegExp): string {
  return body.match(pattern)?.[1]?.trim() ?? '';
}

function dateFromFilename(name: string): string {
  return name.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? '';
}
