// Reading flags without OFREP (OFREP itself is ofrep.ts), made to sit behind a CDN (Cloudflare): CDN files (the
// cdn-files plugin), flagd JSON (the flagd plugin) and app links (the core). plugins/ mounts the plugins' routes,
// index.ts the links. This file also makes and reads app tokens, the credential apps use with OFREP.
//
// CDN files, for apps (android, ios, web) that read a file instead of using OFREP: one file per environment, service
// and entity, as flagd JSON (flagd.ts), read by an OpenFeature flagd provider in-process (or by flagd).
//   GET /cdn/v1/flags/:env/:app                        before login: what everyone gets
//   GET /cdn/v1/flags/:env/:app/:entity/:secret        the entity's file (:app is the service): the entity's app link
// Everything the server knows is settled in the file (the environment, the service, the entity and those above it),
// so it names no other entity and holds none of their values. The CDN caches by path, so this server only builds a
// file when the CDN doesn't have it, and keeps it in memory until the next publish. Each response is tagged (Cache-Tag)
// with its environment, its entity and each one above it, and its own link (purge.ts fileTags), so a publish purges
// only the files it changed (cdn.ts). Browsers ask again every time (max-age=0, usually a 304 from the CDN), and the
// CDN keeps a file a minute (s-maxage, CDN-Cache-Control), so a change shows within that minute even when a purge
// fails. The device checks the rest itself, in
// the flagd JSON's rules: its model, OS, browser, app version, the country (the CDN's cf-ipcountry response header),
// and its own id for a % of devices.
//
// Backend servers, with an API key: GET /sdk/v1/flagd/:dimension/:entity, one entity's flags as flagd JSON (flagd.ts),
// for flagd or an OpenFeature flagd provider evaluating in-process, or GET /sdk/v1/flagd/service, every entity the key
// may ask about in one document; GET /sdk/v1/links/:dimension/:entity?service=<key>, the entity's app link, to hand to
// the app at sign-in; PUT /sdk/v1/entities/:dimension/:entity, an entity added as it signs up. The entity is named by
// its dimension in the path, as the rules name it ("Store is acme-12"): headers carry only the key.
//
// Several servers can share one database. One that hasn't caught up with a publish yet (workers.ts, within a second)
// doesn't know an entity added a moment ago on another: before it answers that an entity isn't there, it looks at the
// database's revision once (caughtUpWith) and, if it is behind, rebuilds the snapshot first.

import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { etag, RETAINED_304_HEADERS } from 'hono/etag';
import { all, HttpError, one, type Db } from './db.ts';
import { appTokenSecret, authenticate, clientSecret, LruCache, mayAsk, sameSecret, type KeyCache, type Principal } from './auth.ts';
import type { EntityInfo, Snapshot } from './evaluator.ts';
import type { Snapshots } from './plugin.ts';
import { fileTags } from './purge.ts';
import { buildFlagdDoc, buildServiceDoc } from './flagd.ts';
import { entityKeyProblem } from './checks.ts';
import { upsertEntity } from './control.ts';
import type { Actor } from './layers.ts';

const gzipAsync = promisify(gzip);
/** A short sha256 of an answer, for its ETag (CDN files, flagd JSON, OFREP): 22 base64url characters. */
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
// drops them. The ETag covers `content` only (the flags, not the publish number): a publish that changes
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

// flagd JSON (flagd.ts) for one service and entity (null: what it gets with no entity). The same document goes to
// backends (flagdDownload, for a backend service) and to apps as their CDN file (cdnDownload, for an app service).
const flagdJson = (snap: Snapshot, service: string, entity: string | null) => {
  const doc = buildFlagdDoc(snap, service, entity ? snap.entities[entity] : null);
  const content = JSON.stringify(doc.flags);
  return { content, json: `{"$schema":${JSON.stringify(doc.$schema)},"metadata":${JSON.stringify(doc.metadata)},"flags":${content}}` };
};
const cdnFileCache: Files = new WeakMap();
const cdnDownload = (snap: Snapshot, service: string, entity: string | null) =>
  download(cdnFileCache, snap, `${service}|${entity ?? ''}`, () => flagdJson(snap, service, entity));
const flagdDocs: Files = new WeakMap();
const flagdDownload = (snap: Snapshot, service: string, entity: string) =>
  download(flagdDocs, snap, `${service}|${entity}`, () => flagdJson(snap, service, entity));
