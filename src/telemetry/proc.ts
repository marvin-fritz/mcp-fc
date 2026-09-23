import { readFileSync } from 'node:fs';

export interface ProcSnapshot {
  cpuPct: number;
  threads: number;
  rssMb: number;
}

function readThreads(statusPath: string): number | null {
  try {
    const match = readFileSync(statusPath, 'utf8').match(/^Threads:\s+(\d+)/m);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/** Process metrics without extra deps: CPU share since the last call, OS threads, RSS. */
export class ProcStats {
  private readonly clock: () => number;
  private readonly statusPath: string;
  private lastCpuSec: number | null = null;
  private lastWallSec: number | null = null;

  /** `clock` returns seconds (monotonic). */
  constructor(clock: () => number = () => performance.now() / 1000, statusPath = '/proc/self/status') {
    this.clock = clock;
    this.statusPath = statusPath;
  }

  snapshot(): ProcSnapshot {
    const usage = process.cpuUsage();
    const cpuSec = (usage.user + usage.system) / 1e6;
    const wallSec = this.clock();
    let cpuPct = 0;
    if (this.lastCpuSec !== null && this.lastWallSec !== null && wallSec > this.lastWallSec) {
      cpuPct = Math.round(((cpuSec - this.lastCpuSec) / (wallSec - this.lastWallSec)) * 1000) / 10;
    }
    this.lastCpuSec = cpuSec;
    this.lastWallSec = wallSec;
    return {
      cpuPct: Math.max(0, cpuPct),
      threads: readThreads(this.statusPath) ?? 1,
      rssMb: Math.round((process.memoryUsage.rss() / (1024 * 1024)) * 10) / 10,
    };
  }
}
