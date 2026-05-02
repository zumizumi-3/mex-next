import { describe, expect, it } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';
import pino from 'pino';
import { dispatchSlashCommand } from '../../../src/discord/slash-dispatch.js';
import type {
  Handler,
  HandlerContext,
  HandlerResult,
  HandlersMap,
} from '../../../src/handlers/types.js';
import type { AccountRepo } from '../../../src/account-state/repo.js';
import type { LlmProvider } from '../../../src/llm/bridge.js';
import type { DiscordPoster } from '../../../src/posting/collectors/types.js';

interface MockInteractionInit {
  readonly userId: string | null;
  readonly subcommand: string;
  readonly subcommandGroup?: string | null;
  readonly stringOptions?: Record<string, string | null>;
}

function makeMockInteraction(init: MockInteractionInit): {
  interaction: ChatInputCommandInteraction;
  replies: string[];
  edits: string[];
  deferred: { count: number };
} {
  const replies: string[] = [];
  const edits: string[] = [];
  const deferred = { count: 0 };
  const stringOptions = init.stringOptions ?? {};
  const interaction = {
    commandName: 'mex',
    user: init.userId ? { id: init.userId } : null,
    options: {
      getSubcommandGroup: (_required?: boolean): string | null =>
        init.subcommandGroup ?? null,
      getSubcommand: (_required?: boolean): string => init.subcommand,
      getString: (name: string, required?: boolean): string | null => {
        const value = stringOptions[name] ?? null;
        if (required && value === null) {
          throw new Error(`required string option "${name}" missing`);
        }
        return value;
      },
    },
    async reply(payload: { content: string }): Promise<void> {
      replies.push(payload.content);
    },
    async deferReply(): Promise<void> {
      deferred.count += 1;
    },
    async editReply(payload: { content: string }): Promise<void> {
      edits.push(payload.content);
    },
  } as unknown as ChatInputCommandInteraction;
  return { interaction, replies, edits, deferred };
}

function makeBaseContext(): HandlerContext {
  const repo = {} as unknown as AccountRepo;
  const bridge = {
    async call() {
      return { text: '{}', usage: { input: 0, output: 0 } };
    },
  } as unknown as LlmProvider;
  const discordPoster = {} as unknown as DiscordPoster;
  return {
    accountId: 'zumi-x',
    repo,
    bridge,
    discordPoster,
    logger: pino({ level: 'silent' }),
    operatorDiscordUserIds: ['op-1'],
  };
}

describe('dispatchSlashCommand', () => {
  it('stamps interaction.user.id into handlerContext.requesterUserId', async () => {
    let observedRequester: string | null | undefined = undefined;
    const handler: Handler = async (ctx: HandlerContext): Promise<HandlerResult> => {
      observedRequester = ctx.requesterUserId ?? null;
      return { content: 'ok' };
    };
    const handlers: HandlersMap = { 'status.show': handler };
    const { interaction, edits } = makeMockInteraction({
      userId: 'op-1',
      subcommand: 'status',
      subcommandGroup: null,
    });
    await dispatchSlashCommand({
      interaction,
      handlers,
      handlerContext: makeBaseContext(),
    });
    expect(observedRequester).toBe('op-1');
    expect(edits[0]).toBe('ok');
  });

  it('routes /mex update to system.update intent', async () => {
    let invokedIntent: string | null = null;
    const handler: Handler = async (
      _ctx: HandlerContext,
    ): Promise<HandlerResult> => {
      invokedIntent = 'system.update';
      return { content: 'self-update triggered' };
    };
    const handlers: HandlersMap = { 'system.update': handler };
    const { interaction, edits } = makeMockInteraction({
      userId: 'op-1',
      subcommand: 'update',
      subcommandGroup: null,
    });
    await dispatchSlashCommand({
      interaction,
      handlers,
      handlerContext: makeBaseContext(),
    });
    expect(invokedIntent).toBe('system.update');
    expect(edits[0]).toContain('self-update');
  });

  it('routes /mex regenerate-knowledge to system.regenerate_knowledge intent', async () => {
    let invokedIntent: string | null = null;
    const handler: Handler = async (): Promise<HandlerResult> => {
      invokedIntent = 'system.regenerate_knowledge';
      return { content: 'knowledge regenerated' };
    };
    const handlers: HandlersMap = { 'system.regenerate_knowledge': handler };
    const { interaction, edits } = makeMockInteraction({
      userId: 'op-1',
      subcommand: 'regenerate-knowledge',
      subcommandGroup: null,
    });
    await dispatchSlashCommand({
      interaction,
      handlers,
      handlerContext: makeBaseContext(),
    });
    expect(invokedIntent).toBe('system.regenerate_knowledge');
    expect(edits[0]).toContain('knowledge');
  });

  it('passes requesterUserId=null when interaction has no user', async () => {
    let observedRequester: string | null | undefined = undefined;
    const handler: Handler = async (ctx: HandlerContext): Promise<HandlerResult> => {
      observedRequester = ctx.requesterUserId ?? null;
      return { content: 'ok' };
    };
    const handlers: HandlersMap = { 'status.show': handler };
    const { interaction } = makeMockInteraction({
      userId: null,
      subcommand: 'status',
      subcommandGroup: null,
    });
    await dispatchSlashCommand({
      interaction,
      handlers,
      handlerContext: makeBaseContext(),
    });
    expect(observedRequester).toBeNull();
  });

  it('does not mutate the shared base handlerContext', async () => {
    const handler: Handler = async (): Promise<HandlerResult> => ({
      content: 'ok',
    });
    const handlers: HandlersMap = { 'status.show': handler };
    const baseCtx = makeBaseContext();
    const { interaction } = makeMockInteraction({
      userId: 'op-1',
      subcommand: 'status',
      subcommandGroup: null,
    });
    await dispatchSlashCommand({
      interaction,
      handlers,
      handlerContext: baseCtx,
    });
    expect(baseCtx.requesterUserId).toBeUndefined();
  });
});
