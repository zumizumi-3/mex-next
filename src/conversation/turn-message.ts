/**
 * Structured turn message used between Discord ingress and the
 * conversation engine.
 *
 * Ported (and slimmed down) from wah-office-v2 `turn-message.js`.
 * MeX's LLM kinds don't yet need image/text-block extraction at
 * this layer, so we keep the shape simple but extensible.
 */

/* eslint-disable no-control-regex */

import { z } from 'zod';

const ActorSchema = z
  .object({
    id: z.string().nullable(),
    bot: z.boolean(),
  })
  .nullable();

const AttachmentSchema = z.object({
  id: z.string().nullable(),
  name: z.string().nullable(),
  url: z.string().nullable(),
  proxyUrl: z.string().nullable(),
  contentType: z.string().nullable(),
  size: z.number().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
});

export const TurnMessageSchema = z.object({
  content: z.string(),
  attachments: z.array(AttachmentSchema),
  author: ActorSchema,
  user: ActorSchema,
});

export type TurnMessage = z.infer<typeof TurnMessageSchema>;
export type TurnAttachment = z.infer<typeof AttachmentSchema>;
export type TurnActor = z.infer<typeof ActorSchema>;

export interface BuildTurnMessageInput {
  readonly content: string | null | undefined;
  readonly attachments?: ReadonlyArray<unknown> | { values?: () => Iterable<unknown> } | null;
  readonly author?: { id?: string | null; bot?: boolean | null } | null;
  readonly user?: { id?: string | null; bot?: boolean | null } | null;
}

/** Build a normalized {@link TurnMessage} from raw Discord ingress data. */
export function buildTurnMessage(input: BuildTurnMessageInput): TurnMessage {
  return {
    content: normalizeContent(input.content),
    attachments: normalizeAttachments(input.attachments ?? null),
    author: normalizeActor(input.author ?? null),
    user: normalizeActor(input.user ?? null),
  };
}

/** Returns true iff the turn message has any user-visible content. */
export function hasTurnMessageContent(message: TurnMessage): boolean {
  return message.content.length > 0 || message.attachments.length > 0;
}

/**
 * Render a turn message as a single string for LLM prompts.
 * Attachments are surfaced as `- name (mime, size): url` lines.
 */
export function formatTurnMessageForPrompt(message: TurnMessage): string {
  const lines: string[] = [];
  if (message.content) {
    lines.push(message.content);
  }
  if (message.attachments.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push('Attachments:');
    for (const attachment of message.attachments) {
      lines.push(formatAttachmentLine(attachment));
    }
  }
  return lines.join('\n').trim() || '[empty message]';
}

function normalizeContent(value: string | null | undefined): string {
  return String(value ?? '')
    .replace(/\u0000/g, '')
    .trim();
}

function normalizeAttachments(value: BuildTurnMessageInput['attachments']): TurnAttachment[] {
  const entries = collectionToArray(value);
  const out: TurnAttachment[] = [];
  for (const raw of entries) {
    const normalized = normalizeAttachment(raw);
    if (normalized) {
      out.push(normalized);
    }
  }
  return out;
}

function normalizeAttachment(raw: unknown): TurnAttachment | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const r = raw as Record<string, unknown>;
  return {
    id: optionalString(r.id),
    name: optionalString(r.name),
    url: optionalString(r.url),
    proxyUrl: optionalString(r.proxyURL ?? r.proxyUrl),
    contentType: optionalString(r.contentType ?? r.content_type),
    size: optionalNumber(r.size),
    width: optionalNumber(r.width),
    height: optionalNumber(r.height),
  };
}

function normalizeActor(value: BuildTurnMessageInput['author']): TurnActor {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const id = optionalString(value.id);
  if (!id && value.bot === undefined) {
    return null;
  }
  return {
    id,
    bot: Boolean(value.bot),
  };
}

function optionalString(raw: unknown): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const normalized = String(raw)
    .replace(/\u0000/g, '')
    .trim();
  return normalized || null;
}

function optionalNumber(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

function collectionToArray(value: BuildTurnMessageInput['attachments']): unknown[] {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value as unknown[];
  }
  if (typeof (value as { values?: () => Iterable<unknown> }).values === 'function') {
    return Array.from((value as { values: () => Iterable<unknown> }).values());
  }
  return [];
}

function formatAttachmentLine(attachment: TurnAttachment): string {
  const name = attachment.name ?? attachment.id ?? 'unnamed';
  const details: string[] = [];
  if (attachment.contentType) {
    details.push(attachment.contentType);
  }
  if (attachment.width !== null && attachment.height !== null) {
    details.push(`${attachment.width}x${attachment.height}`);
  }
  if (attachment.size !== null) {
    details.push(`${attachment.size} bytes`);
  }
  const detailText = details.length > 0 ? ` (${details.join(', ')})` : '';
  const url = attachment.url ?? attachment.proxyUrl ?? '[url unavailable]';
  return `- ${name}${detailText}: ${url}`;
}
