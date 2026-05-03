import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dispatchOnboardingButton,
  parseOnboardingCustomId,
} from '../../../src/discord/onboarding-buttons.js';
import { setupHandlerTest, type TestHandlerScaffold } from '../handlers/test-helpers.js';
import type { OnboardingSession } from '../../../src/onboarding/collector.js';

let scaf: TestHandlerScaffold;
afterEach(async () => {
  await scaf?.cleanup();
});

interface FakeInteraction {
  customId: string;
  deferred: boolean;
  replied: boolean;
  deferReply: ReturnType<typeof vi.fn>;
  editReply: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
  followUp: ReturnType<typeof vi.fn>;
}

function makeInteraction(customId: string): FakeInteraction {
  const interaction: FakeInteraction = {
    customId,
    deferred: false,
    replied: false,
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => {
      interaction.replied = true;
    }),
    followUp: vi.fn(async () => undefined),
  };
  return interaction;
}

function session(overrides: Partial<OnboardingSession> = {}): OnboardingSession {
  return {
    id: 'onb_1',
    state: 'asking',
    currentQuestionId: 'x_handle',
    answers: {},
    createdAt: '2026-05-03T00:00:00.000Z',
    updatedAt: '2026-05-03T00:00:00.000Z',
    expiresAt: '2026-05-04T00:00:00.000Z',
    threadId: null,
    channelId: null,
    pending_review_questions: [],
    ...overrides,
  };
}

describe('parseOnboardingCustomId', () => {
  it('parses review and cancel buttons', () => {
    expect(parseOnboardingCustomId('onboard:review:keep:onb_1')).toEqual({
      action: 'keep',
      sessionId: 'onb_1',
    });
    expect(parseOnboardingCustomId('onboard:review:change:onb_1')).toEqual({
      action: 'change',
      sessionId: 'onb_1',
    });
    expect(parseOnboardingCustomId('onboard:cancel:onb_1')).toEqual({
      action: 'cancel',
      sessionId: 'onb_1',
    });
  });
});

describe('dispatchOnboardingButton', () => {
  it('keep calls keepCurrentReviewAnswer and renders the next prompt', async () => {
    scaf = await setupHandlerTest();
    const collector = {
      keepCurrentReviewAnswer: vi.fn(async () => session({ currentQuestionId: 'x_handle' })),
      changeCurrentReviewAnswer: vi.fn(),
      cancel: vi.fn(),
      finalize: vi.fn(),
    };
    const interaction = makeInteraction('onboard:review:keep:onb_1');

    await dispatchOnboardingButton(interaction as never, {
      ctx: scaf.ctx,
      collectorFactory: () => collector as never,
    });

    expect(collector.keepCurrentReviewAnswer).toHaveBeenCalledWith('onb_1');
    expect(collector.changeCurrentReviewAnswer).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalled();
    expect(JSON.stringify(interaction.editReply.mock.calls[0]?.[0])).toContain('onboard:cancel:onb_1');
  });

  it('change calls changeCurrentReviewAnswer and keeps the same question visible', async () => {
    scaf = await setupHandlerTest();
    const collector = {
      keepCurrentReviewAnswer: vi.fn(),
      changeCurrentReviewAnswer: vi.fn(async () => session({ currentQuestionId: 'display_name' })),
      cancel: vi.fn(),
      finalize: vi.fn(),
    };
    const interaction = makeInteraction('onboard:review:change:onb_1');

    await dispatchOnboardingButton(interaction as never, {
      ctx: scaf.ctx,
      collectorFactory: () => collector as never,
    });

    expect(collector.changeCurrentReviewAnswer).toHaveBeenCalledWith('onb_1');
    const payload = interaction.editReply.mock.calls[0]?.[0] as { content?: string };
    expect(payload.content).toContain('X で使う表示名');
  });

  it('cancel calls cancel', async () => {
    scaf = await setupHandlerTest();
    const collector = {
      keepCurrentReviewAnswer: vi.fn(),
      changeCurrentReviewAnswer: vi.fn(),
      cancel: vi.fn(async () => undefined),
      finalize: vi.fn(),
    };
    const interaction = makeInteraction('onboard:review:cancel:onb_1');

    await dispatchOnboardingButton(interaction as never, {
      ctx: scaf.ctx,
      collectorFactory: () => collector as never,
    });

    expect(collector.cancel).toHaveBeenCalledWith('onb_1');
    expect(interaction.editReply).toHaveBeenCalled();
  });
});
