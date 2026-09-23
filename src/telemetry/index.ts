import { Heartbeat, MongoHeartbeatWriter } from './heartbeat.js';
import { HttpStats } from './httpStats.js';
import { JobTracker } from './jobs.js';
import { LogCounter } from './logCounter.js';
import { MongoActivity } from './mongoActivity.js';

/** Service name in heartbeats and log lines — must match the webapi registry (`mcp`). */
export const TELEMETRY_SERVICE = 'mcp';

export interface Telemetry {
  logCounter: LogCounter;
  activity: MongoActivity;
  jobs: JobTracker;
  http: HttpStats;
}

export function createTelemetry(): Telemetry {
  return { logCounter: new LogCounter(), activity: new MongoActivity(), jobs: new JobTracker(), http: new HttpStats() };
}

export function startHeartbeat(
  telemetry: Telemetry,
  options: { mongoUri: string; database: string; onWarn: (message: string) => void },
): Heartbeat {
  const heartbeat = new Heartbeat({
    service: TELEMETRY_SERVICE,
    writer: new MongoHeartbeatWriter(options.mongoUri, options.database),
    activity: telemetry.activity,
    logCounter: telemetry.logCounter,
    jobs: telemetry.jobs,
    providers: { http: () => ({ ...telemetry.http.snapshotAndReset() }) },
    onWarn: options.onWarn,
  });
  heartbeat.start();
  return heartbeat;
}

export { telemetryLoggerOptions } from './logging.js';
export type { HttpStats } from './httpStats.js';
export type { JobTracker } from './jobs.js';
export type { MongoActivity } from './mongoActivity.js';
