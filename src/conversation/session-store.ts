/**
 * Discord conversation session persistence.
 *
 * Ported from wah-office-v2 `session-store.js`. MeX needs only the
 * minimum: thread / DM channel id mapped to provider-session metadata
 * so that LLM bridges can resume context across multiple turns.
 *
 * Records survive restarts. On unexpected shutdown, the file is
 * written atomically (write-then-rename) to avoid corruption.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

export const SESSION_STATUSES = ['active', 'closed', 'cancelled'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

const SessionRecordSchema = z.object({
  threadId: z.string().min(1),
  provider: z.string().min(1),
  providerSessionId: z.string().nullable(),
  status: z.enum(SESSION_STATUSES),
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().nullable(),
  closedBy: z.string().nullable(),
  closeReason: z.string().nullable(),
  createdByDiscordUserId: z.string().nullable(),
});

export type SessionRecord = z.infer<typeof SessionRecordSchema>;

const StoreFileSchema = z.record(z.string(), SessionRecordSchema);

export interface SessionStoreOptions {
  readonly filePath: string;
  readonly now?: () => Date;
}

export interface UpsertSessionInput {
  readonly threadId: string;
  readonly provider: string;
  readonly providerSessionId: string | null;
  readonly status?: SessionStatus;
  readonly createdByDiscordUserId?: string | null;
  readonly closedBy?: string | null;
  readonly closeReason?: string | null;
}

/**
 * Persistent store for Discord conversation sessions. Single-process
 * only; for multi-process safety pair with `proper-lockfile` at the
 * caller level.
 */
export class SessionStore {
  public readonly filePath: string;
  private readonly now: () => Date;

  constructor(options: SessionStoreOptions) {
    if (!options.filePath) {
      throw new Error('SessionStore.filePath is required');
    }
    this.filePath = options.filePath;
    this.now = options.now ?? (() => new Date());
  }

  /** Insert or update a session record. Returns the persisted record. */
  upsertSession(input: UpsertSessionInput): SessionRecord {
    const data = this.read();
    const existing = data[input.threadId] ?? null;
    const nowIso = this.now().toISOString();
    const status: SessionStatus = input.status ?? existing?.status ?? 'active';

    const record: SessionRecord = SessionRecordSchema.parse({
      threadId: input.threadId,
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      status,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
      closedAt: status === 'active' ? null : existing?.closedAt ?? nowIso,
      closedBy: status === 'active' ? null : input.closedBy ?? existing?.closedBy ?? null,
      closeReason: status === 'active' ? null : input.closeReason ?? existing?.closeReason ?? null,
      createdByDiscordUserId:
        input.createdByDiscordUserId ?? existing?.createdByDiscordUserId ?? null,
    });
    data[input.threadId] = record;
    this.write(data);
    return record;
  }

  /** Look up a session by thread id (or DM channel id). */
  getSession(threadId: string): SessionRecord | null {
    const data = this.read();
    return data[threadId] ?? null;
  }

  /** Mark a session as closed. No-op if it doesn't exist. */
  closeSession(
    threadId: string,
    options: { closedBy?: string | null; reason?: string | null } = {},
  ): SessionRecord | null {
    const data = this.read();
    const existing = data[threadId];
    if (!existing) {
      return null;
    }
    const nowIso = this.now().toISOString();
    const updated: SessionRecord = {
      ...existing,
      status: 'closed',
      updatedAt: nowIso,
      closedAt: nowIso,
      closedBy: options.closedBy ?? null,
      closeReason: options.reason ?? null,
    };
    data[threadId] = updated;
    this.write(data);
    return updated;
  }

  /** Remove a session entirely. */
  deleteSession(threadId: string): void {
    const data = this.read();
    if (!(threadId in data)) {
      return;
    }
    delete data[threadId];
    this.write(data);
  }

  /** List all sessions. */
  listSessions(): SessionRecord[] {
    return Object.values(this.read());
  }

  private read(): Record<string, SessionRecord> {
    try {
      if (!existsSync(this.filePath)) {
        return {};
      }
      const raw = readFileSync(this.filePath, 'utf8').trim();
      if (!raw) {
        return {};
      }
      const parsed: unknown = JSON.parse(raw);
      const validated = StoreFileSchema.safeParse(parsed);
      if (!validated.success) {
        return {};
      }
      return { ...validated.data };
    } catch {
      return {};
    }
  }

  private write(data: Record<string, SessionRecord>): void {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const tempPath = join(dir, `.${randomSuffix()}.tmp`);
    writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    renameSync(tempPath, this.filePath);
  }
}

function randomSuffix(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
