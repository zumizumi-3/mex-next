/**
 * MeX Next entry point.
 *
 * Wires up:
 *  - Discord client (Gateway mode)
 *  - Conversation engine (turn orchestrator + locks + pending recovery)
 *  - Domain handlers (posting / scheduling / settings / x-api)
 *  - LLM bridge
 *  - systemd-friendly signal handling
 *
 * The actual implementation of each subsystem is loaded from its
 * respective module. This file stays intentionally thin so that
 * boot order and lifecycle are obvious.
 */

import { loadConfig } from './config.js';
import { createLogger } from './observability/logger.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const log = createLogger({ level: config.logLevel });

  log.info({ accountId: config.accountId }, 'mex-next booting');

  // The real wiring (Discord client, conversation engine, domain handlers)
  // is added by WO-FRESH-2..8. This skeleton exists so `npm run build`
  // succeeds out of the box.

  log.info('mex-next foundation ready (modules pending)');

  await new Promise<void>((resolve) => {
    process.on('SIGTERM', () => {
      log.info('SIGTERM received');
      resolve();
    });
    process.on('SIGINT', () => {
      log.info('SIGINT received');
      resolve();
    });
  });

  log.info('mex-next shutdown');
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('fatal:', error);
  process.exit(1);
});
