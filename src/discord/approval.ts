/**
 * Approval flow.
 *
 * Adapted from wah-office-v2 `approval-store.js` + `discord-approval.js`,
 * scoped down for MeX:
 *   - approvals are persisted as JSONL (append-only) so we can
 *     replay history; each request gets its own line, and a
 *     resolution writes a fresh line with the same approval_id.
 *   - 15-minute default timeout.
 *   - operator-only resolution (caller is responsible for the
 *     allow-list check on the button interaction).
 *
 * Two-phase API:
 *   1. {@link ApprovalStore.createApproval} — emit a "pending" record.
 *   2. button handler calls {@link ApprovalStore.resolveApproval} —
 *      writes "approved" / "denied" / "timeout".
 *
 * The store is in-memory + write-through to the JSONL file. Re-reads
 * the file on construction so restarts pick up un-resolved approvals.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ulid } from 'ulid';
import { z } from 'zod';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type APIActionRowComponent,
  type APIEmbed,
  type APIComponentInMessageActionRow,
} from 'discord.js';
import { BUTTON_LABELS, CUSTOM_ID_PREFIXES, STATE_EMOJI, formatJst } from './templates.js';

export const APPROVAL_STATUSES = ['pending', 'approved', 'denied', 'timeout'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

const ApprovalRecordSchema = z.object({
  approvalId: z.string().min(1),
  capabilityId: z.string().min(1),
  accountId: z.string(),
  requestedByDiscordUserId: z.string().nullable(),
  conversationKey: z.string().nullable(),
  payloadPreview: z.string(),
  createdAt: z.string(),
  status: z.enum(APPROVAL_STATUSES),
  resolvedAt: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  replyChannelId: z.string().nullable(),
  approvalMessageId: z.string().nullable(),
});

export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

export const APPROVAL_TIMEOUT_MS = 15 * 60 * 1000;

export interface CreateApprovalInput {
  readonly capabilityId: string;
  readonly accountId: string;
  readonly requestedByDiscordUserId?: string | null;
  readonly conversationKey?: string | null;
  readonly payloadPreview?: string;
}

export interface ApprovalStoreOptions {
  readonly filePath: string;
  readonly now?: () => Date;
}

/**
 * Append-only JSONL persistence + in-memory index.
 */
export class ApprovalStore {
  public readonly filePath: string;
  private readonly now: () => Date;
  private readonly approvals = new Map<string, ApprovalRecord>();
  private readonly waiters = new Map<string, Array<(record: ApprovalRecord) => void>>();

  constructor(options: ApprovalStoreOptions) {
    if (!options.filePath) {
      throw new Error('ApprovalStore.filePath is required');
    }
    this.filePath = options.filePath;
    this.now = options.now ?? (() => new Date());
    this.restore();
  }

  /** Create a new pending approval. Returns the approval_id. */
  createApproval(input: CreateApprovalInput): ApprovalRecord {
    const record: ApprovalRecord = ApprovalRecordSchema.parse({
      approvalId: ulid(),
      capabilityId: input.capabilityId,
      accountId: input.accountId,
      requestedByDiscordUserId: input.requestedByDiscordUserId ?? null,
      conversationKey: input.conversationKey ?? null,
      payloadPreview: (input.payloadPreview ?? '').toString().trim(),
      createdAt: this.now().toISOString(),
      status: 'pending',
      resolvedAt: null,
      resolvedBy: null,
      replyChannelId: null,
      approvalMessageId: null,
    });
    this.approvals.set(record.approvalId, record);
    this.appendLine(record);
    return record;
  }

  /** Look up an approval. */
  getApproval(approvalId: string): ApprovalRecord | null {
    return this.approvals.get(approvalId) ?? null;
  }

  listPending(): ApprovalRecord[] {
    return Array.from(this.approvals.values()).filter((record) => record.status === 'pending');
  }

  /** Attach the Discord message id to a pending approval. */
  setMessageRef(
    approvalId: string,
    refs: { replyChannelId?: string | null; approvalMessageId?: string | null },
  ): ApprovalRecord | null {
    const existing = this.approvals.get(approvalId);
    if (!existing) {
      return null;
    }
    const updated: ApprovalRecord = {
      ...existing,
      replyChannelId: refs.replyChannelId ?? existing.replyChannelId,
      approvalMessageId: refs.approvalMessageId ?? existing.approvalMessageId,
    };
    this.approvals.set(approvalId, updated);
    this.appendLine(updated);
    return updated;
  }

  /**
   * Resolve a pending approval. Returns `{ didResolve: false }` if the
   * approval was already resolved (idempotent).
   */
  resolveApproval(
    approvalId: string,
    options: { status: Exclude<ApprovalStatus, 'pending'>; resolvedBy?: string | null },
  ): { didResolve: boolean; record: ApprovalRecord | null } {
    const existing = this.approvals.get(approvalId);
    if (!existing) {
      return { didResolve: false, record: null };
    }
    if (existing.status !== 'pending') {
      return { didResolve: false, record: existing };
    }
    const updated: ApprovalRecord = {
      ...existing,
      status: options.status,
      resolvedAt: this.now().toISOString(),
      resolvedBy: options.resolvedBy ?? null,
    };
    this.approvals.set(approvalId, updated);
    this.appendLine(updated);
    this.settleWaiters(approvalId, updated);
    return { didResolve: true, record: updated };
  }

