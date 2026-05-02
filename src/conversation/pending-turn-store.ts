/**
 * Pending-turn persistence.
 *
 * Ported from wah-office-v2 `pending-turn-store.js` and adapted to
 * MeX's zod schema policy.
 *
 * When the bot starts a turn (responding to a user message or a
 * conversation-style command), it writes a record here. If the
 * process crashes mid-turn, on next boot we read the records and
 * post a recovery notice to each affected channel.
 *
 * Storage is a single JSON file keyed by conversationKey. Writes
 * are atomic (write-then-rename) so partial writes don't corrupt
 * the store.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

const PendingTurnRecordSchema = z.object({
  conversationKey: z.string().min(1),
  replyChannelId: z.string().min(1),
  accountId: z.string(),
  requestedAt: z.string(),
  kind: z.string().min(1),
});

export type PendingTurnRecord = z.infer<typeof PendingTurnRecordSchema>;

const StoreFileSchema = z.record(z.string(), PendingTurnRecordSchema);

export interface PendingTurnStoreOptions {
  readonly filePath: string;
}

export class PendingTurnStore {
  public readonly filePath: string;

  constructor(options: PendingTurnStoreOptions) {
    if (!options.filePath) {
      throw new Error('PendingTurnStore.filePath is required');
    }
    this.filePath = options.filePath;
  }

  /** List all currently-pending turns. */
  listRecords(): PendingTurnRecord[] {
    return Object.values(this.read());
  }

  /** Look up a single pending turn by conversation key. */
  getRecord(key: string): PendingTurnRecord | null {
    const data = this.read();
    return data[key] ?? null;
  }

  /** Insert or replace a pending turn record. */
  setRecord(key: string, record: Omit<PendingTurnRecord, 'conversationKey'>): void {
    if (!key) {
      throw new Error('conversationKey is required');
    }
    const data = this.read();
    const normalized = PendingTurnRecordSchema.parse({
      ...record,
      conversationKey: key,
    });
    data[key] = normalized;
    this.write(data);
  }

  /** Remove the record for a conversation key. No-op if missing. */
  delete(key: string): void {
    const data = this.read();
    if (!(key in data)) {
      return;
    }
    delete data[key];
    this.write(data);
  }

  /** Test helper: replace the entire store contents. */
  replaceAllForTest(records: PendingTurnRecord[]): void {
    const data: Record<string, PendingTurnRecord> = {};
    for (const record of records) {
      data[record.conversationKey] = record;
    }
    this.write(data);
  }

  private read(): Record<string, PendingTurnRecord> {
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
        // Corrupt file — return empty rather than throwing on boot.
        return {};
      }
      return { ...validated.data };
    } catch {
      return {};
    }
  }

  private write(data: Record<string, PendingTurnRecord>): void {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const tempPath = join(dir, `.${randomSuffix()}.tmp`);
    writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    renameSync(tempPath, this.filePath);
  }
}

function randomSuffix(): string {
  return `pending-turn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
