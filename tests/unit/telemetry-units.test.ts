import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { HttpStats } from '../../src/telemetry/httpStats.js';
import { JobTracker } from '../../src/telemetry/jobs.js';
import { ProcStats } from '../../src/telemetry/proc.js';
import { detectVersion } from '../../src/telemetry/version.js';

describe('JobTracker', () => {
  it('lists running jobs sorted and counts parallel runs of the same job', () => {
    const jobs = new JobTracker();
    const endFirst = jobs.start('search_news');
    const endOther = jobs.start('get_financials');
    const endSecond = jobs.start('search_news');
    expect(jobs.state().current).toEqual(['get_financials', 'search_news']);
    endFirst();
    expect(jobs.state().current).toEqual(['get_financials', 'search_news']);
    endSecond();
    endSecond();
    endOther();
    expect(jobs.state().current).toEqual([]);
  });

  it('records the last error with type, truncated message and ISO timestamp', () => {
    const jobs = new JobTracker(() => new Date('2026-09-23T10:00:00.000Z'));
    class MongoServerSelectionError extends Error {
      override name = 'MongoServerSelectionError';
    }
    jobs.recordError('get_prices', new MongoServerSelectionError('x'.repeat(600)));
    const first = jobs.state().lastError;
    expect(first?.type).toBe('MongoServerSelectionError');
    expect(first?.message).toHaveLength(500);
    jobs.recordError('search_news', 'kaputt');
    expect(jobs.state()).toMatchObject({
      errorsTotal: 2,
      lastError: { job: 'search_news', type: 'Error', message: 'kaputt', ts: '2026-09-23T10:00:00.000Z' },
    });
  });
});

describe('HttpStats', () => {
  it('counts requests, 5xx and latency but skips /healthz', async () => {
    let now = 0;
    const stats = new HttpStats(() => (now += 10));
    const app = express();
    app.use(stats.middleware());
    app.get('/healthz', (_req, res) => {
      res.json({ ok: true });
    });
    app.post('/mcp', (_req, res) => {
      res.json({ ok: true });
    });
    app.post('/boom', (_req, res) => {
      res.status(503).json({ error: 'down' });
    });
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    try {
      await fetch(`http://127.0.0.1:${port}/healthz`);
      await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' });
      await fetch(`http://127.0.0.1:${port}/boom`, { method: 'POST' });
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      server.closeAllConnections();
      server.close();
    }
    expect(stats.snapshotAndReset()).toEqual({ requests: 2, errors5xx: 1, latencyMsAvg: 10 });
    expect(stats.snapshotAndReset()).toEqual({ requests: 0, errors5xx: 0, latencyMsAvg: 0 });
  });
});

describe('detectVersion', () => {
  const sha = `db41124${'a'.repeat(33)}`;

  function repo(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'fc-version-'));
    for (const [path, content] of Object.entries(files)) {
      const full = join(dir, '.git', path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    return dir;
  }

  it('prefers FC_SERVICE_VERSION', () => {
    expect(detectVersion({ FC_SERVICE_VERSION: '1.2.3' }, '/nonexistent')).toBe('1.2.3');
  });

  it('reads the short SHA of the checked-out branch', () => {
    expect(detectVersion({}, repo({ HEAD: 'ref: refs/heads/main\n', 'refs/heads/main': `${sha}\n` }))).toBe('db41124');
  });

  it('falls back to packed-refs', () => {
    const dir = repo({ HEAD: 'ref: refs/heads/main\n', 'packed-refs': `# pack-refs with: peeled fully-peeled sorted\n${sha} refs/heads/main\n` });
    expect(detectVersion({}, dir)).toBe('db41124');
  });

  it('handles a detached HEAD', () => {
    expect(detectVersion({}, repo({ HEAD: `${sha}\n` }))).toBe('db41124');
  });

  it('returns unknown without git metadata', () => {
    expect(detectVersion({}, '/nonexistent')).toBe('unknown');
  });
});

describe('ProcStats', () => {
  it('reports rss, threads and a non-negative cpu share (0 on the first call)', () => {
    let wall = 0;
    const proc = new ProcStats(() => (wall += 1));
    const first = proc.snapshot();
    expect(first.cpuPct).toBe(0);
    expect(first.rssMb).toBeGreaterThan(0);
    expect(first.threads).toBeGreaterThanOrEqual(1);
    expect(Object.keys(first)).toEqual(['cpuPct', 'threads', 'rssMb']);
    expect(proc.snapshot().cpuPct).toBeGreaterThanOrEqual(0);
  });
});
