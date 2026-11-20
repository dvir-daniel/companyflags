// What the Access tokens page (Tokens.tsx) shares: a token's row, its state, when it ends, and the roles a person may
// give one (policy.ts tokenRoles, the same answer the server gives). Apart from Tokens.tsx so an edit to its
// components swaps in place in `pnpm dev` (React Fast Refresh).
import { roleInfo, tokenRoles } from '../../../server/policy.ts';

export { tokenRoles };

/** A token as the server lists it (server/tokens.ts TokenInfo): never its value. */
export type TokenRow = {
  id: number; prefix: string; name: string; role: string; agent: boolean; person: string;
  createdAt: string; expiresAt: string; lastUsedAt: string | null; revokedAt: string | null;
};
export type TokenState = 'active' | 'expired' | 'revoked';

/** How long a new token works: 30, 90 (the default) or 365 days. */
export const EXPIRY_DAYS = [30, 90, 365] as const;
export const DEFAULT_DAYS = 90;

export const TOKEN_ABOUT = 'A token acts as you, with a role up to yours, for scripts, the CLI and MCP clients.';
export const AGENT_ABOUT = 'An agent’s changes show as an agent’s in History; where changes need approval, they’re requests someone else approves.';

export function tokenState(t: Pick<TokenRow, 'revokedAt' | 'expiresAt'>, now = Date.now()): TokenState {
  if (t.revokedAt) return 'revoked';
  return Date.parse(t.expiresAt) <= now ? 'expired' : 'active';
}

/** "in 89 days", "tomorrow", "today", or "expired". */
export function expiresText(iso: string, now = Date.now()): string {
  const days = Math.floor((Date.parse(iso) - now) / 86_400_000);
  if (Date.parse(iso) <= now) return 'expired';
  return days < 1 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
}

/** The roles to pick from for a new token, with their labels; the last one is the default (as on the server). */
export function roleChoices(myRole: string, agent: boolean): [string, string][] {
  return tokenRoles({ role: myRole }, agent).map((r) => [r, roleInfo(r).label]);
}

/** The role picked, or the default when it isn't allowed (after ticking "For an agent"). */
export function allowedRole(picked: string, myRole: string, agent: boolean): string {
  const roles = tokenRoles({ role: myRole }, agent);
  return (roles as string[]).includes(picked) ? picked : roles[roles.length - 1];
}
