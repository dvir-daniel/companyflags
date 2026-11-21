// Single sign-on: people sign in with the company's identity provider (Okta, Entra ID, Google Workspace, JumpCloud…)
// over OIDC or SAML, through the sign-in library's SSO plugin (accounts.ts). An admin adds a connection in Settings for the
// company's email domains, and can require single sign-on there. Who a connection lets in is the access module's
// rule (access.ts): only people at its domains join, with the join role or the role an admin gave them, and where single
// sign-on is required nobody but the break-glass admin uses a password. Leaving the company (being removed from the
// identity provider) then ends access to the console within FF_SSO_SESSION_HOURS (12 by default): each session there
// lasts that long at most, and the next sign-in asks the identity provider again. Access tokens aren't sessions: they
// last until they expire or an admin removes the person (access.ts remove).
//
// A connection can be edited (its domains, its identity provider's details, its group roles). It can be required only
// once someone has signed in with it (`lastSignInAt`: the console's Test sign-in), so a connection that doesn't work
// can't lock people out. Changing the identity provider's details starts that over: the test sign-in is forgotten, and
// a requirement is turned off until someone signs in with it again. Group roles: an OIDC claim or a SAML attribute
// (e.g. "groups") lists the person's groups at the identity provider, and each group named gives a role; they get the
// highest, each time they sign in with it, and the join role when none of their groups is named. A sign-in without the
// claim at all leaves their role as it is (a wrong claim name demotes nobody), and so does one for the break-glass
// admin or the last admin (access.ts groupRole).
//
// An OIDC identity provider's token, keys (JWKS) and user info addresses come from its settings document. They must be
// https in production and not on this machine or a private network unless their origin is trusted, and the sign-in
// reaches them only through the same guarded lookup as the settings (publicFetch.ts, accounts.ts).
//
// The SSO plugin's own endpoints for managing connections are switched off (any signed-in person could use them);
// `singleSignOn` is behind the console's admin check instead. What it needs from outside comes in when the app starts
// (index.ts): the SSO plugin that keeps the connections, and `discover`, which reads an OIDC identity provider's
// settings (over the network in production; tests hand it the documents).

