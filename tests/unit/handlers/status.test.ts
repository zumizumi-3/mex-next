import { describe, it, expect, afterEach } from 'vitest';
import { handleStatusShow, handleHelpShow, handleUnknown } from '../../../src/handlers/index.js';
import { setupHandlerTest, type TestHandlerScaffold } from './test-helpers.js';

let scaf: TestHandlerScaffold;
afterEach(async () => {
  await scaf?.cleanup();
});

describe('handleStatusShow', () => {
  it('account / cadence / 予約数 を含む', async () => {
    scaf = await setupHandlerTest();
    const result = await handleStatusShow(scaf.ctx, {});
    expect(result.content).toContain('account');
    expect(result.content).toContain('cadence');
  });
});

describe('handleHelpShow', () => {
  it('使い方の例を含む', async () => {
    scaf = await setupHandlerTest();
    const result = await handleHelpShow(scaf.ctx, {});
    expect(result.content).toContain('予約見せて');
    expect(result.content).toContain('/mex');
  });
});

describe('handleUnknown', () => {
  it('userMessage を尊重して返す', async () => {
    scaf = await setupHandlerTest();
    const result = await handleUnknown(scaf.ctx, { userMessage: '助けて' });
    expect(result.content).toBe('助けて');
  });

  it('userMessage が無いときは default fallback', async () => {
    scaf = await setupHandlerTest();
    const result = await handleUnknown(scaf.ctx, {});
    expect(result.content).toContain('うまく聞き取れませんでした');
  });
});
