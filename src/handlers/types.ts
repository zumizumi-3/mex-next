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
import type { JudgmentEventStream } from '../observability/judgment-events.js';

export interface HandlerContext {
  readonly accountId: string;
  readonly repo: AccountRepo;
  readonly bridge: LlmProvider;
  readonly xApi?: XApiSurface;
  readonly discordPoster: DiscordPoster;
  readonly logger: Logger;
  /** Discord user id of the requester (for log lines / approval ownership). */
  readonly authorId?: string | null;
  /**
   * Discord user id of the actual requester for THIS turn / interaction.
   * Distinct from {@link authorId} (which may be set globally on the
   * default context). Operator-only handlers MUST cross-check this id
   * against {@link operatorDiscordUserIds}; an empty allowlist or a
   * missing requesterUserId means no operator powers.
   */
  readonly requesterUserId?: string | null;
  /** Operator allowlist. Some destructive actions cross-check this. */
  readonly operatorDiscordUserIds?: ReadonlyArray<string>;
  /**
   * Optional sink for LLM / runtime judgment events. Handlers should
   * `await ctx.judgmentEvents?.emit(...)` whenever they produce a
   * decision worth replaying.
   */
  readonly judgmentEvents?: JudgmentEventStream;
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
