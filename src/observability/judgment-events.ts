/**
 * Judgment-event sink — append-only JSONL log for LLM / runtime decisions.
 *
 * Why this exists:
 *   The runtime makes many automated judgments per minute (intent
 *   classify, 5-axis quality judge, inbound risk, preflight gates,
 *   publish failures). When something goes wrong, we need to look at
 *   the *exact* inputs and outputs at decision time, not just summary
 *   logs. This sink captures one row per judgment so operators can
 *   replay / audit.
 *
 * Format:
 *   - One JSON object per line ("JSONL").
 *   - Append-only — readers tail-scan the active file.
 *   - Rotation: when the active file exceeds `rotateSizeBytes`, it is
 *     renamed to `*.1.jsonl`, the previous `*.1.jsonl` to `*.2.jsonl`,
 *     etc. The active file is recreated empty on the next emit.
 *   - Concurrency: writes are serialized through an internal queue so
 *     two callers can `emit()` from different code paths without
 *     interleaving partial JSON lines.
 *
 * NOT a transactional store. If the process is killed mid-emit, the
 * tail line may be torn. That's acceptable for a debug / audit sink
 * (the next process emit will start a fresh line).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulid';

export interface JudgmentEvent {
  /** ULID — sortable / monotonic so JSONL order is stable. */
  id: string;
  /** ISO 8601 (UTC) at the moment of `emit`. */
  timestamp: string;
  /** Account scope for the judgment. */
  accountId: string;
  /** Kind tag (e.g. 'intent_classify_result', 'quality_judge_result'). */
  kind: string;
  /** Caller-supplied structured payload. */
  payload: Record<string, unknown>;
}

export interface JudgmentEventStreamOptions {
  filePath: string;
  /** Default 50 MB. Set to 0 to disable rotation entirely. */
  rotateSizeBytes?: number;
  /** Default 10 — how many `*.N.jsonl` files to keep before discarding. */
  maxRotated?: number;
  /** Optional clock injection for tests. */
  now?: () => Date;
  /** Optional id generator for tests. */
  idFactory?: () => string;
}

const DEFAULT_ROTATE_SIZE = 50 * 1024 * 1024; // 50MB
const DEFAULT_MAX_ROTATED = 10;

export interface QueryOptions {
  kind?: string;
  /** Lower bound (inclusive) on Date.parse(timestamp) in ms. */
  sinceMs?: number;
  /** Maximum results returned. */
  limit?: number;
}

/**
 * JSONL append-only sink for judgment events. One instance per process
 * is the common pattern; multiple instances pointed at the same file
 * are safe within the same process (writes are queued) but should NOT
 * be used across processes.
 */