import type { lookup as dnsLookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { allowedOriginsFrom } from './publicFetch.ts';
import { HttpError, one, type Db, type Queryable } from './db.ts';
import type { Access, Vouching } from './access.ts';
import type { Actor } from './layers.ts';
import * as journal from './journal.ts';
import { NotPublicError, publicRead } from './publicFetch.ts';
import { isRole, ROLES, type Role } from './policy.ts';

/** Reads the JSON document at an address: an OIDC identity provider's discovery document. */
export type Discover = (url: string) => Promise<unknown>;

/** In production: fetched, by the admin's request here, not by the sign-in library (which only fetches from origins it is
 *  configured to trust). The address must be public (not this machine, a private network or a cloud metadata
 *  address) unless its origin is trusted (`trustedOrigins`: FF_TRUSTED_ORIGINS), so adding a connection
 *  can't be used to look around the network. It is checked by the connection's own lookup (publicFetch.ts
 *  publicRead), so the name can't resolve to a public address for the check and a private one for the connection.
 *  Redirects aren't followed. `lookup` and `timeoutMs` are for tests. */
export const discoverOverHttp = (trustedOrigins: readonly string[] = [], o: { lookup?: typeof dnsLookup; timeoutMs?: number } = {}): Discover => async (url) => {
  const origin = new URL(url).origin;
  let res: { status: number; body: string };
  try {
    res = await publicRead(url, { allowedOrigins: trustedOrigins, lookup: o.lookup, timeoutMs: o.timeoutMs ?? 8000, headers: { accept: 'application/json' } });
  } catch (e) {
    if (e instanceof NotPublicError) {
      throw new HttpError(422, `the identity provider at ${origin} isn’t on the public internet: if it is on your private network, `
        + 'add its origin to FF_TRUSTED_ORIGINS');
    }
    const code = (e as { code?: unknown }).code;
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') throw new HttpError(422, `couldn’t find the identity provider at ${origin}: check the issuer address`);
    throw e;
  }
  if (res.status < 200 || res.status > 299) throw new Error(`HTTP ${res.status}`);
  return JSON.parse(res.body);
};

/** The SSO plugin that keeps connections and signs people in with them (accounts.ts). */
export type SsoPlugin = { registerConnection: (body: Record<string, unknown>, headers: Headers) => Promise<void> };

export type SsoOptions = {
  access: Pick<Access, 'connectionRemoved' | 'ssoNowRequired'>;
  /** none while the tests' header signs people in: then connections can't be added */
  plugin?: SsoPlugin;
  discover: Discover;
  /** the console's address when it is configured (FF_PUBLIC_URL); otherwise each request's own */
  baseURL?: string;
  /** issuers, and the addresses their settings give, must be https */
  production?: boolean;
  /** origins on a private network an admin trusts (FF_TRUSTED_ORIGINS): an identity provider may be there */
  trustedOrigins?: readonly string[];
};

/** Single sign-on connections, for the console's API (api.ts). */
export function singleSignOn(db: Db, o: SsoOptions) {
  return {
    /** connections can be added (the sign-in is the accounts one) */
    available: !!o.plugin,
    /** the console's address, for what the identity provider's admin enters on their side (serviceProvider) */
    base: (requestUrl: string) => o.baseURL ?? new URL(requestUrl).origin,
    list: () => listConnections(db),
    /** `headers` are the admin's own request's (the plugin records who added it); `base` is the console's address */
    add: (input: NewConnection, actor: Actor, request: { headers: Headers; base: string }) => addConnection(db, o, request, input, actor),
    /** its settings, or requiring single sign-on (the fields left out stay as they are) */
    update: (id: string, input: NewConnection, actor: Actor) => updateConnection(db, o, id, input, actor),
    remove: (id: string, actor: Actor) => removeConnection(db, o.access, id, actor),
  };
}
export type SingleSignOn = ReturnType<typeof singleSignOn>;

/** The roles a connection's groups give: the claim (OIDC) or attribute (SAML) that lists them, and each group's role. */
export type GroupRoles = { claim: string; roles: Record<string, Role> };

export type Connection = {
  id: string;
  type: 'oidc' | 'saml';
  issuer: string;
  domains: string[];
  requireSso: boolean;
  /** when someone last signed in with it: null until it has worked once (then it can be required) */
  lastSignInAt: string | null;
  groupRoles: GroupRoles | null;
  clientId?: string;                 // OIDC
  entryPoint?: string;               // SAML: where people are sent to sign in
  entityId?: string;                 // SAML: the identity provider's entity ID
};

export type NewConnection = {
  id?: unknown; type?: unknown; domains?: unknown; requireSso?: unknown; groupRoles?: unknown;
  // OIDC
  issuer?: unknown; clientId?: unknown; clientSecret?: unknown;
  // SAML: the identity provider's metadata XML, or its sign-in URL, entity ID and signing certificate
  metadata?: unknown; entryPoint?: unknown; entityId?: unknown; certificate?: unknown;
};

/** What the identity provider's admin needs to set up the other side, for a connection id. `base` is the console's address. */
export function serviceProvider(base: string, id: string) {
  const auth = `${base.replace(/\/+$/, '')}/api/auth`;
  return {
    oidcRedirectUri: `${auth}/sso/callback/${id}`,
    samlAcsUrl: `${auth}/sso/saml2/sp/acs/${id}`,
    samlEntityId: `${auth}/sso/saml2/sp/metadata?providerId=${id}`,
    samlMetadataUrl: `${auth}/sso/saml2/sp/metadata?providerId=${id}`,
  };
}

const ID = /^[a-z][a-z0-9-]{1,39}$/;
const DOMAIN = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

type Row = {
  provider_id: string; issuer: string; domain: string; require_sso: boolean; oidc_config: string | null; saml_config: string | null;
  last_sign_in_at: string | null; group_roles: GroupRoles | string | null;
};
const ROW = `select provider_id, issuer, domain, require_sso, oidc_config, saml_config, last_sign_in_at, group_roles from sso_provider`;
const json = <T,>(v: T | string | null): T | null => (typeof v === 'string' ? JSON.parse(v) : v);
const domainsOf = (domain: string) => domain.split(',').map((d) => d.trim()).filter(Boolean);

function connectionOf(r: Row): Connection {
  const oidc = r.oidc_config ? JSON.parse(r.oidc_config) : null;
  const saml = r.saml_config ? JSON.parse(r.saml_config) : null;
  return {
    id: r.provider_id, type: oidc ? 'oidc' : 'saml', issuer: r.issuer, domains: domainsOf(r.domain), requireSso: r.require_sso,
    lastSignInAt: r.last_sign_in_at ? new Date(r.last_sign_in_at).toISOString() : null, groupRoles: json(r.group_roles),
    ...(oidc ? { clientId: oidc.clientId } : { entryPoint: saml?.entryPoint, entityId: saml?.idpMetadata?.entityID }),
  };
}

async function listConnections(db: Queryable): Promise<Connection[]> {
  return (await db.query<Row>(`${ROW} order by provider_id`)).rows.map(connectionOf);
}

/** Someone signed in with this connection (accounts.ts): it works, so it can be required. */
export async function connectionUsed(q: Queryable, id: string) {
  await q.query(`update sso_provider set last_sign_in_at = now() where provider_id = $1`, [id]);
}

/** The role this person's groups give, with this connection's group roles (the highest of them), or null to leave
 *  their role as it is: the connection has none, or the sign-in didn't have the claim at all (a claim named wrong, or
 *  an identity provider that stopped sending it, must not demote anyone). `groups`: what the claim or attribute said
 *  (one group, a list, or a comma-separated list); there but naming none of the groups: the join role. */
export function roleFromGroups(g: GroupRoles | null, groups: unknown, fallback: Role): Role | null {
  if (!g || groups === undefined || groups === null) return null;
  const list = (Array.isArray(groups) ? groups : typeof groups === 'string' ? groups.split(',') : []).map((x) => String(x).trim()).filter(Boolean);
  const given = list.map((x) => g.roles[x]).filter((r): r is Role => isRole(r));
  return given.length ? given.reduce((a, b) => (ROLES.indexOf(b) > ROLES.indexOf(a) ? b : a)) : fallback;
}

/** A connection's group roles, for the sign-in (accounts.ts). */
export async function groupRolesOf(q: Queryable, id: string): Promise<GroupRoles | null> {
  return json((await one<{ g: GroupRoles | string | null }>(q, `select group_roles as g from sso_provider where provider_id = $1`, [id]))?.g ?? null);
}

/** Group roles as an admin gives them: the claim, and up to 100 groups each with a role. null: none. */
function readGroupRoles(v: unknown): GroupRoles | null {
  if (v === null) return null;
  const g = v as { claim?: unknown; roles?: unknown };
  const claim = str(g?.claim);
  if (!claim || claim.length > 200) throw new HttpError(422, 'group roles: the claim or attribute that lists the groups, e.g. groups');
  if (!g.roles || typeof g.roles !== 'object' || Array.isArray(g.roles)) throw new HttpError(422, 'group roles: each group with its role, e.g. { "flags-admins": "admin" }');
  const entries = Object.entries(g.roles as Record<string, unknown>).map(([k, r]) => [k.trim(), r] as const).filter(([k]) => k);
  if (!entries.length || entries.length > 100) throw new HttpError(422, 'group roles: from 1 to 100 groups');
  const bad = entries.find(([k, r]) => k.length > 200 || !isRole(r));
  if (bad) throw new HttpError(422, `group roles: "${bad[0]}" needs a role, one of ${ROLES.join(', ')}`);
  return { claim, roles: Object.fromEntries(entries) as Record<string, Role> };
}

/** The mapping that has the SSO plugin read the groups claim or attribute (as `groups`), or none. */
const mappingFor = (g: GroupRoles | null) => (g ? { extraFields: { groups: g.claim } } : undefined);

function readDomains(input: unknown) {
  const domains = (Array.isArray(input) ? input : str(input).split(','))
    .map((d) => str(d).toLowerCase().replace(/^@/, '')).filter(Boolean);
  if (!domains.length) throw new HttpError(422, 'domains: the email domains it signs in, e.g. example.com');
  const bad = domains.find((d) => !DOMAIN.test(d));
  if (bad) throw new HttpError(422, `domains: "${bad}" isn’t a domain`);
  return [...new Set(domains)];
}

async function domainsFree(db: Queryable, domains: string[], except: string | null) {
  for (const c of await listConnections(db)) {
    if (c.id === except) continue;
    const shared = domains.find((d) => c.domains.includes(d));
    if (shared) throw new HttpError(409, `${shared} already signs in with the connection "${c.id}"`);
  }
}

/** An OIDC connection's settings, read from its identity provider. */
async function oidcConfigFor(o: SsoOptions, i: { issuer: string; clientId: string; clientSecret: string }, groups: GroupRoles | null) {
  const issuer = i.issuer.replace(/\/+$/, '');
  if (!/^https?:\/\//.test(issuer)) throw new HttpError(422, 'issuer: the identity provider’s address, e.g. https://example.okta.com');
  if (o.production && !issuer.startsWith('https://')) throw new HttpError(422, 'issuer: must be an https address');
  if (!i.clientId || !i.clientSecret) throw new HttpError(422, 'client ID and client secret: from the app you made for CompanyFlags in the identity provider');
  const doc = await discover(o.discover, issuer);
  for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'userinfo_endpoint'] as const) {
    const problem = endpointProblem(k, doc[k], o);
    if (problem) throw new HttpError(422, `the identity provider’s settings at ${issuer}/.well-known/openid-configuration give a ${problem}`);
  }
  return {
    issuer: doc.issuer,
    config: {
      clientId: i.clientId, clientSecret: i.clientSecret, skipDiscovery: true, pkce: true, scopes: ['openid', 'email', 'profile'],
      discoveryEndpoint: `${issuer}/.well-known/openid-configuration`,
      authorizationEndpoint: doc.authorization_endpoint, tokenEndpoint: doc.token_endpoint, jwksEndpoint: doc.jwks_uri,
      ...(doc.userinfo_endpoint ? { userInfoEndpoint: doc.userinfo_endpoint } : {}),
      ...(doc.token_endpoint_auth_methods_supported?.includes('client_secret_basic') ? {} : { tokenEndpointAuthentication: 'client_secret_post' }),
      ...(groups ? { mapping: mappingFor(groups) } : {}),
    },
  };
}

