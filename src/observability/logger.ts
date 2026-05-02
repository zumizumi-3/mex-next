/**
 * Structured logger built on pino.
 *
 * Single instance per subsystem via `log.child({ subsystem: '...' })`.
 * JSON output to stdout so systemd / journald can index it.
 */

import pino, { type Logger } from 'pino';

export interface LoggerOptions {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error';
}

export function createLogger(options: LoggerOptions): Logger {
  return pino({
    level: options.level,
    timestamp: pino.stdTimeFunctions.isoTime,
    base: undefined,
  });
}