export class JudgmentEventStream {
  private readonly filePath: string;
  private readonly rotateSizeBytes: number;
  private readonly maxRotated: number;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  /** Tail of the write queue — every emit awaits the previous one. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(opts: JudgmentEventStreamOptions) {
    this.filePath = opts.filePath;
    this.rotateSizeBytes = opts.rotateSizeBytes ?? DEFAULT_ROTATE_SIZE;
    this.maxRotated = opts.maxRotated ?? DEFAULT_MAX_ROTATED;
    this.now = opts.now ?? ((): Date => new Date());
    this.idFactory = opts.idFactory ?? ((): string => ulid());
  }

  /**
   * Append one event. Returns when the line is durably written.
   *
   * Errors are propagated — the caller decides whether to retry or
   * swallow. Most call sites should `.catch(() => {})` since judgment
   * sink failures must NEVER block the runtime.
   *
   * Payload is run through `sanitizePayload` to redact obviously
   * secret-shaped substrings (Anthropic / Slack tokens, PEM private
   * keys, long hex tokens) before persistence. The walk is depth-
   * limited and cycle-safe so a malicious / unexpected input cannot
   * stall the writer.
   */
  async emit(event: Omit<JudgmentEvent, 'id' | 'timestamp'>): Promise<void> {
    const enriched: JudgmentEvent = {
      id: this.idFactory(),
      timestamp: this.now().toISOString(),
      accountId: event.accountId,
      kind: event.kind,
      payload: sanitizePayload(event.payload) as Record<string, unknown>,
    };
    const line = JSON.stringify(enriched) + '\n';
    const next = this.writeChain.then(() => this.appendWithRotation(line));
    // Swallow on the chain so a single failure doesn't poison subsequent emits.
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  /** Resolve when all queued writes have flushed. Use during shutdown. */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  /**
   * Linear scan of all rotated files + active file. Returns events in
   * append order (oldest first). Heavy enough that the caller should
   * NOT use this on every request — it's a debug / replay surface.
   */
  async query(opts: QueryOptions = {}): Promise<JudgmentEvent[]> {
    await this.flush();
    const files = await this.listFilesForQuery();
    const out: JudgmentEvent[] = [];
    for (const file of files) {
      const events = await readJsonlSafe(file);
      for (const ev of events) {
        if (!matchesQuery(ev, opts)) continue;
        out.push(ev);
      }
    }
    if (typeof opts.limit === 'number' && opts.limit >= 0 && out.length > opts.limit) {
      // Return the newest `limit` events while keeping append order.
      return out.slice(out.length - opts.limit);
    }
    return out;
  }

  private async appendWithRotation(line: string): Promise<void> {
    await ensureDir(this.filePath);
    if (this.rotateSizeBytes > 0) {
      const size = await fileSize(this.filePath);
      if (size + Buffer.byteLength(line, 'utf8') > this.rotateSizeBytes) {
        await this.rotate();
      }
    }
    await fs.appendFile(this.filePath, line, { encoding: 'utf8' });
  }

  private async rotate(): Promise<void> {
    // Shift `*.N.jsonl` → `*.(N+1).jsonl`, oldest first dropped.
    const dir = path.dirname(this.filePath);
    const base = path.basename(this.filePath);
    for (let i = this.maxRotated; i >= 1; i -= 1) {
      const src = path.join(dir, `${base}.${i}`);
      const dst = path.join(dir, `${base}.${i + 1}`);
      try {
        await fs.rename(src, dst);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
    }
    // Drop the file beyond `maxRotated`.
    const overflow = path.join(dir, `${base}.${this.maxRotated + 1}`);
    try {
      await fs.unlink(overflow);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    // Move active file to .1.
    try {
      await fs.rename(this.filePath, path.join(dir, `${base}.1`));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  /** Returns rotated files in oldest→newest order, then the active file. */
  private async listFilesForQuery(): Promise<string[]> {
    const dir = path.dirname(this.filePath);
    const base = path.basename(this.filePath);
    const out: string[] = [];
    // Rotated files are .N where larger N = older.
    for (let i = this.maxRotated; i >= 1; i -= 1) {
      const candidate = path.join(dir, `${base}.${i}`);
      try {
        await fs.access(candidate);
        out.push(candidate);
      } catch {
        // not present — skip
      }
    }
    try {
      await fs.access(this.filePath);
      out.push(this.filePath);
    } catch {
      // active file not yet created
    }
    return out;
  }
}

async function ensureDir(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
}

async function fileSize(filePath: string): Promise<number> {
  try {
    const stat = await fs.stat(filePath);
    return stat.size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
}

async function readJsonlSafe(filePath: string): Promise<JudgmentEvent[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: JudgmentEvent[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isJudgmentEvent(parsed)) {
        out.push(parsed);
      }
    } catch {
      // tolerate corrupt tail lines
    }
  }
  return out;
}

function isJudgmentEvent(value: unknown): value is JudgmentEvent {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<JudgmentEvent>;
  return (
    typeof v.id === 'string' &&
    typeof v.timestamp === 'string' &&
    typeof v.accountId === 'string' &&
    typeof v.kind === 'string' &&
    !!v.payload &&
    typeof v.payload === 'object'
  );
}

function matchesQuery(event: JudgmentEvent, opts: QueryOptions): boolean {
  if (opts.kind && event.kind !== opts.kind) return false;
  if (typeof opts.sinceMs === 'number') {
    const t = Date.parse(event.timestamp);
    if (Number.isNaN(t) || t < opts.sinceMs) return false;
  }
  return true;
}

/**
 * Substring patterns we redact before appending to the JSONL sink.
 *
 * These are heuristic — they only catch obviously secret-shaped
 * tokens (Anthropic API keys, Slack bot tokens, PEM private key
 * blocks, long hex strings that look like API tokens / hashes). Real
 * secret hygiene still belongs upstream, but this layer prevents an
 * accidental `console.log`-style leak from being persisted in plain
 * text on the operator's disk.
 *
 * Patterns are intentionally anchored to high-signal prefixes / shapes
 * so we don't false-positive on URLs / ULIDs / regular content.
 */
const REDACTION_TOKEN = '[REDACTED]';

const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  // Anthropic API keys (also covers `sk-ant-api03-*` form).
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  // Slack bot / user / app tokens.
  /xox[baprs]-[A-Za-z0-9-]{8,}/g,
  // GitHub fine-grained / classic tokens.
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  // PEM-armored private keys (block).
  /-----BEGIN [A-Z][A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z][A-Z ]*PRIVATE KEY-----/g,
  // PEM header alone (defensive — partial captures still get redacted).
  /-----BEGIN [A-Z][A-Z ]*KEY-----/g,
  // Long hex tokens (>= 64 hex chars) — covers API hash tokens.
  /\b[a-fA-F0-9]{64,}\b/g,
];

/**
 * Maximum depth we recurse into payload structures. Discord embeds and
 * judge results never go deeper than ~6 — 12 leaves a generous margin
 * without enabling DoS via deeply nested payload.
 */
const MAX_SANITIZE_DEPTH = 12;

/**
 * Redact secret-shaped substrings in a string value.
 */
function redactString(value: string): string {
  let out = value;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTION_TOKEN);
  }
  return out;
}

/**
 * Walk a value and return a deep-cloned, sanitized copy. Cycles and
 * over-deep nesting are short-circuited to `'[TRUNCATED]'` so we
 * never spin forever on hostile input.
 *
 * Exported for unit tests; production callers should not need to invoke
 * it directly — `emit()` always runs payloads through it.
 */
export function sanitizePayload(value: unknown): unknown {
  return sanitizeValue(value, 0, new WeakSet());
}

function sanitizeValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (depth > MAX_SANITIZE_DEPTH) return '[TRUNCATED]';
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string') return redactString(value as string);
  if (t === 'number' || t === 'boolean' || t === 'undefined' || t === 'bigint') {
    return value;
  }
  if (t === 'function' || t === 'symbol') {
    // Not JSON-representable — drop to keep the JSONL clean.
    return undefined;
  }
  if (t !== 'object') return value;

  const obj = value as object;
  if (seen.has(obj)) return '[CYCLE]';
  seen.add(obj);

  if (Array.isArray(obj)) {
    const arr: unknown[] = [];
    for (const item of obj) {
      arr.push(sanitizeValue(item, depth + 1, seen));
    }
    return arr;
  }

  // Plain-ish object — copy own enumerable keys.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    out[k] = sanitizeValue(v, depth + 1, seen);
  }
  return out;
}

/**
 * No-op stream for tests / contexts where judgment events are not
 * configured. Callers can always emit and never block.
 */
export class NoopJudgmentEventStream extends JudgmentEventStream {
  constructor() {
    // /dev/null is fine — emit overrides keep us from touching it.
    super({ filePath: '/dev/null', rotateSizeBytes: 0 });
  }
  override async emit(): Promise<void> {
    // intentionally noop
  }
  override async flush(): Promise<void> {
    // intentionally noop
  }
  override async query(): Promise<JudgmentEvent[]> {
    return [];
  }
}