/** Why an address an OIDC identity provider's settings give can't be used, or null. It must be http or https (https in
 *  production), and not this machine or a private network unless its origin is trusted. Names are checked when the
 *  sign-in connects to them (accounts.ts, publicFetch.ts): here only what is written. What it is isn't repeated. */
function endpointProblem(name: string, raw: unknown, o: Pick<SsoOptions, 'production' | 'trustedOrigins'>): string | null {
  if (raw === undefined && name === 'userinfo_endpoint') return null;
  let u: URL;
  try { u = new URL(String(raw)); } catch { return `${name} that isn’t an address`; }
  if (allowedOriginsFrom((o.trustedOrigins ?? []).join(',')).includes(u.origin)) return null;
  if (u.protocol !== 'https:' && (u.protocol !== 'http:' || o.production)) return `${name} that isn’t an https address`;
  if (u.username || u.password) return `${name} with a user or password in it`;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || (isIP(host) && !isPublicAddress(host))) {
    return `${name} that isn’t on the public internet: if it is on your private network, add its origin to FF_TRUSTED_ORIGINS`;
  }
  return null;
}

/** A SAML connection's settings, from the identity provider's metadata or its details. */
function samlConfigFor(i: { metadata: string; entryPoint: string; entityId: string; certificate: string }, sp: ReturnType<typeof serviceProvider>, groups: GroupRoles | null) {
  const fromXml = i.metadata ? readIdpMetadata(i.metadata) : null;
  const entryPoint = i.entryPoint || fromXml?.entryPoint || '';
  const entityId = i.entityId || fromXml?.entityId || '';
  if (!/^https?:\/\//.test(entryPoint)) throw new HttpError(422, 'the identity provider’s metadata XML, or its sign-in (SSO) URL');
  if (!entityId) throw new HttpError(422, 'the identity provider’s metadata XML, or its entity ID (issuer)');
  if (!i.metadata && !i.certificate) throw new HttpError(422, 'the identity provider’s metadata XML, or its signing certificate');
  return {
    issuer: /^https?:\/\//.test(entityId) ? entityId : entryPoint,
    config: {
      entryPoint,
      ...(i.certificate ? { cert: i.certificate } : {}),
      audience: sp.samlEntityId,
      wantAssertionsSigned: true,
      idpMetadata: i.metadata ? { metadata: i.metadata, entityID: entityId } : { entityID: entityId },
      spMetadata: { entityID: sp.samlEntityId },
      identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      ...(groups ? { mapping: mappingFor(groups) } : {}),
    },
  };
}

/** The connections that vouch for the people at their domains (an admin added them): for the access module's rules. */
export async function vouchingConnections(q: Queryable): Promise<Vouching[]> {
  const rows = await q.query<{ id: string; domain: string; requireSso: boolean }>(
    `select provider_id as id, domain, require_sso as "requireSso" from sso_provider where domain_verified order by provider_id`);
  return rows.rows.map((r) => ({ id: r.id, requireSso: r.requireSso, domains: r.domain.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean) }));
}

