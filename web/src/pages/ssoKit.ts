// What Settings → Single sign-on (sso.tsx) shares besides its components: a connection as the server lists it
// (server/sso.ts), the addresses the identity provider's admin enters, the sign-in rules (server/access.ts), and group
// roles as an admin types them. Apart from sso.tsx so an edit to its components swaps in place in `pnpm dev`.
import { isRole, ROLES, roleInfo, type Role } from '../../../server/policy.ts';

export type ServiceProvider = { oidcRedirectUri: string; samlAcsUrl: string; samlEntityId: string; samlMetadataUrl: string };
export type GroupRoles = { claim: string; roles: Record<string, string> };
export type Connection = {
  id: string; type: 'oidc' | 'saml'; issuer: string; domains: string[]; requireSso: boolean;
  /** when someone last signed in with it: null until it has worked once (then it can be required) */
  lastSignInAt: string | null;
  groupRoles: GroupRoles | null;
  clientId?: string; entryPoint?: string; entityId?: string; serviceProvider: ServiceProvider;
};
export type SsoState = { available: boolean; base: string; connections: Connection[] };
export type SignInRules = { breakGlassAdmin: string | null; adminsNeedTwoFactor: boolean; joinRole: string; updatedAt: string | null; updatedBy: string | null };
export const RULES_PATH = '/sign-in-rules';

/** The roles people may join with without an invite: any but an admin's (server/access.ts JOIN_ROLES). */
export const JOIN_ROLES: Role[] = ROLES.filter((r) => !roleInfo(r).changesSettings);

/** The addresses the identity provider's admin enters on their side, for a connection id (server/sso.ts serviceProvider). */
export const serviceProvider = (base: string, id: string): ServiceProvider => {
  const auth = `${base.replace(/\/+$/, '')}/api/auth`;
  return {
    oidcRedirectUri: `${auth}/sso/callback/${id}`, samlAcsUrl: `${auth}/sso/saml2/sp/acs/${id}`,
    samlEntityId: `${auth}/sso/saml2/sp/metadata?providerId=${id}`, samlMetadataUrl: `${auth}/sso/saml2/sp/metadata?providerId=${id}`,
  };
};

/** Group roles as text: one group per line, "flag-admins = admin". */
export const groupLines = (g: GroupRoles | null) => (g ? Object.entries(g.roles).map(([group, role]) => `${group} = ${role}`).join('\n') : '');

/** The lines typed, read: each group and its role, or what's wrong with a line. Nothing typed: no group roles. */
export function readGroupLines(text: string): { roles: Record<string, Role> | null; problem: string | null } {
  const roles: Record<string, Role> = {};
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.lastIndexOf('=');
    const group = at > 0 ? line.slice(0, at).trim() : '';
    const role = at > 0 ? line.slice(at + 1).trim().toLowerCase().replace(/\s+/g, '') : '';
    const known = isRole(role) ? role : ROLES.find((r) => roleInfo(r).label.toLowerCase().replace(/\s+/g, '') === role);
    if (!group || !known) return { roles: null, problem: `Line ${i + 1}: write a group, then = and a role (${ROLES.join(', ')}), e.g. flag-admins = admin` };
    roles[group] = known;
  }
  return { roles: Object.keys(roles).length ? roles : null, problem: null };
}
