export interface JobError {
  job: string;
  type: string;
  message: string;
  ts: string;
}

export interface JobState {
  current: string[];
  lastError: JobError | null;
  errorsTotal: number;
}

const MESSAGE_MAX = 500;

/** Running jobs (for mcp-fc: tool calls) and the last job failure, process-wide. */
export class JobTracker {
  private readonly now: () => Date;
  private readonly active = new Map<string, number>();
  private lastError: JobError | null = null;
  private errorsTotal = 0;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  /** Marks `name` as running; the returned function ends this run (idempotent). */
  start(name: string): () => void {
    this.active.set(name, (this.active.get(name) ?? 0) + 1);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const left = (this.active.get(name) ?? 1) - 1;
      if (left <= 0) this.active.delete(name);
      else this.active.set(name, left);
    };
  }

  recordError(name: string, error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    this.errorsTotal += 1;
    this.lastError = {
      job: name,
      type: err.name || 'Error',
      message: err.message.slice(0, MESSAGE_MAX),
      ts: this.now().toISOString(),
    };
  }

  state(): JobState {
    return {
      current: [...this.active.keys()].sort(),
      lastError: this.lastError ? { ...this.lastError } : null,
      errorsTotal: this.errorsTotal,
    };
  }
}