/** Adds a connection. `base` is the console's address, for the SAML service provider's entity ID. */
async function addConnection(db: Db, o: SsoOptions, { headers, base }: { headers: Headers; base: string }, input: NewConnection, actor: Actor) {
  if (!o.plugin) throw new HttpError(409, 'single sign-on needs sign-in with accounts');
  const id = str(input.id).toLowerCase();
  if (!ID.test(id)) throw new HttpError(422, 'id: lowercase letters, digits and dashes, starting with a letter, e.g. okta');
  const domains = readDomains(input.domains);
  if (await one(db, `select 1 from sso_provider where provider_id = $1`, [id])) throw new HttpError(409, `there is already a connection "${id}"`, {}, 'already_exists');
  await domainsFree(db, domains, null);
  if (input.requireSso === true) throw new HttpError(409, 'add the connection first, and sign in with it once (Test sign-in): then require it');
  const groups = input.groupRoles === undefined ? null : readGroupRoles(input.groupRoles);
  const sp = serviceProvider(base, id);

  let body: Record<string, unknown>;
  if (input.type === 'oidc') {
    const { issuer, config } = await oidcConfigFor(o, { issuer: str(input.issuer), clientId: str(input.clientId), clientSecret: str(input.clientSecret) }, groups);
    body = { providerId: id, issuer, domain: domains.join(','), oidcConfig: config };
  } else if (input.type === 'saml') {
    const { issuer, config } = samlConfigFor({ metadata: str(input.metadata), entryPoint: str(input.entryPoint), entityId: str(input.entityId), certificate: str(input.certificate) }, sp, groups);
    body = { providerId: id, issuer, domain: domains.join(','), samlConfig: config };
  } else {
    throw new HttpError(422, 'type: "oidc" or "saml"');
  }

  await o.plugin.registerConnection(body, headers);
  await db.query(`update sso_provider set domain_verified = true, require_sso = false, group_roles = $2::jsonb where provider_id = $1`,
    [id, groups ? JSON.stringify(groups) : null]);
  await audit(db, actor, 'sso.add', { after: { id, type: input.type, domains, requireSso: false, groupRoles: groups } });
  return (await listConnections(db)).find((c) => c.id === id)!;
}

