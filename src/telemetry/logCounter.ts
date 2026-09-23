/** Counts WARNING/ERROR log lines (pino levels >= 40 / >= 50) for the heartbeat `logs` block. */
export class LogCounter {
  private warnings = 0;
  private errors = 0;

  record(level: number): void {
    if (level >= 50) this.errors += 1;
    else if (level >= 40) this.warnings += 1;
  }

  snapshotAndReset(): { warnings: number; errors: number } {
    const snap = { warnings: this.warnings, errors: this.errors };
    this.warnings = 0;
    this.errors = 0;
    return snap;
  }
}
