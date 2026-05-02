import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import { CronWebhookServer, type CronWebhookOptions } from '../../../src/discord/cron-webhook.js';

let server: CronWebhookServer | null = null;

afterEach(async () => {
  if (server) await server.stop();
  server = null;
  vi.restoreAllMocks();
});

describe('CronWebhookServer', () => {
  it('returns 200 and fires the matching handler for a valid request', async () => {
    const weekly = vi.fn(async () => undefined);
    server = startServer({ weekly_retro: weekly });

    const response = await postTrigger(server, {
      token: 'secret-token',
      body: { kind: 'weekly_retro', account_id: 'zumi-x' },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    await vi.waitFor(() => expect(weekly).toHaveBeenCalledTimes(1));
  });

  it('returns 401 when bearer token is invalid', async () => {
    const weekly = vi.fn(async () => undefined);
    server = startServer({ weekly_retro: weekly });

    const response = await postTrigger(server, {
      token: 'wrong-token',
      body: { kind: 'weekly_retro', account_id: 'zumi-x' },
    });

    expect(response.status).toBe(401);
    expect(weekly).not.toHaveBeenCalled();
  });

  it('returns 404 when account_id does not belong to this bot', async () => {
    const weekly = vi.fn(async () => undefined);
    server = startServer({ weekly_retro: weekly });

    const response = await postTrigger(server, {
      token: 'secret-token',
      body: { kind: 'weekly_retro', account_id: 'other-account' },
    });

    expect(response.status).toBe(404);
    expect(weekly).not.toHaveBeenCalled();
  });

  it('returns 400 for an unknown kind', async () => {
    const weekly = vi.fn(async () => undefined);
    server = startServer({ weekly_retro: weekly });

    const response = await postTrigger(server, {
      token: 'secret-token',
      body: { kind: 'unknown', account_id: 'zumi-x' },
    });

    expect(response.status).toBe(400);
    expect(weekly).not.toHaveBeenCalled();
  });

  it('logs handler failures after the 200 acknowledgement', async () => {
    const error = vi.fn();
    server = startServer(
      {
        weekly_retro: vi.fn(async () => {
          throw new Error('boom');
        }),
      },
      { error },
    );

    const response = await postTrigger(server, {
      token: 'secret-token',
      body: { kind: 'weekly_retro', account_id: 'zumi-x' },
    });

    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(error.mock.calls[0]?.[1]).toBe('cron_webhook_handler_failed');
  });
});

function startServer(
  overrides: Partial<CronWebhookOptions['handlers']>,
  loggerOverrides: Partial<Logger> = {},
): CronWebhookServer {
  const handlers: CronWebhookOptions['handlers'] = {
    daily_retro: async () => undefined,
    weekly_retro: async () => undefined,
    monthly_retro: async () => undefined,
    quarterly_retro: async () => undefined,
    half_retro: async () => undefined,
    phase_questionnaire: async () => undefined,
    ...overrides,
  };
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    ...loggerOverrides,
  } as unknown as Logger;
  return new CronWebhookServer({
    port: 0,
    secret: 'secret-token',
    accountId: 'zumi-x',
    logger,
    handlers,
  });
}

async function postTrigger(
  instance: CronWebhookServer,
  opts: {
    readonly token: string;
    readonly body: Record<string, unknown>;
  },
): Promise<{ status: number; json: () => Promise<unknown> }> {
  return inject(instance, {
    method: 'POST',
    url: '/v1/cron-trigger',
    headers: {
      authorization: `Bearer ${opts.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(opts.body),
  });
}

async function inject(
  instance: CronWebhookServer,
  opts: {
    readonly method: string;
    readonly url: string;
    readonly headers: IncomingHttpHeaders;
    readonly body: string;
  },
): Promise<{ status: number; json: () => Promise<unknown> }> {
  const req = Readable.from([opts.body]) as IncomingMessage;
  req.method = opts.method;
  req.url = opts.url;
  req.headers = opts.headers;

  let status = 0;
  let responseBody = '';
  const ended = new Promise<void>((resolve) => {
    const res = {
      writeHead: (statusCode: number) => {
        status = statusCode;
        return res;
      },
      end: (chunk: unknown) => {
        responseBody =
          typeof chunk === 'string' ? chunk : Buffer.from(chunk as Buffer).toString('utf-8');
        resolve();
      },
    } as unknown as ServerResponse;
    void (
      instance as unknown as {
        route: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
      }
    ).route(req, res);
  });
  await ended;
  return {
    status,
    json: async () => JSON.parse(responseBody),
  };
}