/** Changes a connection: what the request names, the rest as it is. A new client secret, certificate or metadata
 *  replaces the old one; left out (or empty), the old one stays. Its protocol and id stay: for another, add a new
 *  connection. Requiring single sign-on needs a sign-in with it first (`lastSignInAt`); required from now, everyone at
 *  its domains but the break-glass admin is signed out, and signs in again with single sign-on (access.ts
 *  ssoNowRequired). A domain added to a connection that is required signs out the people at that domain only.
 *  Any change to the identity provider's details (OIDC: issuer, client ID or secret, and the addresses its settings
 *  give; SAML: sign-in URL, entity ID, certificate or metadata) forgets the test sign-in and turns the requirement off,
 *  until someone signs in with it again: a typo there must not lock everyone out. */
async function updateConnection(db: Db, o: SsoOptions, id: string, input: NewConnection, actor: Actor) {
  const cur = await one<Row>(db, `${ROW} where provider_id = $1`, [id]);
  if (!cur) throw new HttpError(404, `no connection "${id}"`);
  const before = connectionOf(cur);
  if (input.type !== undefined && input.type !== before.type) throw new HttpError(422, `type: this connection is ${before.type.toUpperCase()}: add a new connection for another protocol`);
  const domains = input.domains === undefined ? before.domains : readDomains(input.domains);
  if (input.domains !== undefined) await domainsFree(db, domains, id);
  const groups = input.groupRoles === undefined ? before.groupRoles : readGroupRoles(input.groupRoles);
  if (input.requireSso !== undefined && typeof input.requireSso !== 'boolean') throw new HttpError(422, 'requireSso: true or false');
  const requireSso = input.requireSso === undefined ? before.requireSso : input.requireSso;
  if (requireSso && !before.requireSso && !before.lastSignInAt) {
    throw new HttpError(409, `nobody has signed in with ${id} yet: use Test sign-in first, so you know it works before passwords stop`);
  }

  let issuer = cur.issuer;
  let oidc = cur.oidc_config;
  let saml = cur.saml_config;
  const touches = (keys: (keyof NewConnection)[]) => keys.some((k) => input[k] !== undefined && str(input[k]) !== '');
  if (before.type === 'oidc') {
    const was = JSON.parse(cur.oidc_config!);
    if (touches(['issuer', 'clientId', 'clientSecret'])) {
      const next = await oidcConfigFor(o, {
        issuer: str(input.issuer) || was.issuer || cur.issuer, clientId: str(input.clientId) || was.clientId, clientSecret: str(input.clientSecret) || was.clientSecret,
      }, groups);
      issuer = next.issuer;
      const { skipDiscovery: _, ...config } = next.config;
      oidc = JSON.stringify({ ...config, issuer, tokenEndpointAuthentication: config.tokenEndpointAuthentication ?? 'client_secret_basic', overrideUserInfo: false });
    } else {
      const { mapping: _, ...rest } = was;
      oidc = JSON.stringify({ ...rest, ...(groups ? { mapping: mappingFor(groups) } : {}) });
    }
  } else {
    const was = JSON.parse(cur.saml_config!);
    if (touches(['metadata', 'entryPoint', 'entityId', 'certificate'])) {
      const metadata = str(input.metadata) || (str(input.entryPoint) || str(input.entityId) ? '' : was.idpMetadata?.metadata ?? '');
      const next = samlConfigFor({
        metadata, entryPoint: str(input.entryPoint) || (metadata ? '' : was.entryPoint), entityId: str(input.entityId) || (metadata ? '' : was.idpMetadata?.entityID ?? ''),
        certificate: str(input.certificate) || was.cert || '',
      }, { samlEntityId: was.audience } as ReturnType<typeof serviceProvider>, groups);
      issuer = next.issuer;
      saml = JSON.stringify({ ...next.config, issuer, spMetadata: was.spMetadata, audience: was.audience });
    } else {
      const { mapping: _, ...rest } = was;
      saml = JSON.stringify({ ...rest, ...(groups ? { mapping: mappingFor(groups) } : {}) });
    }
  }

  // the identity provider's details changed: a test sign-in again before single sign-on can be required (again)
  const idpChanged = issuer !== cur.issuer || idpDetails(before.type, oidc, saml) !== idpDetails(before.type, cur.oidc_config, cur.saml_config);
  if (idpChanged && input.requireSso === true) {
    throw new HttpError(409, `the identity provider’s details changed: save them, use Test sign-in with ${id}, then require it`);
  }
  const required = requireSso && !idpChanged;
  await db.query(`update sso_provider set issuer = $2, domain = $3, oidc_config = $4, saml_config = $5, require_sso = $6, group_roles = $7::jsonb,
    last_sign_in_at = case when $8::boolean then null else last_sign_in_at end
    where provider_id = $1`, [id, issuer, domains.join(','), oidc, saml, required, groups ? JSON.stringify(groups) : null, idpChanged]);
  const after = connectionOf((await one<Row>(db, `${ROW} where provider_id = $1`, [id]))!);
  // required from now: everyone at its domains signs in again with it; already required: only those at new domains
  if (required) {
    const signOut = before.requireSso ? domains.filter((d) => !before.domains.includes(d)) : domains;
    if (signOut.length) await o.access.ssoNowRequired(db, signOut);
  }
  const said = (c: Connection) => ({ id: c.id, issuer: c.issuer, domains: c.domains, requireSso: c.requireSso, groupRoles: c.groupRoles,
    ...(c.clientId ? { clientId: c.clientId } : {}), ...(c.entryPoint ? { entryPoint: c.entryPoint } : {}) });
  const secret = input.clientSecret !== undefined && str(input.clientSecret) !== '' ? { secretReplaced: true } : {};
  await audit(db, actor, 'sso.update', { before: said(before), after: { ...said(after), ...secret } });
  return after;
}

