import { randomBytes } from 'node:crypto';
import type { Db, Document } from 'mongodb';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Scope } from '../../config.js';

export const CODE_TTL_MS = 10 * 60_000;
export const REFRESH_TTL_MS = 30 * 24 * 3_600_000;

export interface AuthCodeDoc {
  _id: string;
  clientId: string;
  userId: string;
  email: string;
  scopes: Scope[];
  codeChallenge: string;
  redirectUri: string;
  resource?: string;
  expiresAt: Date;
}

export interface RefreshTokenDoc {
  _id: string;
  clientId: string;
  userId: string;
  email: string;
  scopes: Scope[];
  expiresAt: Date;
}

interface ClientDoc extends Document {
  _id: string;
}

const newToken = (): string => randomBytes(32).toString('hex');

/** OAuth artifacts in a dedicated MongoDB database (spec: MONGODB_AUTH_DB, default 'mcp-fc'). */
export class AuthStore {
  constructor(private db: Db) {}

  private get clientsCol() {
    return this.db.collection<ClientDoc>('oauthClients');
  }
  private get codesCol() {
    return this.db.collection<AuthCodeDoc>('oauthCodes');
  }
  private get refreshCol() {
    return this.db.collection<RefreshTokenDoc>('oauthRefreshTokens');
  }

  get clients(): OAuthRegisteredClientsStore {
    const col = this.clientsCol;
    return {
      async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
        const doc = await col.findOne({ _id: clientId });
        if (!doc) return undefined;
        const { _id, ...rest } = doc;
        return { ...rest, client_id: _id } as OAuthClientInformationFull;
      },
      async registerClient(client): Promise<OAuthClientInformationFull> {
        const clientId = randomBytes(16).toString('hex');
        await col.insertOne({ ...(client as Document), _id: clientId } as ClientDoc);
        return { ...client, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) } as OAuthClientInformationFull;
      },
    };
  }

  async createCode(data: Omit<AuthCodeDoc, '_id' | 'expiresAt'>): Promise<string> {
    const code = newToken();
    await this.codesCol.insertOne({ ...data, _id: code, expiresAt: new Date(Date.now() + CODE_TTL_MS) });
    return code;
  }

  async peekCode(code: string): Promise<AuthCodeDoc | null> {
    const doc = await this.codesCol.findOne({ _id: code });
    return doc && doc.expiresAt > new Date() ? doc : null;
  }

  async consumeCode(code: string): Promise<AuthCodeDoc | null> {
    const doc = await this.codesCol.findOneAndDelete({ _id: code });
    return doc && doc.expiresAt > new Date() ? doc : null;
  }

  async createRefreshToken(data: Omit<RefreshTokenDoc, '_id' | 'expiresAt'>): Promise<string> {
    const token = newToken();
    await this.refreshCol.insertOne({ ...data, _id: token, expiresAt: new Date(Date.now() + REFRESH_TTL_MS) });
    return token;
  }

  /** Single-use rotation: deletes the presented token and issues a fresh one. */
  async rotateRefreshToken(token: string, clientId: string): Promise<{ next: string; doc: RefreshTokenDoc } | null> {
    const doc = await this.refreshCol.findOneAndDelete({ _id: token, clientId });
    if (!doc || doc.expiresAt <= new Date()) return null;
    const next = await this.createRefreshToken({ clientId: doc.clientId, userId: doc.userId, email: doc.email, scopes: doc.scopes });
    return { next, doc };
  }

  async revokeRefreshToken(token: string): Promise<void> {
    await this.refreshCol.deleteOne({ _id: token });
  }

  async ensureIndexes(): Promise<void> {
    await this.codesCol.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await this.refreshCol.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  }
}