  /**
   * Wait until the approval is resolved (or timed out). The internal
   * timeout fires after `timeoutMs` and writes a `timeout` resolution
   * if still pending.
   */
  waitForResolution(
    approvalId: string,
    options: { timeoutMs?: number; onTimeout?: (record: ApprovalRecord) => void } = {},
  ): Promise<ApprovalRecord | null> {
    const existing = this.approvals.get(approvalId);
    if (!existing) {
      return Promise.resolve(null);
    }
    if (existing.status !== 'pending') {
      return Promise.resolve(existing);
    }
    const timeoutMs = options.timeoutMs ?? APPROVAL_TIMEOUT_MS;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const result = this.resolveApproval(approvalId, { status: 'timeout' });
        if (result.didResolve && result.record) {
          options.onTimeout?.(result.record);
        }
      }, timeoutMs);
      // Don't keep the process alive solely for an approval timer.
      timer.unref?.();

      const queue = this.waiters.get(approvalId) ?? [];
      queue.push((record: ApprovalRecord) => {
        clearTimeout(timer);
        resolve(record);
      });
      this.waiters.set(approvalId, queue);
    });
  }

  private settleWaiters(approvalId: string, record: ApprovalRecord): void {
    const queue = this.waiters.get(approvalId) ?? [];
    this.waiters.delete(approvalId);
    for (const waiter of queue) {
      try {
        waiter(record);
      } catch {
        // ignore — waiter callback errors must not corrupt store state
      }
    }
  }

  private appendLine(record: ApprovalRecord): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
  }

  private restore(): void {
    if (!existsSync(this.filePath)) {
      return;
    }
    const raw = readFileSync(this.filePath, 'utf8');
    const lines = raw.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(trimmed);
        const validated = ApprovalRecordSchema.safeParse(parsed);
        if (!validated.success) {
          continue;
        }
        // Last write wins (we replay all lines in order).
        this.approvals.set(validated.data.approvalId, validated.data);
      } catch {
        // Skip malformed lines silently — append-only store is best-effort.
      }
    }
  }
}

// ---------- Discord rendering helpers ----------

/** Build the embed and buttons for an approval message. */
export function buildApprovalMessagePayload(approval: ApprovalRecord): {
  embeds: APIEmbed[];
  components: APIActionRowComponent<APIComponentInMessageActionRow>[];
} {
  return {
    embeds: [buildApprovalEmbed(approval)],
    components: [buildApprovalComponents(approval)],
  };
}

export function buildApprovalEmbed(approval: ApprovalRecord): APIEmbed {
  const lines = [
    `capability: \`${approval.capabilityId}\``,
    `account: \`${approval.accountId}\``,
    `requested_by: ${formatMention(approval.requestedByDiscordUserId)}`,
    `payload_preview: ${approval.payloadPreview || '(empty)'}`,
    `approval_id: \`${approval.approvalId.slice(-8)}\``,
    `timeout: ${Math.round(APPROVAL_TIMEOUT_MS / 60000)} 分`,
    `status: ${formatStatus(approval)}`,
  ];
  return new EmbedBuilder()
    .setTitle(`${STATE_EMOJI.approval} 承認要求`)
    .setDescription(lines.join('\n'))
    .setColor(resolveColor(approval.status))
    .toJSON() as APIEmbed;
}

export function buildApprovalComponents(
  approval: ApprovalRecord,
): APIActionRowComponent<APIComponentInMessageActionRow> {
  const disabled = approval.status !== 'pending';
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildApprovalCustomId(approval.approvalId, 'approve'))
      .setLabel(BUTTON_LABELS.approve)
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(buildApprovalCustomId(approval.approvalId, 'deny'))
      .setLabel(BUTTON_LABELS.deny)
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  );
  return row.toJSON() as APIActionRowComponent<APIComponentInMessageActionRow>;
}

export type ApprovalAction = 'approve' | 'deny';

export function buildApprovalCustomId(approvalId: string, action: ApprovalAction): string {
  return `${CUSTOM_ID_PREFIXES.approval}:${approvalId}:${action}`;
}

export function parseApprovalCustomId(
  customId: string,
): { approvalId: string; action: ApprovalAction } | null {
  const parts = String(customId ?? '').split(':');
  if (parts.length !== 3 || parts[0] !== CUSTOM_ID_PREFIXES.approval) {
    return null;
  }
  const [, approvalId, action] = parts;
  if (!approvalId || (action !== 'approve' && action !== 'deny')) {
    return null;
  }
  return { approvalId, action };
}

function formatMention(userId: string | null): string {
  return userId ? `<@${userId}>` : '(unknown)';
}

function formatStatus(approval: ApprovalRecord): string {
  const status = approval.status;
  if (status === 'approved') {
    return `${formatMention(approval.resolvedBy)} が承認しました at ${formatTime(approval.resolvedAt)}`;
  }
  if (status === 'denied') {
    return `${formatMention(approval.resolvedBy)} が拒否しました at ${formatTime(approval.resolvedAt)}`;
  }
  if (status === 'timeout') {
    return `15 分経過のため自動拒否 at ${formatTime(approval.resolvedAt)}`;
  }
  return '承認待ち';
}

function formatTime(value: string | null): string {
  if (!value) {
    return '(unknown)';
  }
  return formatJst(value);
}

function resolveColor(status: ApprovalStatus): number {
  switch (status) {
    case 'approved':
      return 0x2ecc71;
    case 'denied':
      return 0xe74c3c;
    case 'timeout':
      return 0xf39c12;
    default:
      return 0x3498db;
  }
}
