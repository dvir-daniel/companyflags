// Access tokens: a person's token for the console's API (Authorization: Bearer cfp_…), for scripts, the CLI over HTTP
// and MCP clients (plugins/mcp.ts). A token acts as its person, with a role up to theirs, until it expires or is revoked.
// - A person's own token: any role up to their own.
// - An agent's token: Viewer or Editor only, so an agent never approves, breaks glass or manages anything. What it does
//   is recorded in History as an agent ('agent' actor), under its person's name, so its person can't approve its
//   requests either: another person does.
// A token is made and revoked only from a signed-in console (never with a token), is shown once, kept hashed, and is
// refused from a browser (an Origin header): it belongs in a script or an agent's settings, not in a web page.

import { randomBytes } from 'node:crypto';
import { all, HttpError, one, type Db } from './db.ts';
import { sha256 } from './auth.ts';
import { audit } from './journal.ts';
import type { Actor } from './layers.ts';
import type { Person } from './access.ts';
import { AGENT_ROLES, tokenRoles, type Role } from './policy.ts';

// the roles a token may have are in policy.ts, which the console shares
export { tokenRoles };
export const TOKEN_PREFIX = 'cfp_';
const MAX_DAYS = 366;
const LAST_USED_EVERY_MS = 60_000;

export type TokenInfo = {
  id: number; prefix: string; name: string; role: Role; agent: boolean; person: string;
  createdAt: string; expiresAt: string; lastUsedAt: string | null; revokedAt: string | null;
};
/** Who a token's request is: its person with the token's role (never above theirs), and the token's name. */
export type TokenPerson = Person & { token: { id: number; name: string; agent: boolean } };

/** A token's role today: its own, unless its person's role went down since (then theirs, or Editor at most). */
function effectiveRole(tokenRole: Role, personRole: Role): Role {
  if (tokenRole === personRole) return tokenRole;
  if (personRole === 'viewer') return 'viewer';
  if (tokenRole === 'viewer' || tokenRole === 'editor') return tokenRole;
  return AGENT_ROLES.includes(personRole) ? personRole : 'editor';
}

const SELECT = `select t.id::int as id, t.token_prefix as prefix, t.name, t.role, t.agent, u.key as person,
    t.created_at as "createdAt", t.expires_at as "expiresAt", t.last_used_at as "lastUsedAt", t.revoked_at as "revokedAt"
  from access_token t join app_user u on u.id = t.person_id`;

export function createTokens(db: Db) {
  const lastUsed = new Map<number, number>();
  return {
    /** A person's tokens (an admin: everyone's, with `all`), newest first. */
    list(p: Person, o: { all?: boolean } = {}): Promise<TokenInfo[]> {
      return o.all && p.role === 'admin'
        ? all<TokenInfo>(db, `${SELECT} order by t.id desc`)
        : all<TokenInfo>(db, `${SELECT} where u.key = $1 order by t.id desc`, [p.key]);
    },

    /** Makes a token for the person asking: its raw value is in the answer, once. */
    async create(p: Person, input: { name?: unknown; role?: unknown; agent?: unknown; days?: unknown }, actor: Actor) {
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (!name || name.length > 80) throw new HttpError(422, 'name the token (up to 80 characters), e.g. "CI" or "Claude in my editor"');
      const agent = input.agent === true;
      const roles = tokenRoles(p, agent);
      const role = (input.role ?? roles[roles.length - 1]) as Role;
      if (!roles.includes(role)) {
        throw new HttpError(422, agent ? 'an agent’s token is Viewer or Editor: an agent never approves or manages'
          : `a token’s role is ${roles.join(', ')}: never above your own`);
      }
      const days = input.days === undefined ? 90 : Number(input.days);
      if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw new HttpError(422, `days: a whole number from 1 to ${MAX_DAYS}`);
      const secret = randomBytes(24).toString('base64url');
      const raw = `${TOKEN_PREFIX}${secret}`;
      const prefix = `${TOKEN_PREFIX}${secret.slice(0, 6)}`;
      return db.transaction(async (tx) => {
        const row = await one<{ id: number }>(tx, `insert into access_token (token_hash, token_prefix, person_id, name, role, agent, expires_at)
          select $1, $2, u.id, $3, $4, $5, now() + make_interval(days => $6) from app_user u where u.key = $7 returning id::int as id`,
          [sha256(raw), prefix, name, role, agent, days, p.key]);
        if (!row) throw new HttpError(404, 'person not found');
        await audit(tx, actor, { kind: 'token.create', after: { id: row.id, prefix, name, role, agent, days } });
        return { token: raw, ...(await one<TokenInfo>(tx, `${SELECT} where t.id = $1`, [row.id]))! };
      });
    },

    /** Revokes one of the person's tokens (an admin: anyone's). At once, on every server: tokens aren't cached. */
    async revoke(p: Person, id: number, actor: Actor) {
      return db.transaction(async (tx) => {
        const t = await one<TokenInfo>(tx, `${SELECT} where t.id = $1 for update of t`, [id]);
        if (!t || (t.person !== p.key && p.role !== 'admin')) throw new HttpError(404, 'token not found');
        if (t.revokedAt) return t;
        await tx.query(`update access_token set revoked_at = now() where id = $1`, [id]);
        await audit(tx, actor, { kind: 'token.revoke', before: { id, prefix: t.prefix, name: t.name, person: t.person } });
        return (await one<TokenInfo>(tx, `${SELECT} where t.id = $1`, [id]))!;
      });
    },

    /** The person a raw token stands for, or null when it isn't one that works (unknown, expired, revoked, removed). */
    async resolve(raw: string): Promise<TokenPerson | null> {
      if (!raw.startsWith(TOKEN_PREFIX)) return null;
      const row = await one<{ id: number; name: string; role: Role; agent: boolean; key: string; pname: string; prole: Role; removed: boolean }>(db,
        `select t.id::int as id, t.name, t.role, t.agent, u.key, u.name as pname, u.role as prole, u.removed_at is not null as removed
          from access_token t join app_user u on u.id = t.person_id
          where t.token_hash = $1 and t.revoked_at is null and t.expires_at > now()`, [sha256(raw)]);
      if (!row || row.removed) return null;
      const now = Date.now();
      if (now - (lastUsed.get(row.id) ?? 0) > LAST_USED_EVERY_MS) {
        lastUsed.set(row.id, now);
        db.query(`update access_token set last_used_at = now() where id = $1`, [row.id]).catch(() => {});
      }
      return { key: row.key, name: row.pname, role: effectiveRole(row.role, row.prole), removed: false, token: { id: row.id, name: row.name, agent: row.agent } };
    },
  };
}
export type Tokens = ReturnType<typeof createTokens>;
