// Reading flags without OFREP (OFREP itself is ofrep.ts), made to sit behind a CDN (Cloudflare): app files (the
// app-files plugin), flagd JSON (the flagd plugin) and app links (the core). plugins/ mounts the plugins' routes,
// index.ts the links. This file also makes and reads app tokens, the credential apps use with OFREP.
//
// App files, for apps (android, ios, web) that read a file instead of using OFREP: one file per environment, flag set
// and entity, values only (clientFile.ts).
//   GET /client/v1/flags/:env/:app                     before login: what everyone gets
//   GET /client/v1/flags/:env/:app/:entity/:secret     the entity's file (:app is the flag set): the entity's app link
// The CDN caches by path, so this server only builds a file when the CDN doesn't have it, and keeps it in
// memory until the next publish. Each response is tagged with its environment (Cache-Tag), so a publish can
// purge them all at once (purge.ts). The device checks the rest itself: its model, OS, browser, app version,
// the country (the CDN's cf-ipcountry response header), and its own id for a % of devices.
//
// Backend servers, with an API key: GET /sdk/v1/flagd/:dimension/:entity, one entity's flags as flagd JSON (flagd.ts),
// for flagd or an OpenFeature flagd provider evaluating in-process; GET /sdk/v1/links/:dimension/:entity?flagSet=<key>, the
// entity's app link, to hand to the app at sign-in. The entity is named by its dimension in the path, as the rules name
// it ("Store is acme-12"): headers carry only the key.

import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { etag, RETAINED_304_HEADERS } from 'hono/etag';
import { all, HttpError, one, type Db } from './db.ts';
import { appTokenSecret, authenticate, clientSecret, LruCache, mayAsk, sameSecret, type KeyCache, type Principal } from './auth.ts';
import type { Snapshot } from './evaluator.ts';
import type { Snapshots } from './plugin.ts';
import { buildClientFile } from './clientFile.ts';
import { buildFlagdDoc } from './flagd.ts';

const gzipAsync = promisify(gzip);
/** A short sha256 of an answer, for its ETag (app files, flagd JSON, OFREP): 22 base64url characters. */
export const shortHash = (s: string) => createHash('sha256').update(s).digest('base64url').slice(0, 22);
type Download = { json: string; gz: Uint8Array<ArrayBuffer>; etag: string };
// gzipped once per file and sent as is (a view of the same bytes, not a copy per response)
const gzipped = async (json: string) => { const b = await gzipAsync(json); return new Uint8Array(b.buffer as ArrayBuffer, b.byteOffset, b.byteLength); };
/** Keeps a built file until the next publish, unless building it failed: then the next request tries again. */
function remember(perKey: Map<string, Promise<Download>>, id: string, d: Promise<Download>) {
  perKey.set(id, d);
  d.catch(() => { if (perKey.get(id) === d) perKey.delete(id); });
  return d;
}

// Each file is built, hashed and gzipped once per publish, on first request. A new publish makes a new snapshot, which
// drops them. The ETag covers `content` only (the values or the flags, not the publish number): a publish that changes
// nothing in a file is a 304. Weak: the gzipped and the plain response are the same content in different bytes
// (RFC 9110 §8.8.1), and a CDN that compresses again keeps a weak ETag as it is.
type Files = WeakMap<Snapshot, Map<string, Promise<Download>>>;
function download(files: Files, snap: Snapshot, id: string, build: () => { content: string; json: string }): Promise<Download> {
  let perKey = files.get(snap);
  if (!perKey) files.set(snap, (perKey = new Map()));
  const d = perKey.get(id);
  if (d) return d;
  return remember(perKey, id, (async () => {
    const { content, json } = build();
    return { json, gz: await gzipped(json), etag: `W/"${shortHash(content)}"` };
  })());
}

const clientFiles: Files = new WeakMap();
const clientDownload = (snap: Snapshot, flagSet: string, entity: string | null) => download(clientFiles, snap, `${flagSet}|${entity ?? ''}`, () => {
  const file = buildClientFile(snap, flagSet, entity ? snap.entities[entity] : null);
  const content = JSON.stringify(file.flags);
  return { content, json: `{"environment":${JSON.stringify(file.environment)},"revision":${file.revision},"flags":${content}}` };
});

