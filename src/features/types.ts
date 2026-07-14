import type { Db } from 'mongodb';
import type { Logger } from 'pino';
import type { ZodRawShape } from 'zod';
import type { Scope } from '../config.js';
import type { AuthContext } from '../auth/apiKey.js';

export interface ToolCtx {
  db: Db;
  auth: AuthContext;
  log: Logger;
}

export interface ToolDef {
  name: string;
  title: string;
  /** Include units and one example call — agents rely on this. */
  description: string;
  inputSchema: ZodRawShape;
  requiredScope: Scope;
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean };
  handler(input: any, ctx: ToolCtx): Promise<string>;
}

export interface FeatureModule {
  name: string;
  tools: ToolDef[];
}

/** Business error whose message is shown verbatim to the agent (prefixed with ERROR:). */
export class ToolError extends Error {}
