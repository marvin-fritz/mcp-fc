import type { RequestHandler } from 'express';

export interface HttpSnapshot {
  requests: number;
  errors5xx: number;
  latencyMsAvg: number;
}

/**
 * Request counters for the heartbeat `http` block (like webapi's RequestStatsMiddleware).
 * Measured when the response finishes — mcp-fc answers with plain JSON, no streaming.
 */
export class HttpStats {
  private readonly clock: () => number;
  private readonly ignoredPaths: ReadonlySet<string>;
  private requests = 0;
  private errors5xx = 0;
  private latencySumMs = 0;

  constructor(clock: () => number = () => performance.now(), ignoredPaths: ReadonlySet<string> = new Set(['/healthz'])) {
    this.clock = clock;
    this.ignoredPaths = ignoredPaths;
  }

  record(status: number, elapsedMs: number): void {
    this.requests += 1;
    this.latencySumMs += elapsedMs;
    if (status >= 500) this.errors5xx += 1;
  }

  middleware(): RequestHandler {
    return (req, res, next) => {
      if (this.ignoredPaths.has(req.path)) {
        next();
        return;
      }
      const started = this.clock();
      let recorded = false;
      const finish = () => {
        if (recorded) return;
        recorded = true;
        this.record(res.statusCode, this.clock() - started);
      };
      res.once('finish', finish);
      res.once('close', finish);
      next();
    };
  }

  snapshotAndReset(): HttpSnapshot {
    const snap = {
      requests: this.requests,
      errors5xx: this.errors5xx,
      latencyMsAvg: this.requests ? Math.round((this.latencySumMs / this.requests) * 100) / 100 : 0,
    };
    this.requests = 0;
    this.errors5xx = 0;
    this.latencySumMs = 0;
    return snap;
  }
}