// flagd JSON (flagd.ts), for each (backend flag set, entity)
const flagdDocs: Files = new WeakMap();
const flagdDownload = (snap: Snapshot, flagSet: string, entity: string) => download(flagdDocs, snap, `${flagSet}|${entity}`, () => {
  const doc = buildFlagdDoc(snap, flagSet, snap.entities[entity]);
  const content = JSON.stringify(doc.flags);
  return { content, json: `{"$schema":${JSON.stringify(doc.$schema)},"metadata":${JSON.stringify(doc.metadata)},"flags":${content}}` };
});

// The link secrets: environment secret + each entity's link version, read once a minute at most, by each app
// (createApp makes its own LinkCache), one request at a time (the others wait for it). Replacing an entity's link,
// or adding an entity or an environment, clears the app's copy once it commits (journal.ts); a read that was under
// way then doesn't put the old copy back.
const LINK_TTL_MS = 60_000;
type Links = { at: number; envs: Map<string, string>; versions: Map<string, number> };
export class LinkCache {
  private cached: Links | null = null;
  private loading: Promise<Links> | null = null;
  private generation = 0;
  forget() { this.cached = null; this.loading = null; this.generation++; }
  get(db: Db): Promise<Links> | Links {
    if (this.cached && Date.now() - this.cached.at < LINK_TTL_MS) return this.cached;
    if (this.loading) return this.loading;
    const generation = this.generation;
    const load = (async () => {
      const [envRows, entityRows] = await Promise.all([
        all<{ key: string; link_secret: string }>(db, `select key, link_secret from environment`),
        all<{ key: string; v: number }>(db, `select key, client_link_version as v from entity where archived_at is null`),
      ]);
      const l: Links = { at: Date.now(), envs: new Map(envRows.map((e) => [e.key, e.link_secret])), versions: new Map(entityRows.map((c) => [c.key, c.v])) };
      if (generation === this.generation) this.cached = l;
      return l;
    })().finally(() => { if (this.loading === load) this.loading = null; });
    this.loading = load;
    return load;
  }
}

// Which app keys are client apps, by each app (createApp makes its own AppCache). Known ones are kept until an app
// is added, changes kind or is deleted; unknown ones for a short while, in a bounded cache, so a request for an app
// that doesn't exist is answered from memory. Any of those changes clears both once it commits (journal.ts), so an
// app asked for before it existed is answered again, and a deleted one (or one made a backend) stops being served.
// Other server processes see a new app within NOT_APP_TTL_MS. There a deleted app (only one nothing was sent to can
// go) keeps its empty file until their next catch-up with a publish (workers.ts), which clears this cache.
const NOT_APP_TTL_MS = 30_000;
export class AppCache {
  known = new Set<string>();
  unknown = new LruCache<string, number>(1000);
  forget() { this.known.clear(); this.unknown.clear(); }
}

// An entity's link in one environment (shown in the console, given to the app at login).
export async function clientLink(db: Db, env: string, entity: string, app?: string) {
  const row = await one<{ secret: string; v: number }>(db, `select e.link_secret as secret, c.client_link_version as v
    from environment e, entity c where e.key = $1 and c.key = $2 and c.archived_at is null`, [env, entity]);
  if (!row) throw new HttpError(404, 'entity or environment not found');
  return `/client/v1/flags/${env}/${app ?? ':flagSet'}/${encodeURIComponent(entity)}/${clientSecret(row.secret, entity, row.v)}`;
}

// An app's credential for OpenFeature's providers (OFREP, ofrep.ts): `ffl_<environment>.<app>.<entity>.<secret>`, its
// secret made from the environment's secret, the app, the entity and its link version (auth.ts appTokenSecret), so it
// reads that entity for that app only, and replacing the entity's link replaces it too. Keys are lowercase letters,
// digits and dashes, and the secret is base64url, so the dots only ever separate them.
export const APP_TOKEN_PREFIX = 'ffl_';
export async function appToken(db: Db, env: string, entity: string, app: string): Promise<string> {
  const row = await one<{ secret: string; v: number }>(db, `select e.link_secret as secret, c.client_link_version as v
    from environment e, entity c where e.key = $1 and c.key = $2 and c.archived_at is null`, [env, entity]);
  if (!row) throw new HttpError(404, 'entity or environment not found');
  return `${APP_TOKEN_PREFIX}${env}.${app}.${entity}.${appTokenSecret(row.secret, app, entity, row.v)}`;
}
export function readAppToken(token: string): { environment: string; app: string; entity: string; secret: string } | null {
  if (!token.startsWith(APP_TOKEN_PREFIX)) return null;
  const parts = token.slice(APP_TOKEN_PREFIX.length).split('.');
  if (parts.length !== 4 || parts.some((x) => !x)) return null;
  const [environment, app, entity, secret] = parts;
  return { environment, app, entity, secret };
}

