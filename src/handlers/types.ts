/**
 * Handler context + result shapes shared by every intent / slash command
 * dispatch path.
 *
 * Handlers are pure with respect to Discord transport: they accept a
 * `HandlerContext` (account repo, LLM bridge, X API client, Discord
 * poster, logger), do their domain work, and return a `HandlerResult`.
 * The conversation runner / interaction dispatcher decides how to render
 * the result back to Discord (DM reply / thread message / ephemeral).
 */

import type { Logger } from 'pino';
import type { LlmProvider } from '../llm/bridge.js';
import type { AccountRepo } from '../account-state/repo.js';
import type { XApiSurface } from '../x-api/types.js';
import type { DiscordPoster } from '../posting/collectors/types.js';

export interface HandlerContext {
  readonly accountId: string;
  readonly repo: AccountRepo;
  readonly bridge: LlmProvider;
  readonly xApi?: XApiSurface;
  readonly discordPoster: DiscordPoster;
  readonly logger: Logger;
  /** Discord user id of the requester (for log lines / approval ownership). */
  readonly authorId?: string | null;
  /** Operator allowlist. Some destructive actions cross-check this. */
  readonly operatorDiscordUserIds?: ReadonlyArray<string>;
}

export interface HandlerResult {
  /** Markdown body to send back to Discord. */
  readonly content: string;
  /** Optional Discord components (action rows). Passed verbatim to discord.js. */
  readonly components?: ReadonlyArray<unknown>;
  /** When true, the runner suppresses the default channel reply. */
  readonly silent?: boolean;
  /** Optional follow-up message scheduled by the runner. */
  readonly followUp?: { content: string; delaySec: number };
  /** Optional tag for telemetry / logs. */
  readonly tag?: string;
}

export type HandlerArgs = Readonly<Record<string, unknown>>;

/**
 * Function signature every intent / slash command shares so the
 * dispatcher can keep a single map.
 */
export type Handler = (
  ctx: HandlerContext,
  args: HandlerArgs,
) => Promise<HandlerResult>;

export type HandlersMap = Readonly<Record<string, Handler>>;
