import type { LoggerOptions } from 'pino';
import type { LogCounter } from './logCounter.js';

/** pino level label -> Python level name, as the webapi journal parser expects. */
const LEVEL_NAMES: Record<string, string> = {
  trace: 'DEBUG',
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
  fatal: 'CRITICAL',
};

function formatError(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (value && typeof value === 'object') {
    const err = value as { stack?: unknown; type?: unknown; message?: unknown };
    if (typeof err.stack === 'string') return err.stack;
    if (typeof err.message === 'string') return typeof err.type === 'string' ? `${err.type}: ${err.message}` : err.message;
  }
  return String(value);
}

/**
 * Maps a pino log object onto the fc-telemetry line schema: `job`, `duration_ms` and
 * `exc` stay top-level (the existing `tool` / `ms` / `err` fields are renamed to them),
 * everything else moves under `extra` — the webapi journal parser drops unknown keys.
 */
export function toTelemetryFields(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'job' || key === 'tool') out.job = value;
    else if (key === 'duration_ms' || key === 'ms') out.duration_ms = value;
    else if (key === 'exc' || key === 'err') out.exc = formatError(value);
    else extra[key] = value;
  }
  if (Object.keys(extra).length > 0) out.extra = extra;
  return out;
}

export interface TelemetryLoggerConfig {
  service: string;
  level: string;
  logger?: string;
  counter?: LogCounter;
}

/** pino options producing one fc-telemetry JSON line per event (ts, service, level, logger, msg, …). */
export function telemetryLoggerOptions({ service, level, logger = 'mcp-fc', counter }: TelemetryLoggerConfig): LoggerOptions {
  return {
    level,
    base: { service, logger },
    messageKey: 'msg',
    timestamp: () => `,"ts":"${new Date().toISOString()}"`,
    formatters: {
      level: (label) => ({ level: LEVEL_NAMES[label] ?? label.toUpperCase() }),
      log: (obj) => toTelemetryFields(obj),
    },
    // pino rejects `hooks: undefined` (it replaces the defaults) — only set the key when counting.
    ...(counter && {
      hooks: {
        logMethod(args, method, levelNumber) {
          counter.record(levelNumber);
          return method.apply(this, args);
        },
      },
    }),
  };
}
