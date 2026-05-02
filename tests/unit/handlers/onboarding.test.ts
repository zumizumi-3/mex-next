import { describe, it, expect, afterEach } from 'vitest';
import {
  handleOnboardStart,
  handleOnboardStatus,
  handleOnboardCancel,
} from '../../../src/handlers/onboarding.js';
import { OnboardingCollector } from '../../../src/onboarding/collector.js';
import { setupHandlerTest, type TestHandlerScaffold } from './test-helpers.js';

let scaf: TestHandlerScaffold;
afterEach(async () => {
  await scaf?.cleanup();
});

describe('handleOnboardStart', () => {
  it('creates a session and surfaces Q1', async () => {
    scaf = await setupHandlerTest();
    const result = await handleOnboardStart(scaf.ctx, {});
    expect(result.tag).toBe('onboard.start');
    expect(result.content).toContain('Q1/');
    expect(result.content).toContain('オンボーディング');
    const collector = new OnboardingCollector({
      repo: scaf.ctx.repo,
      bridge: scaf.ctx.bridge,
      logger: scaf.ctx.logger,
    });
    const active = await collector.getActive();
    expect(active).not.toBeNull();
    expect(active?.state).toBe('asking');
  });

  it('returning when no active session present is OK (idempotent)', async () => {
    scaf = await setupHandlerTest();
    const a = await handleOnboardStart(scaf.ctx, {});
    const b = await handleOnboardStart(scaf.ctx, {});
    expect(a.tag).toBe('onboard.start');
    expect(b.tag).toBe('onboard.start');
  });
});

describe('handleOnboardStatus', () => {
  it('idle when no session', async () => {
    scaf = await setupHandlerTest();
    const result = await handleOnboardStatus(scaf.ctx, {});
    expect(result.tag).toBe('onboard.status.idle');
    expect(result.content).toContain('オンボーディング中ではありません');
  });

  it('reports answered count and current question after start', async () => {
    scaf = await setupHandlerTest();
    await handleOnboardStart(scaf.ctx, {});
    const result = await handleOnboardStatus(scaf.ctx, {});
    expect(result.tag).toBe('onboard.status');
    expect(result.content).toContain('回答済: 0/');
    expect(result.content).toContain('現在の質問');
  });
});

describe('handleOnboardCancel', () => {
  it('noop when no active session', async () => {
    scaf = await setupHandlerTest();
    const result = await handleOnboardCancel(scaf.ctx, {});
    expect(result.tag).toBe('onboard.cancel.noop');
  });

  it('cancels an active session', async () => {
    scaf = await setupHandlerTest();
    await handleOnboardStart(scaf.ctx, {});
    const result = await handleOnboardCancel(scaf.ctx, {});
    expect(result.tag).toBe('onboard.cancel');
    expect(result.content).toContain('中断しました');
  });
});