/** What a connection's identity provider is, as text to compare: everything but the group roles' mapping. */
function idpDetails(type: Connection['type'], oidc: string | null, saml: string | null): string {
  const c = JSON.parse((type === 'oidc' ? oidc : saml) ?? '{}');
  const pick = type === 'oidc'
    ? [c.issuer, c.clientId, c.clientSecret, c.authorizationEndpoint, c.tokenEndpoint, c.jwksEndpoint, c.userInfoEndpoint, c.discoveryEndpoint]
    : [c.entryPoint, c.cert, c.idpMetadata?.metadata, c.idpMetadata?.entityID];
  return JSON.stringify(pick.map((v) => v ?? null));
}

/** Removes a connection: nobody signs in with it any more, and everyone who signed in with it is signed out
 *  (the identity provider may be the reason it is removed). People who used it keep their role, and can be
 *  invited to make a password account. */
async function removeConnection(db: Db, access: SsoOptions['access'], id: string, actor: Actor) {
  return db.transaction(async (tx) => {
    const r = await tx.query(`delete from sso_provider where provider_id = $1`, [id]);
    if (!r.affected) throw new HttpError(404, `no connection "${id}"`);
    await access.connectionRemoved(tx, id);                // the sign-ins made with it, and their sessions
    await audit(tx, actor, 'sso.remove', { before: { id } });
    return { id, removed: true };
  });
}

