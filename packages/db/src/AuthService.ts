/**
 * Authentication service for shared PostgreSQL deployments.
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import pg from 'pg';
function uuidv4(): string {
  return crypto.randomUUID();
}

const { Pool } = pg;

export type AuthUser = {
  id: string;
  email: string;
  displayName: string;
  teamId?: string;
};

export type AuthSession = {
  token: string;
  user: AuthUser;
  expiresAt: number;
};

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export class AuthService {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async register(email: string, password: string, displayName?: string): Promise<AuthSession> {
    const normalized = email.trim().toLowerCase();
    const existing = await this.pool.query('SELECT id FROM users WHERE email = $1', [normalized]);
    if (existing.rows.length > 0) {
      throw new Error('EMAIL_EXISTS');
    }
    const userId = uuidv4();
    const teamId = uuidv4();
    const passwordHash = await bcrypt.hash(password, 10);
    const now = Date.now();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO users(id, email, password_hash, display_name, created_at) VALUES($1,$2,$3,$4,$5)',
        [userId, normalized, passwordHash, displayName ?? normalized.split('@')[0], now]
      );
      await client.query(
        'INSERT INTO teams(id, name, owner_id, created_at) VALUES($1,$2,$3,$4)',
        [teamId, `${displayName ?? 'My'} Team`, userId, now]
      );
      await client.query(
        'INSERT INTO team_members(team_id, user_id, role, joined_at) VALUES($1,$2,$3,$4)',
        [teamId, userId, 'owner', now]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return this.createSession(userId, teamId);
  }

  async login(email: string, password: string): Promise<AuthSession> {
    const normalized = email.trim().toLowerCase();
    const res = await this.pool.query(
      'SELECT id, password_hash, display_name FROM users WHERE email = $1',
      [normalized]
    );
    const row = res.rows[0];
    if (!row) throw new Error('INVALID_CREDENTIALS');
    const ok = await bcrypt.compare(password, row.password_hash as string);
    if (!ok) throw new Error('INVALID_CREDENTIALS');
    const teamRes = await this.pool.query(
      'SELECT team_id FROM team_members WHERE user_id = $1 LIMIT 1',
      [row.id]
    );
    const teamId = teamRes.rows[0]?.team_id as string | undefined;
    return this.createSession(row.id as string, teamId);
  }

  async validateSession(token: string): Promise<AuthUser | null> {
    const tokenHash = hashToken(token);
    const res = await this.pool.query(
      `SELECT s.user_id, s.expires_at, u.email, u.display_name
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1`,
      [tokenHash]
    );
    const row = res.rows[0];
    if (!row) return null;
    if (Number(row.expires_at) < Date.now()) {
      await this.pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
      return null;
    }
    const teamRes = await this.pool.query(
      'SELECT team_id FROM team_members WHERE user_id = $1 LIMIT 1',
      [row.user_id]
    );
    return {
      id: row.user_id as string,
      email: row.email as string,
      displayName: (row.display_name as string) ?? '',
      teamId: teamRes.rows[0]?.team_id as string | undefined,
    };
  }

  async logout(token: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
  }

  async inviteToTeam(teamId: string, inviterUserId: string, email: string): Promise<void> {
    const memberCheck = await this.pool.query(
      'SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2',
      [teamId, inviterUserId]
    );
    if (!memberCheck.rows[0]) throw new Error('FORBIDDEN');
    const userRes = await this.pool.query('SELECT id FROM users WHERE email = $1', [
      email.trim().toLowerCase(),
    ]);
    const userId = userRes.rows[0]?.id as string | undefined;
    if (!userId) throw new Error('USER_NOT_FOUND');
    await this.pool.query(
      `INSERT INTO team_members(team_id, user_id, role, joined_at) VALUES($1,$2,$3,$4)
       ON CONFLICT DO NOTHING`,
      [teamId, userId, 'member', Date.now()]
    );
  }

  private async createSession(userId: string, teamId?: string): Promise<AuthSession> {
    const token = crypto.randomBytes(32).toString('hex');
    const sessionId = uuidv4();
    const expiresAt = Date.now() + SESSION_TTL_MS;
    await this.pool.query(
      'INSERT INTO sessions(id, user_id, token_hash, expires_at, created_at) VALUES($1,$2,$3,$4,$5)',
      [sessionId, userId, hashToken(token), expiresAt, Date.now()]
    );
    const userRes = await this.pool.query(
      'SELECT email, display_name FROM users WHERE id = $1',
      [userId]
    );
    const u = userRes.rows[0];
    return {
      token,
      expiresAt,
      user: {
        id: userId,
        email: u.email as string,
        displayName: (u.display_name as string) ?? '',
        teamId,
      },
    };
  }
}

export class ShareLinkService {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async createLink(
    workspaceId: string,
    createdBy: string,
    teamId?: string,
    label?: string,
    ttlMs?: number
  ): Promise<{ id: string; token: string; url: string }> {
    const id = uuidv4();
    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = ttlMs ? Date.now() + ttlMs : null;
    await this.pool.query(
      'INSERT INTO share_links(id, workspace_id, team_id, created_by, label, token, created_at, expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, workspaceId, teamId ?? null, createdBy, label ?? 'Report', token, Date.now(), expiresAt]
    );
    return { id, token, url: `/share/${token}` };
  }

  async resolveToken(token: string): Promise<{ workspaceId: string; label: string } | null> {
    const res = await this.pool.query(
      'SELECT workspace_id, label, expires_at FROM share_links WHERE token = $1',
      [token]
    );
    const row = res.rows[0];
    if (!row) return null;
    if (row.expires_at && Number(row.expires_at) < Date.now()) return null;
    return { workspaceId: row.workspace_id as string, label: (row.label as string) ?? 'Report' };
  }
}
