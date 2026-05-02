import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  handleSystemRegenerateKnowledge,
  handleSystemUpdate,
  isOperator,
} from '../../../src/handlers/system.js';
import { setupHandlerTest, type TestHandlerScaffold } from './test-helpers.js';

let scaf: TestHandlerScaffold;
afterEach(async () => {
  await scaf?.cleanup();
});

describe('isOperator', () => {
  it('returns false when operator allowlist is empty', async () => {
    scaf = await setupHandlerTest();
    expect(
      isOperator({
        ...scaf.ctx,
        operatorDiscordUserIds: [],
        requesterUserId: '111',
      }),
    ).toBe(false);
  });

  it('returns false when requesterUserId is missing', async () => {
    scaf = await setupHandlerTest();
    expect(
      isOperator({
        ...scaf.ctx,
        operatorDiscordUserIds: ['111'],
        requesterUserId: null,
      }),
    ).toBe(false);
    expect(
      isOperator({
        ...scaf.ctx,
        operatorDiscordUserIds: ['111'],
        // requesterUserId omitted entirely
      }),
    ).toBe(false);
  });

  it('returns false when requesterUserId is not in the allowlist', async () => {
    scaf = await setupHandlerTest();
    expect(
      isOperator({
        ...scaf.ctx,
        operatorDiscordUserIds: ['111', '222'],
        requesterUserId: '999',
      }),
    ).toBe(false);
  });

  it('returns true only when requesterUserId is present in the allowlist', async () => {
    scaf = await setupHandlerTest();
    expect(
      isOperator({
        ...scaf.ctx,
        operatorDiscordUserIds: ['111', '222'],
        requesterUserId: '222',
      }),
    ).toBe(true);
  });
});

describe('handleSystemUpdate', () => {
  it('refuses when requester is not in operator allowlist', async () => {
    scaf = await setupHandlerTest();
    const result = await handleSystemUpdate(
      {
        ...scaf.ctx,
        operatorDiscordUserIds: ['operator-1'],
        requesterUserId: 'attacker-99',
      },
      {},
    );
    expect(result.tag).toBe('system.update.unauthorized');
    expect(result.content).toContain('operator');
  });

  it('refuses when allowlist is non-empty but requesterUserId is missing', async () => {
    scaf = await setupHandlerTest();
    const result = await handleSystemUpdate(
      {
        ...scaf.ctx,
        operatorDiscordUserIds: ['operator-1'],
        // requesterUserId omitted
      },
      {},
    );
    expect(result.tag).toBe('system.update.unauthorized');
  });

  it('refuses even with an empty allowlist (closed by default)', async () => {
    scaf = await setupHandlerTest();
    const result = await handleSystemUpdate(
      {
        ...scaf.ctx,
        operatorDiscordUserIds: [],
        requesterUserId: 'anyone',
      },
      {},
    );
    expect(result.tag).toBe('system.update.unauthorized');
  });
});

describe('handleSystemRegenerateKnowledge', () => {
  it('operator が regenerate_knowledge → repo.writeKnowledgeFiles を呼ぶ', async () => {
    scaf = await setupHandlerTest({
      account: {
        account_id: 'zumi-x',
        display_name: 'Zumi',
        voice_profile: { default_character: 'practical_operator' },
      },
    });
    const spy = vi.spyOn(scaf.repo, 'writeKnowledgeFiles');
    const result = await handleSystemRegenerateKnowledge(
      {
        ...scaf.ctx,
        operatorDiscordUserIds: ['operator-1'],
        requesterUserId: 'operator-1',
      },
      {},
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.tag).toBe('system.regenerate_knowledge.ok');
    expect(result.content).toContain('AGENTS.md');
  });

  it('non-operator は unauthorized', async () => {
    scaf = await setupHandlerTest();
    const spy = vi.spyOn(scaf.repo, 'writeKnowledgeFiles');
    const result = await handleSystemRegenerateKnowledge(
      {
        ...scaf.ctx,
        operatorDiscordUserIds: ['operator-1'],
        requesterUserId: 'attacker-99',
      },
      {},
    );
    expect(spy).not.toHaveBeenCalled();
    expect(result.tag).toBe('system.regenerate_knowledge.unauthorized');
    expect(result.content).toContain('operator');
  });
});