/** Reads an OIDC provider's discovery document, and checks it is the issuer's. What goes wrong is said without the
 *  response's status, the network error or anything the document says (the network adapter's refusals of private
 *  addresses are said as they are), so this can't be used to look around the network. */
async function discover(read: Discover, issuer: string) {
  const url = `${issuer}/.well-known/openid-configuration`;
  let doc: any;
  try {
    doc = await read(url);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(422, `couldn’t read the identity provider’s settings at ${url}: check the issuer address`);
  }
  for (const k of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    if (typeof doc?.[k] !== 'string') throw new HttpError(422, `the identity provider’s settings at ${url} have no ${k}`);
  }
  if (doc.issuer.replace(/\/+$/, '') !== issuer) throw new HttpError(422, `the identity provider’s settings at ${url} are for another issuer: check the issuer address`);
  return doc as { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; userinfo_endpoint?: string; token_endpoint_auth_methods_supported?: string[] };
}

// Addresses that aren't on the public internet (RFC 6890): this machine, private networks, link-local (cloud
// metadata at 169.254.169.254), carrier-grade NAT, documentation, multicast and reserved ranges. In IPv6, ::/96 is
// the unspecified address, this machine, and IPv4 written the old way (::10.0.0.1).
const NOT_PUBLIC = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) {
  NOT_PUBLIC.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [['::', 96], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) {
  NOT_PUBLIC.addSubnet(net, bits, 'ipv6');
}

/** Whether an IP address is on the public internet. An IPv4 address written as IPv6 (::ffff:10.0.0.1) counts as itself. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !NOT_PUBLIC.check(address, 'ipv4');
  if (family !== 6) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return isPublicAddress(mapped);
  return !NOT_PUBLIC.check(address, 'ipv6');
}

/** The entity ID and sign-in URL in a SAML identity provider's metadata (the sign-in library reads the certificates itself). */
export function readIdpMetadata(xml: string): { entityId: string; entryPoint: string } {
  const entityId = /<(?:\w+:)?EntityDescriptor\b[^>]*\bentityID="([^"]+)"/.exec(xml)?.[1] ?? '';
  const services = [...xml.matchAll(/<(?:\w+:)?SingleSignOnService\b[^>]*>/g)].map((m) => m[0]);
  const pick = services.find((s) => s.includes('HTTP-Redirect')) ?? services.find((s) => s.includes('HTTP-POST')) ?? services[0] ?? '';
  const entryPoint = /\bLocation="([^"]+)"/.exec(pick)?.[1] ?? '';
  if (!entityId || !entryPoint) throw new HttpError(422, 'metadata: this isn’t a SAML identity provider’s metadata (no entityID or SingleSignOnService)');
  return { entityId: entityId.replaceAll('&amp;', '&'), entryPoint: entryPoint.replaceAll('&amp;', '&') };
}

// single sign-on changes nothing that is served: history only, through the change journal
async function audit(q: { query: Db['query'] }, actor: Actor, kind: 'sso.add' | 'sso.update' | 'sso.remove', fields: { before?: unknown; after?: unknown }) {
  await journal.audit(q, actor, { kind, ...fields });
}
