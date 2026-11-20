// Single sign-on: people sign in with the company's identity provider (Okta, Entra ID, Google Workspace, JumpCloud…)
// over OIDC or SAML, through Better Auth's SSO plugin (betterAuth.ts). An admin adds a connection in Settings for the
// company's email domains, and can require single sign-on there. Who a connection lets in is the access module's
// rule (access.ts): people at its domains join as viewers, people an admin added keep their role, and where single
// sign-on is required nobody but an admin uses a password, so leaving the company (being removed from the identity
// provider) ends access.
//
// Better Auth's own endpoints for managing connections are switched off (any signed-in person could use them);
// `singleSignOn` is behind the console's admin check instead. What it needs from outside comes in when the app starts
// (index.ts): the SSO plugin that keeps the connections, and `discover`, which reads an OIDC identity provider's
// settings (over the network in production; tests hand it the documents).

import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { HttpError, one, type Db, type Queryable } from './db.ts';
import type { Access, Vouching } from './access.ts';
import type { Actor } from './layers.ts';
import * as journal from './journal.ts';

/** Reads the JSON document at an address: an OIDC identity provider's discovery document. */
export type Discover = (url: string) => Promise<unknown>;

/** In production: fetched, by the admin's request here, not by Better Auth (which only fetches from origins it is
 *  configured to trust). The address must be public (not this machine, a private network or a cloud metadata
 *  address) unless its origin is trusted (`trustedOrigins`: BETTER_AUTH_TRUSTED_ORIGINS), so adding a connection
 *  can't be used to look around the network. */
