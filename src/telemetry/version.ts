import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SHORT = 7;

function readGitSha(cwd: string): string | null {
  const gitDir = join(cwd, '.git');
  const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
  if (/^[0-9a-f]{40}$/.test(head)) return head.slice(0, SHORT);
  const ref = head.match(/^ref: (.+)$/)?.[1];
  if (!ref) return null;
  try {
    return readFileSync(join(gitDir, ref), 'utf8').trim().slice(0, SHORT);
  } catch {
    const line = readFileSync(join(gitDir, 'packed-refs'), 'utf8')
      .split('\n')
      .find((entry) => entry.endsWith(` ${ref}`));
    return line ? line.slice(0, SHORT) : null;
  }
}

/**
 * Version of the running service: `FC_SERVICE_VERSION`, else the short git SHA read
 * straight from `.git` (no `git` binary, works under the service user), else `unknown`.
 */
export function detectVersion(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  if (env.FC_SERVICE_VERSION) return env.FC_SERVICE_VERSION;
  try {
    return readGitSha(cwd) ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