// One document for every entity a key may ask about (flagd.ts buildServiceDoc): per service and per key's reach (every
// entity, or one and those under it), built once per publish like the others.
const serviceDownload = (snap: Snapshot, service: string, below: string | null) =>
  download(flagdDocs, snap, `${service}|*${below ?? ''}`, () => {
    const entities = Object.values(snap.entities).filter((e) => below === null || e.path.includes(below));
    const doc = buildServiceDoc(snap, service, entities, below === null ? null : snap.entities[below]);
    // its shared evaluator (who OFREP refuses) is part of what it says, as the flags are
    const content = JSON.stringify([doc.$evaluators ?? null, doc.flags]);
    return { content, json: JSON.stringify(doc) };
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
  /** `maxAgeMs`: a copy older than this is read again (an entity this server has just caught up with, below). */
  get(db: Db, maxAgeMs = LINK_TTL_MS): Promise<Links> | Links {
    if (this.cached && Date.now() - this.cached.at < maxAgeMs) return this.cached;
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
export async function cdnFilePath(db: Db, env: string, entity: string, app?: string) {
  const row = await one<{ secret: string; v: number }>(db, `select e.link_secret as secret, c.client_link_version as v
    from environment e, entity c where e.key = $1 and c.key = $2 and c.archived_at is null`, [env, entity]);
  if (!row) throw new HttpError(404, 'entity or environment not found');
  return `/cdn/v1/flags/${env}/${app ?? ':service'}/${encodeURIComponent(entity)}/${clientSecret(row.secret, entity, row.v)}`;
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

function send(c: Context, d: Download, cacheControl: string, tags?: string[]) {
  c.header('Cache-Control', cacheControl);
  if (tags) {
    c.header('CDN-Cache-Control', CDN_ONLY_CACHE);
    c.header('Cache-Tag', tags.join(','));
  }
  c.header('ETag', d.etag);
  c.header('Vary', 'Accept-Encoding');
  if (/\bgzip\b/.test(c.req.header('accept-encoding') ?? '')) {
    return c.body(d.gz, 200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
  }
  return c.body(d.json, 200, { 'Content-Type': 'application/json' });
}

// Browsers ask every time (max-age=0: the CDN answers, usually with a 304), so a kill switch reaches them as soon as
// it reaches the CDN. A minute in the CDN (s-maxage, and CDN-Cache-Control for CDNs that read it, Cloudflare among
// them), then it asks this server again; meanwhile it may answer with the old file for up to 10 minutes while it does
// (stale-while-revalidate, the CDN only). If this server can't be reached, the CDN keeps serving the last file for a
// day. A publish purges the files it changed (purge.ts tags), so changes show in seconds.
const CDN_CACHE = 'public, max-age=0, s-maxage=60, stale-if-error=86400';
const CDN_ONLY_CACHE = 'public, max-age=60, stale-while-revalidate=600, stale-if-error=86400';

/** A snapshot without this entity may be behind a publish another server made (an entity added there a moment ago):
 *  one look at the environment's revision, shared by the requests waiting on it, and a rebuild only when the database
 *  is ahead (the link secrets are read again too). The snapshot to answer with, newest. */
const catchingUp = new WeakMap<Snapshots, Map<string, Promise<Snapshot | undefined>>>();
export function caughtUpWith(db: Db, plane: Snapshots, links: LinkCache, environment: string): Promise<Snapshot | undefined> {
  if (!plane.refresh) return Promise.resolve(plane.snapshots.get(environment));
  let perEnv = catchingUp.get(plane);
  if (!perEnv) catchingUp.set(plane, (perEnv = new Map()));
  const waiting = perEnv;
  let p = waiting.get(environment);
  if (!p) {
    p = (async () => {
      const row = await one<{ revision: string }>(db, `select revision from environment where key = $1`, [environment]);
      const now = plane.snapshots.get(environment);
      if (!row || (now && Number(row.revision) <= now.revision)) return now;
      const snap = await plane.refresh!(db, environment);
      links.forget();
      return snap;
    })().finally(() => waiting.delete(environment));
    waiting.set(environment, p);
  }
  return p;
}
/** The entity in the environment's snapshot, catching up first when this server doesn't know it (caughtUpWith). */
async function entityIn(parts: Pick<Parts, 'db' | 'plane' | 'links'>, environment: string, entity: string): Promise<{ snap: Snapshot; info: EntityInfo | null }> {
  let snap = snapshotIn(parts.plane, environment);
  if (!Object.hasOwn(snap.entities, entity)) snap = (await caughtUpWith(parts.db, parts.plane, parts.links, environment)) ?? snap;
  return { snap, info: Object.hasOwn(snap.entities, entity) ? snap.entities[entity] : null };
}

type Parts = { db: Db; plane: Snapshots; links: LinkCache; keys: KeyCache; services: AppCache };

const snapshotIn = (plane: Parts['plane'], env: string) => {
  const snap = plane.snapshots.get(env);
  if (!snap) throw new HttpError(404, `environment "${env}" not found`);
  return snap;
};

/** CDN files (the cdn-files plugin): GET /cdn/v1/flags/…, flagd JSON for apps and the CDN in front of them. */
export function cdnFileRoutes({ db, plane, links, services: apps }: Parts) {
  const app = new Hono();
  // If-None-Match → 304 the standard way (weak comparison, a list of ETags, *), keeping the headers a 304 must carry.
  // It uses the ETag each response already has, so nothing is hashed per request. Only on these paths: this app is
  // mounted at /, so a bare use() would reach the console's API too.
  // Web apps read their file from another origin (the console's server, or the CDN in front of it). A file is public
  // to whoever has its link and carries no cookies, so any origin may read it; the SDK reads ETag, and the country
  // when the CDN adds it to the response (cf-ipcountry).
  app.use('/cdn/v1/*', cors({ origin: '*', allowMethods: ['GET', 'HEAD'], exposeHeaders: ['ETag', 'CF-IPCountry'], maxAge: 86400 }));
  // No file (a wrong link, an entity not there yet): nothing keeps that answer, so the right file is served as soon
  // as it exists. A file's own answer sets its caching (send).
  app.use('/cdn/v1/flags/*', async (c, next) => {
    await next();
    if (c.res.status >= 400) c.res.headers.set('Cache-Control', 'no-store');
  });
  // A 304 keeps the CORS headers too: a browser reading the file from another origin checks them on every answer.
  const retainedHeaders = [...RETAINED_304_HEADERS, 'access-control-allow-origin', 'access-control-expose-headers', 'cache-tag', 'cdn-cache-control'];
  app.use('/cdn/v1/flags/*', etag({ retainedHeaders }));
  const snapshotFor = (env: string) => snapshotIn(plane, env);

  app.get('/cdn/v1/flags/:env/:app', async (c) => {
    const { env, app: appKey } = c.req.param();
    const snap = snapshotFor(env);
    await ensureClientApp(db, apps, appKey);
    return send(c, await cdnDownload(snap, appKey, null), CDN_CACHE, fileTags(env, null));
  });

  app.get('/cdn/v1/flags/:env/:app/:entity/:secret', async (c) => {
    const { env, app: appKey, entity, secret } = c.req.param();
    // One answer for every kind of wrong link (environment, service, entity or secret), after the same work, so links
    // can't be used to find out which entities exist: the secret is worked out for an unknown entity too.
    const noFile = () => new HttpError(404, 'no file at this link');
    let snap = plane.snapshots.get(env);
    let l = await links.get(db);
    // an entity added a moment ago, on another server: catch up first (its link secret too)
    if (snap && (!Object.hasOwn(snap.entities, entity) || !l.versions.has(entity))) {
      snap = (await caughtUpWith(db, plane, links, env)) ?? snap;
      if (Object.hasOwn(snap.entities, entity) && !l.versions.has(entity)) l = await links.get(db, 1000);
    }
    const envSecret = l.envs.get(env);
    const v = l.versions.get(entity);
    const right = sameSecret(secret, clientSecret(envSecret ?? '', entity, v ?? 0));
    if (!snap || !Object.hasOwn(snap.entities, entity) || !envSecret || v === undefined || !right) throw noFile();
    try { await ensureClientApp(db, apps, appKey); } catch { throw noFile(); }
    return send(c, await cdnDownload(snap, appKey, entity), CDN_CACHE, fileTags(env, snap.entities[entity].path));
  });

  return app;
}

/** App links and new entities for backends (core): GET /sdk/v1/links/<dimension>/<entity>?service=<key>, and
 *  PUT /sdk/v1/entities/<dimension>/<entity>. `files`: whether CDN files are served (the cdn-files plugin), so a
 *  link's answer has the file's path as well as the OFREP token. */
export function linkRoutes({ db, plane, keys, links, services: apps }: Parts, o: { files: boolean }) {
  const app = new Hono();

  // Backend servers hand each app its entity's link at sign-in: GET /sdk/v1/links/<dimension>/<entity>?service=<key>, with
  // the backend's API key, within its scope, for the key's environment. The answer is the link's path (the CDN file, from
  // the address apps use) and the same link as a token for OpenFeature's OFREP providers. Never cached: it is a secret.
  app.get('/sdk/v1/links/:dimension/:entity', async (c) => {
    const p = await authenticate(db, { authorization: c.req.header('authorization'), origin: c.req.header('origin') }, keys);
    if (p.kind !== 'server') throw new HttpError(403, 'an app’s key can’t hand out app links: ask with a backend’s key');
    const { dimension, entity } = c.req.param();
    const { info } = await entityIn({ db, plane, links }, p.environment, entity);
    // a key scoped to an entity (or those below one) gets the same 403 for one that doesn't exist as for one outside
    // its scope, as OFREP does: it can't learn which entities exist
    if (!info || info.dimension !== dimension) {
      if (p.scope !== 'all') throw new HttpError(403, `this key can’t ask about "${entity}"`);
      throw new HttpError(404, `no ${dimension} "${entity}"`);
    }
    if (!mayAsk(p, entity, info.path)) throw new HttpError(403, `this key can’t ask about "${entity}"`);
    const appKey = c.req.query('service');
    if (!appKey) throw new HttpError(400, 'name the service the link is for: ?service=<key>, e.g. ?service=web');
    await ensureClientApp(db, apps, appKey);
    c.header('Cache-Control', 'no-store');
    return c.json({ environment: p.environment, service: appKey, entity, ...(o.files ? { path: await cdnFilePath(db, p.environment, entity, appKey) } : {}),
      token: await appToken(db, p.environment, entity, appKey) });
  });

  // Backend servers add an entity the moment it signs up, so its first request already asks as it:
  // PUT /sdk/v1/entities/<dimension>/<entity> {"name": "…", "parent": "<key>"}, with a backend's key that may ask about
  // every entity (scope `all`). Idempotent: an entity that is there already is left as it is (200), or renamed when
  // the name differs; one under another parent is refused (409), as moving changes what it gets: that is the console's.
  // The key's environment knows it when the answer comes; every environment and every server publishes it (no CDN
  // file is purged and no event stream woken: nobody's answers change, journal.ts), and a server that hasn't caught up
  // yet when the entity's first request comes looks at the database first (caughtUpWith).
  app.put('/sdk/v1/entities/:dimension/:entity', async (c) => {
    const p = await authenticate(db, { authorization: c.req.header('authorization'), origin: c.req.header('origin') }, keys);
    if (p.kind !== 'server') throw new HttpError(403, 'an app’s key can’t add entities: ask with a backend’s key');
    if (p.scope !== 'all') throw new HttpError(403, 'only a key that may ask about every entity (scope all) adds entities');
    const { dimension, entity } = c.req.param();
    const problem = entityKeyProblem(entity);
    if (problem) throw new HttpError(422, problem);
    let body: unknown;
    try { body = await c.req.json(); } catch { throw new HttpError(400, 'the body isn’t JSON: {"name": "…", "parent": "<key>"}'); }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'the body is an object: {"name": "…", "parent": "<key>"}');
    const { name, parent } = body as { name?: unknown; parent?: unknown };
    if (name !== undefined && typeof name !== 'string') throw new HttpError(422, 'name is text');
    if (parent !== undefined && parent !== null && typeof parent !== 'string') throw new HttpError(422, 'parent is an entity’s key, or null');
    const actor: Actor = { name: `API key ${(await one<{ key_prefix: string }>(db, `select key_prefix from api_key where id = $1`, [p.keyId]))?.key_prefix ?? p.keyId}`, type: 'service_token' };
    const now = async () => one<{ key: string; name: string; dimension: string; parent: string | null }>(db, `select c.key, c.name, d.key as dimension, p.key as parent
      from entity c join dimension d on d.id = c.dimension_id left join entity p on p.id = c.parent_id where c.key = $1 and c.archived_at is null`, [entity]);
    let created = false;
    let row = await now();
    if (!row) {
      try {
        await upsertEntity(db, dimension, entity, { name: (name ?? '').trim() || entity, parent: parent ?? null }, actor, true);
        created = true;
      } catch (e) {
        if (!(e instanceof HttpError && e.status === 409)) throw e;    // added at the same moment by another request
      }
      row = await now();
      if (!row) throw new HttpError(409, `“${entity}” is taken already (keys are unique across every dimension)`);
    }
    if (row.dimension !== dimension) throw new HttpError(409, `“${entity}” is in another dimension: keys are unique across every dimension`);
    if (!created && parent !== undefined && (parent ?? null) !== row.parent) {
      throw new HttpError(409, `“${entity}” is under ${row.parent ? `“${row.parent}”` : 'no parent'}: move it in the console, as that changes what it gets`);
    }
    if (!created && typeof name === 'string' && name.trim() && name.trim() !== row.name) {
      await upsertEntity(db, dimension, entity, { name: name.trim() }, actor, false);
      row = (await now())!;
    }
    // this environment answers for it from now on; the publisher brings the others along, and other servers catch up
    // on its first request (caughtUpWith)
    if (plane.refresh && !Object.hasOwn(plane.snapshots.get(p.environment)?.entities ?? {}, entity)) await plane.refresh(db, p.environment);
    c.header('Cache-Control', 'no-store');
    return c.json({ key: row.key, name: row.name, dimension: row.dimension, parent: row.parent, created }, created ? 201 : 200);
  });
  return app;
}

/** flagd JSON for backends (the flagd plugin): GET /sdk/v1/flagd/<dimension>/<entity>, with an API key. */
export function flagdRoutes({ db, plane, keys, links }: Parts) {
  const app = new Hono();
  app.use('/sdk/v1/flagd', etag());
  app.use('/sdk/v1/flagd/*', etag());
  const snapshotFor = (env: string) => snapshotIn(plane, env);

  // Backend servers: one entity's flags as flagd JSON, in the key's service (flagd.ts). A backend serving several
  // entities reads them all in one document (/sdk/v1/flagd/service, below), or one per entity. The key says which it
  // may ask about.
  const flagdFor = async (c: Context, named: { dimension: string; entity: string } | null) => {
    const p = await authenticate(db, { authorization: c.req.header('authorization'), origin: c.req.header('origin') }, keys);
    if (p.kind !== 'server') throw new HttpError(403, 'an app’s key reads values only (OFREP): the rules as flagd JSON are for a backend’s key');
    snapshotFor(p.environment);
    const entity = named ? named.entity : ownEntity(p);
    const { snap, info } = await entityIn({ db, plane, links }, p.environment, entity);
    if (!info || (named && info.dimension !== named.dimension)) {
      if (named && p.scope !== 'all') throw new HttpError(403, `this key can’t ask about "${entity}"`);    // as for the links, above
      throw new HttpError(404, named ? `no ${named.dimension} "${named.entity}"` : `"${entity}" not found`);
    }
    if (!mayAsk(p, entity, info.path)) throw new HttpError(403, `this key can’t ask about "${entity}"`);
    return send(c, await flagdDownload(snap, p.project, entity), 'private, no-cache');
  };
  app.get('/sdk/v1/flagd/:dimension/:entity', (c) => flagdFor(c, { dimension: c.req.param('dimension'), entity: c.req.param('entity') }));
  // A key for one entity (or one below, for its own) needs no path.
  app.get('/sdk/v1/flagd', (c) => flagdFor(c, null));
  // Every entity the key may ask about in one document, with the entity picked inside it by the request's dimension
  // keys (flagd.ts buildServiceDoc): one flagd source for a backend shared by many entities. An `all` key's holds every
  // entity, and no entity for a request that names none; a `below` key's, its entity and those under it.
  app.get('/sdk/v1/flagd/service', async (c) => {
    const p = await authenticate(db, { authorization: c.req.header('authorization'), origin: c.req.header('origin') }, keys);
    if (p.kind !== 'server') throw new HttpError(403, 'an app’s key reads values only (OFREP): the rules as flagd JSON are for a backend’s key');
    let snap = snapshotFor(p.environment);
    if (p.scope === 'entity') throw new HttpError(400, 'this key asks about one entity: read its own document, GET /sdk/v1/flagd');
    if (p.scope === 'below') {
      const found = await entityIn({ db, plane, links }, p.environment, p.entity ?? '');
      if (!found.info) throw new HttpError(403, `this key’s entity "${p.entity}" is gone`);
      snap = found.snap;
    }
    return send(c, await serviceDownload(snap, p.project, p.scope === 'all' ? null : p.entity), 'private, no-cache');
  });

  return app;
}

function ownEntity(p: Principal): string {
  if (p.entity) return p.entity;
  throw new HttpError(400, 'name the entity in the path, /sdk/v1/flagd/<dimension>/<entity>, or read every entity in one document, /sdk/v1/flagd/service');
}

export async function ensureClientApp(db: Db, apps: AppCache, appKey: string) {
  if (apps.known.has(appKey)) return;
  const missed = apps.unknown.get(appKey);
  if (missed !== undefined && Date.now() - missed < NOT_APP_TTL_MS) throw new HttpError(404, `service "${appKey}" not found`);
  const p = await one<{ kind: string }>(db, `select kind from project where key = $1`, [appKey]);
  if (!p || p.kind !== 'client') {
    apps.unknown.set(appKey, Date.now());
    throw new HttpError(404, `service "${appKey}" not found`);
  }
  apps.known.add(appKey);
}