export const discoverOverHttp = (trustedOrigins: readonly string[] = []): Discover => async (url) => {
  await assertPublic(url, trustedOrigins);
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'error', headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

/** The SSO plugin that keeps connections and signs people in with them (betterAuth.ts). */
export type SsoPlugin = { registerConnection: (body: Record<string, unknown>, headers: Headers) => Promise<void> };

export type SsoOptions = {
  access: Pick<Access, 'connectionRemoved'>;
  /** none while the tests' header signs people in: then connections can't be added */
  plugin?: SsoPlugin;
  discover: Discover;
  /** the console's address when it is configured (BETTER_AUTH_URL); otherwise each request's own */
  baseURL?: string;
  /** issuers must be https */
  production?: boolean;
};

/** Single sign-on connections, for the console's API (api.ts). */
export function singleSignOn(db: Db, o: SsoOptions) {
  return {
    /** connections can be added (the sign-in is Better Auth) */
    available: !!o.plugin,
    /** the console's address, for what the identity provider's admin enters on their side (serviceProvider) */
    base: (requestUrl: string) => o.baseURL ?? new URL(requestUrl).origin,
    list: () => listConnections(db),
    /** `headers` are the admin's own request's (the plugin records who added it); `base` is the console's address */
    add: (input: NewConnection, actor: Actor, request: { headers: Headers; base: string }) => addConnection(db, o, request, input, actor),
    setRequireSso: (id: string, requireSso: boolean, actor: Actor) => setRequireSso(db, id, requireSso, actor),
    remove: (id: string, actor: Actor) => removeConnection(db, o.access, id, actor),
  };
}
export type SingleSignOn = ReturnType<typeof singleSignOn>;

export type Connection = {
  id: string;
  type: 'oidc' | 'saml';
  issuer: string;
  domains: string[];
  requireSso: boolean;
  clientId?: string;                 // OIDC
  entryPoint?: string;               // SAML: where people are sent to sign in
};

export type NewConnection = {
  id?: unknown; type?: unknown; domains?: unknown; requireSso?: unknown;
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

async function listConnections(db: Queryable): Promise<Connection[]> {
  const rows = await db.query<{ provider_id: string; issuer: string; domain: string; require_sso: boolean; oidc_config: string | null; saml_config: string | null }>(
    `select provider_id, issuer, domain, require_sso, oidc_config, saml_config from sso_provider order by provider_id`);
  return rows.rows.map((r) => {
    const oidc = r.oidc_config ? JSON.parse(r.oidc_config) : null;
    const saml = r.saml_config ? JSON.parse(r.saml_config) : null;
    return {
      id: r.provider_id, type: oidc ? 'oidc' : 'saml', issuer: r.issuer,
      domains: r.domain.split(',').map((d) => d.trim()).filter(Boolean), requireSso: r.require_sso,
      ...(oidc ? { clientId: oidc.clientId } : { entryPoint: saml?.entryPoint }),
    };
  });
}

/** The connections that vouch for the people at their domains (an admin added them): for the access module's rules. */
export async function vouchingConnections(q: Queryable): Promise<Vouching[]> {
  const rows = await q.query<{ id: string; domain: string; requireSso: boolean }>(
    `select provider_id as id, domain, require_sso as "requireSso" from sso_provider where domain_verified order by provider_id`);
  return rows.rows.map((r) => ({ id: r.id, requireSso: r.requireSso, domains: r.domain.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean) }));
}

/** Adds a connection. `base` is the console's address, for the SAML service provider's entity ID. */
async function addConnection(db: Db, o: SsoOptions, { headers, base }: { headers: Headers; base: string }, input: NewConnection, actor: Actor) {
  if (!o.plugin) throw new HttpError(409, 'single sign-on needs the Better Auth sign-in');
  const id = str(input.id).toLowerCase();
  if (!ID.test(id)) throw new HttpError(422, 'id: lowercase letters, digits and dashes, starting with a letter, e.g. okta');
  const domains = (Array.isArray(input.domains) ? input.domains : str(input.domains).split(','))
    .map((d) => str(d).toLowerCase().replace(/^@/, '')).filter(Boolean);
  if (!domains.length) throw new HttpError(422, 'domains: the email domains it signs in, e.g. example.com');
  const bad = domains.find((d) => !DOMAIN.test(d));
  if (bad) throw new HttpError(422, `domains: "${bad}" isn’t a domain`);
  if (await one(db, `select 1 from sso_provider where provider_id = $1`, [id])) throw new HttpError(409, `there is already a connection "${id}"`);
  for (const c of await listConnections(db)) {
    const shared = domains.find((d) => c.domains.includes(d));
    if (shared) throw new HttpError(409, `${shared} already signs in with the connection "${c.id}"`);
  }
  const sp = serviceProvider(base, id);

  let body: Record<string, unknown>;
  if (input.type === 'oidc') {
    const issuer = str(input.issuer).replace(/\/+$/, '');
    const clientId = str(input.clientId);
    const clientSecret = str(input.clientSecret);
    if (!/^https?:\/\//.test(issuer)) throw new HttpError(422, 'issuer: the identity provider’s address, e.g. https://example.okta.com');
    if (o.production && !issuer.startsWith('https://')) throw new HttpError(422, 'issuer: must be an https address');
    if (!clientId || !clientSecret) throw new HttpError(422, 'client ID and client secret: from the app you made for CompanyFlags in the identity provider');
    const doc = await discover(o.discover, issuer);
    body = {
      providerId: id, issuer: doc.issuer, domain: domains.join(','),
      oidcConfig: {
        clientId, clientSecret, skipDiscovery: true, pkce: true, scopes: ['openid', 'email', 'profile'],
        discoveryEndpoint: `${issuer}/.well-known/openid-configuration`,
        authorizationEndpoint: doc.authorization_endpoint, tokenEndpoint: doc.token_endpoint, jwksEndpoint: doc.jwks_uri,
        ...(doc.userinfo_endpoint ? { userInfoEndpoint: doc.userinfo_endpoint } : {}),
        ...(doc.token_endpoint_auth_methods_supported?.includes('client_secret_basic') ? {} : { tokenEndpointAuthentication: 'client_secret_post' }),
      },
    };
  } else if (input.type === 'saml') {
    const metadata = str(input.metadata);
    const fromXml = metadata ? readIdpMetadata(metadata) : null;
    const entryPoint = str(input.entryPoint) || fromXml?.entryPoint || '';
    const entityId = str(input.entityId) || fromXml?.entityId || '';
    const certificate = str(input.certificate);
    if (!/^https?:\/\//.test(entryPoint)) throw new HttpError(422, 'the identity provider’s metadata XML, or its sign-in (SSO) URL');
    if (!entityId) throw new HttpError(422, 'the identity provider’s metadata XML, or its entity ID (issuer)');
    if (!metadata && !certificate) throw new HttpError(422, 'the identity provider’s metadata XML, or its signing certificate');
    body = {
      providerId: id, issuer: /^https?:\/\//.test(entityId) ? entityId : entryPoint, domain: domains.join(','),
      samlConfig: {
        entryPoint,
        ...(certificate ? { cert: certificate } : {}),
        audience: sp.samlEntityId,
        wantAssertionsSigned: true,
        idpMetadata: metadata ? { metadata, entityID: entityId } : { entityID: entityId },
        spMetadata: { entityID: sp.samlEntityId },
        identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      },
    };
  } else {
    throw new HttpError(422, 'type: "oidc" or "saml"');
  }

  await o.plugin.registerConnection(body, headers);
  await db.query(`update sso_provider set domain_verified = true, require_sso = $2 where provider_id = $1`, [id, input.requireSso === true]);
  await audit(db, actor, 'sso.add', { after: { id, type: input.type, domains, requireSso: input.requireSso === true } });
  return (await listConnections(db)).find((c) => c.id === id)!;
}

/** Requiring single sign-on, or not, for a connection's domains. */
async function setRequireSso(db: Db, id: string, requireSso: boolean, actor: Actor) {
  const r = await db.query(`update sso_provider set require_sso = $2 where provider_id = $1`, [id, requireSso]);
  if (!r.affected) throw new HttpError(404, `no connection "${id}"`);
  await audit(db, actor, 'sso.update', { after: { id, requireSso } });
  return (await listConnections(db)).find((c) => c.id === id)!;
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
 *  response's status or the network error (the network adapter's refusals of private addresses are said as they are),
 *  so this can't be used to look around the network. */
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
  if (doc.issuer.replace(/\/+$/, '') !== issuer) throw new HttpError(422, `the identity provider calls itself ${doc.issuer}: use that as the issuer`);
  return doc as { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; userinfo_endpoint?: string; token_endpoint_auth_methods_supported?: string[] };
}

// Addresses that aren't on the public internet (RFC 6890): this machine, private networks, link-local (cloud
// metadata at 169.254.169.254), carrier-grade NAT, documentation, multicast and reserved ranges.
const NOT_PUBLIC = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) {
  NOT_PUBLIC.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) {
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

const originOf = (u: string) => { try { return new URL(u).origin; } catch { return null; } };

/** Refuses an address whose host is, or resolves to, an address that isn't public, unless its origin is trusted. */
async function assertPublic(url: string, trustedOrigins: readonly string[]) {
  const u = new URL(url);
  if (trustedOrigins.map(originOf).includes(u.origin)) return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    throw new HttpError(422, `couldn’t find the identity provider at ${u.origin}: check the issuer address`);
  }
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a))) {
    throw new HttpError(422, `the identity provider at ${u.origin} isn’t on the public internet: if it is on your private network, `
      + 'add its origin to BETTER_AUTH_TRUSTED_ORIGINS');
  }
}

/** The entity ID and sign-in URL in a SAML identity provider's metadata (Better Auth reads the certificates itself). */
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
