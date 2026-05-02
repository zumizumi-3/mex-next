import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from 'pino';

export type RetroCronKind =
  | 'daily_retro'
  | 'weekly_retro'
  | 'monthly_retro'
  | 'quarterly_retro'
  | 'half_retro';

export type PhaseQuestionnaireCronCadence = 'weekly' | 'monthly' | 'quarterly';

export interface CronWebhookOptions {
  readonly port: number;
  readonly host?: string;
  readonly secret: string;
  readonly accountId: string;
  readonly logger: Logger;
  readonly handlers: {
    daily_retro: () => Promise<void>;
    weekly_retro: () => Promise<void>;
    monthly_retro: () => Promise<void>;
    quarterly_retro: () => Promise<void>;
    half_retro: () => Promise<void>;
    phase_questionnaire: (cadence: PhaseQuestionnaireCronCadence) => Promise<void>;
  };
}

type CronTrigger =
  | {
      kind: RetroCronKind;
      account_id: string;
    }
  | {
      kind: 'phase_questionnaire';
      account_id: string;
      cadence: PhaseQuestionnaireCronCadence;
    };

const MAX_BODY_BYTES = 64 * 1024;
const TRIGGER_PATH = '/v1/cron-trigger';

export class CronWebhookServer {
  private readonly server: Server;
  private started = false;

  constructor(private readonly opts: CronWebhookOptions) {
    if (opts.secret.length === 0) {
      throw new Error('CronWebhookServer requires a non-empty secret');
    }
    this.server = createServer((req, res) => {
      void this.route(req, res);
    });
  }

  get listeningPort(): number {
    const address = this.server.address();
    if (address && typeof address === 'object') return (address as AddressInfo).port;
    return this.opts.port;
  }

  async start(): Promise<void> {
    if (this.started) return;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.server.off('error', onError);
        this.started = true;
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.opts.port, this.opts.host ?? '0.0.0.0');
    });
    this.opts.logger.info(
      { port: this.listeningPort, accountId: this.opts.accountId },
      'cron_webhook_started',
    );
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    this.started = false;
    this.opts.logger.info('cron_webhook_stopped');
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method !== 'POST' || url.pathname !== TRIGGER_PATH) {
      sendJson(res, 404, { ok: false, error: 'not_found' });
      return;
    }

    if (!this.isAuthorized(req.headers.authorization)) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (error: unknown) {
      this.opts.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'cron_webhook_bad_request',
      );
      sendJson(res, 400, { ok: false, error: 'bad_request' });
      return;
    }

    const trigger = parseTrigger(body);
    if (!trigger) {
      sendJson(res, 400, { ok: false, error: 'bad_request' });
      return;
    }

    if (trigger.account_id !== this.opts.accountId) {
      sendJson(res, 404, { ok: false, error: 'account_not_found' });
      return;
    }

    sendJson(res, 200, { ok: true });
    this.runHandler(trigger);
  }

  private isAuthorized(header: string | undefined): boolean {
    const prefix = 'Bearer ';
    if (!header?.startsWith(prefix)) return false;
    const token = header.slice(prefix.length);
    return constantTimeEqual(token, this.opts.secret);
  }

  private runHandler(trigger: CronTrigger): void {
    const promise =
      trigger.kind === 'phase_questionnaire'
        ? this.opts.handlers.phase_questionnaire(trigger.cadence)
        : this.opts.handlers[trigger.kind]();

    void promise
      .then(() => {
        this.opts.logger.info(
          { kind: trigger.kind, accountId: trigger.account_id },
          'cron_webhook_handler_done',
        );
      })
      .catch((error: unknown) => {
        this.opts.logger.error(
          {
            kind: trigger.kind,
            accountId: trigger.account_id,
            error: error instanceof Error ? error.message : String(error),
          },
          'cron_webhook_handler_failed',
        );
      });
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a).digest();
  const digestB = createHash('sha256').update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

function parseTrigger(value: unknown): CronTrigger | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const accountId = record.account_id;
  const kind = record.kind;
  if (typeof accountId !== 'string' || typeof kind !== 'string') return null;

  if (isRetroKind(kind)) {
    return { kind, account_id: accountId };
  }

  if (kind === 'phase_questionnaire' && isPhaseCadence(record.cadence)) {
    return { kind, account_id: accountId, cadence: record.cadence };
  }

  return null;
}

function isRetroKind(kind: string): kind is RetroCronKind {
  return (
    kind === 'daily_retro' ||
    kind === 'weekly_retro' ||
    kind === 'monthly_retro' ||
    kind === 'quarterly_retro' ||
    kind === 'half_retro'
  );
}

function isPhaseCadence(value: unknown): value is PhaseQuestionnaireCronCadence {
  return value === 'weekly' || value === 'monthly' || value === 'quarterly';
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error('request body too large');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function sendJson(res: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
  const text = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}
