import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { LogCounter } from '../../src/telemetry/logCounter.js';
import { telemetryLoggerOptions, toTelemetryFields } from '../../src/telemetry/logging.js';

function capture(counter?: LogCounter) {
  const lines: Record<string, unknown>[] = [];
  const log = pino(telemetryLoggerOptions({ service: 'mcp', level: 'debug', counter }), {
    write: (line: string) => {
      lines.push(JSON.parse(line));
    },
  });
  return { log, lines };
}

describe('telemetry log format', () => {
  it('writes fc-telemetry fields with Python level names and an ISO timestamp', () => {
    const { log, lines } = capture();
    log.info('mcp-fc listening on :8814');
    log.warn('slow');
    expect(lines[0]).toMatchObject({ service: 'mcp', logger: 'mcp-fc', level: 'INFO', msg: 'mcp-fc listening on :8814' });
    expect(lines[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(lines[1].level).toBe('WARNING');
    expect(lines[0]).not.toHaveProperty('pid');
    expect(lines[0]).not.toHaveProperty('time');
  });

  it('maps tool/ms/err to job/duration_ms/exc and nests everything else under extra', () => {
    const { log, lines } = capture();
    log.info({ tool: 'get_financials', key: 'agent1', ms: 42 }, 'tool ok');
    log.error({ tool: 'search_news', err: new Error('kaputt') }, 'tool failed');
    expect(lines[0]).toMatchObject({ job: 'get_financials', duration_ms: 42, extra: { key: 'agent1' }, msg: 'tool ok' });
    expect(lines[0]).not.toHaveProperty('tool');
    expect(lines[1].level).toBe('ERROR');
    expect(String(lines[1].exc)).toContain('Error: kaputt');
  });

  it('counts warnings and errors, fatal as error', () => {
    const counter = new LogCounter();
    const { log } = capture(counter);
    log.info('a');
    log.warn('b');
    log.error('c');
    log.fatal('d');
    expect(counter.snapshotAndReset()).toEqual({ warnings: 1, errors: 2 });
    expect(counter.snapshotAndReset()).toEqual({ warnings: 0, errors: 0 });
  });

  it('keeps a plain string error as is', () => {
    expect(toTelemetryFields({ err: 'boom' })).toEqual({ exc: 'boom' });
  });
});