function send(c: Context, d: Download, cacheControl: string, tag?: string) {
  c.header('Cache-Control', cacheControl);
  if (tag) c.header('Cache-Tag', tag);
  c.header('ETag', d.etag);
  c.header('Vary', 'Accept-Encoding');
  if (/\bgzip\b/.test(c.req.header('accept-encoding') ?? '')) {
    return c.body(d.gz, 200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
  }
  return c.body(d.json, 200, { 'Content-Type': 'application/json' });
}

// A minute in the CDN, then it asks again (usually a 304). If this server can't be reached, the CDN keeps
// serving the last file for a day. A publish purges the environment's tag, so changes show in seconds.
const CDN_CACHE = 'public, max-age=60, stale-while-revalidate=600, stale-if-error=86400';

type Parts = { db: Db; plane: Snapshots; links: LinkCache; keys: KeyCache; flagSets: AppCache };

const snapshotIn = (plane: Parts['plane'], env: string) => {
  const snap = plane.snapshots.get(env);
  if (!snap) throw new HttpError(404, `environment "${env}" not found`);
  return snap;
};

/** App files (the app-files plugin): GET /client/v1/flags/…, values only, for apps and the CDN in front of them. */
export function appFileRoutes({ db, plane, links, flagSets: apps }: Parts) {
  const app = new Hono();
  // If-None-Match → 304 the standard way (weak comparison, a list of ETags, *), keeping the headers a 304 must carry.
  // It uses the ETag each response already has, so nothing is hashed per request. Only on these paths: this app is
  // mounted at /, so a bare use() would reach the console's API too.
  // Web apps read their file from another origin (the console's server, or the CDN in front of it). A file is public
  // to whoever has its link and carries no cookies, so any origin may read it; the SDK reads ETag, and the country
  // when the CDN adds it to the response (cf-ipcountry).
  app.use('/client/v1/*', cors({ origin: '*', allowMethods: ['GET', 'HEAD'], exposeHeaders: ['ETag', 'CF-IPCountry'], maxAge: 86400 }));
  // A 304 keeps the CORS headers too: a browser reading the file from another origin checks them on every answer.
  const retainedHeaders = [...RETAINED_304_HEADERS, 'access-control-allow-origin', 'access-control-expose-headers', 'cache-tag'];
  app.use('/client/v1/flags/*', etag({ retainedHeaders }));
  const snapshotFor = (env: string) => snapshotIn(plane, env);

  app.get('/client/v1/flags/:env/:app', async (c) => {
    const { env, app: appKey } = c.req.param();
    const snap = snapshotFor(env);
    await ensureClientApp(db, apps, appKey);
    return send(c, await clientDownload(snap, appKey, null), CDN_CACHE, `env-${env}`);
  });

  app.get('/client/v1/flags/:env/:app/:entity/:secret', async (c) => {
    const { env, app: appKey, entity, secret } = c.req.param();
    // One answer for every kind of wrong link (environment, flag set, entity or secret), after the same work, so links
    // can't be used to find out which entities exist: the secret is worked out for an unknown entity too.
    const noFile = () => new HttpError(404, 'no file at this link');
    const snap = plane.snapshots.get(env);
    const l = await links.get(db);
    const envSecret = l.envs.get(env);
    const v = l.versions.get(entity);
    const right = sameSecret(secret, clientSecret(envSecret ?? '', entity, v ?? 0));
    if (!snap || !Object.hasOwn(snap.entities, entity) || !envSecret || v === undefined || !right) throw noFile();
    try { await ensureClientApp(db, apps, appKey); } catch { throw noFile(); }
    return send(c, await clientDownload(snap, appKey, entity), CDN_CACHE, `env-${env}`);
  });

  return app;
}

/** App links for backends (core): GET /sdk/v1/links/<dimension>/<entity>?flagSet=<key>. `files`: whether app files
 *  are served (the app-files plugin), so the answer has the file's path as well as the OFREP token. */
export function linkRoutes({ db, plane, keys, flagSets: apps }: Parts, o: { files: boolean }) {
  const app = new Hono();
  const snapshotFor = (env: string) => snapshotIn(plane, env);

  // Backend servers hand each app its entity's link at sign-in: GET /sdk/v1/links/<dimension>/<entity>?flagSet=<key>, with
  // the backend's API key, within its scope, for the key's environment. The answer is the link's path (the app file, from
  // the address apps use) and the same link as a token for OpenFeature's OFREP providers. Never cached: it is a secret.
  app.get('/sdk/v1/links/:dimension/:entity', async (c) => {
    const p = await authenticate(db, { authorization: c.req.header('authorization') }, keys);
    const snap = snapshotFor(p.environment);
    const { dimension, entity } = c.req.param();
    const info = Object.hasOwn(snap.entities, entity) ? snap.entities[entity] : null;
    if (!info || info.dimension !== dimension) throw new HttpError(404, `no ${dimension} "${entity}"`);
    if (!mayAsk(p, entity, info.path)) throw new HttpError(403, `this key can’t ask about "${entity}"`);
    const appKey = c.req.query('flagSet');
    if (!appKey) throw new HttpError(400, 'name the flag set the link is for: ?flagSet=<key>, e.g. ?flagSet=web');
    await ensureClientApp(db, apps, appKey);
    c.header('Cache-Control', 'no-store');
    return c.json({ environment: p.environment, flagSet: appKey, entity, ...(o.files ? { path: await clientLink(db, p.environment, entity, appKey) } : {}),
      token: await appToken(db, p.environment, entity, appKey) });
  });
  return app;
}

/** flagd JSON for backends (the flagd plugin): GET /sdk/v1/flagd/<dimension>/<entity>, with an API key. */
export function flagdRoutes({ db, plane, keys }: Parts) {
  const app = new Hono();
  app.use('/sdk/v1/flagd', etag());
  app.use('/sdk/v1/flagd/*', etag());
  const snapshotFor = (env: string) => snapshotIn(plane, env);

  // Backend servers: one entity's flags as flagd JSON. A flagd document is one entity's flags in the key's flag set
  // (flagd.ts), so a backend serving several entities asks for each, for example as one flagd source per entity. The key says which it may ask about.
  const flagdFor = async (c: Context, named: { dimension: string; entity: string } | null) => {
    const p = await authenticate(db, { authorization: c.req.header('authorization') }, keys);
    const snap = snapshotFor(p.environment);
    const entity = named ? named.entity : ownEntity(p, c.req.header('x-customer-id'));
    const info = Object.hasOwn(snap.entities, entity) ? snap.entities[entity] : null;
    if (!info || (named && info.dimension !== named.dimension)) {
      throw new HttpError(404, named ? `no ${named.dimension} "${named.entity}"` : `"${entity}" not found`);
    }
    if (!mayAsk(p, entity, info.path)) throw new HttpError(403, `this key can’t ask about "${entity}"`);
    return send(c, await flagdDownload(snap, p.project, entity), 'private, no-cache');
  };
  app.get('/sdk/v1/flagd/:dimension/:entity', (c) => flagdFor(c, { dimension: c.req.param('dimension'), entity: c.req.param('entity') }));
  // A key for one entity (or one below, for its own) needs no path. X-Customer-Id, from before dimensions, still works
  // with `all` keys so backends set up then don't break; it isn't documented any more.
  app.get('/sdk/v1/flagd', (c) => flagdFor(c, null));

  return app;
}

function ownEntity(p: Principal, legacyHeader: string | undefined): string {
  if (p.entity) return p.entity;
  if (legacyHeader) return legacyHeader;
  throw new HttpError(400, 'flagd JSON is one entity’s flags: name it in the path, /sdk/v1/flagd/<dimension>/<entity>');
}

export async function ensureClientApp(db: Db, apps: AppCache, appKey: string) {
  if (apps.known.has(appKey)) return;
  const missed = apps.unknown.get(appKey);
  if (missed !== undefined && Date.now() - missed < NOT_APP_TTL_MS) throw new HttpError(404, `flag set "${appKey}" not found`);
  const p = await one<{ kind: string }>(db, `select kind from project where key = $1`, [appKey]);
  if (!p || p.kind !== 'client') {
    apps.unknown.set(appKey, Date.now());
    throw new HttpError(404, `flag set "${appKey}" not found`);
  }
  apps.known.add(appKey);
}
