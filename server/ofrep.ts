// OpenFeature Remote Evaluation Protocol (OFREP 0.4, github.com/open-feature/protocol), so apps and backends use
// OpenFeature's own providers: the OFREP web provider (browsers, React), the Kotlin and Swift providers (Android, iOS)
// and the server providers. No SDK of ours.
//
//   POST /ofrep/v1/evaluate/flags          every flag sent to the key's app, for one context (client providers):
//                                          one ETag for the answer, If-None-Match → 304
//   POST /ofrep/v1/evaluate/flags/:key     one flag, for a context per request (server providers)
//   GET  /ofrep/v1/events/:env/:service[/:entity]/:signature
//                                          server-sent events: "refetchEvaluation" after a publish that may change the
//                                          answers of that service for that entity (or for no entity). The bulk answer
//                                          lists it (eventStreams), so client providers stop polling. At most so many
//                                          open at once, per environment and per client address (429).
//                                          (GET /ofrep/v1/events/:env/:signature, from answers before streams had a
//                                          scope, still works: it hears every publish in the environment.)
//
// Each answer's metadata (OpenFeature's flagMetadata) says which publish answered (`revision`) and which entity asked
// (`entity`, left out when none did); a backend's secret key also gets the key of the rule that decided (`ruleKey`).
// The bulk answer's ETag leaves the revision out, so a publish that changes nothing for this context is still a 304.
//
// After a change event the provider asks again with ?flagConfigEtag=<revision>. With several servers, the one it asks
// may not have caught up with that publish yet: it does first (the data plane's catch-up, workers.ts), so the answer is
// never an old one, nor a 304 for it.
//
// Who is asking (docs/design/dimensions.md "Naming the entity"):
//   - the credential (Authorization: Bearer <credential>, or OFREP's X-API-Key) says the environment, the app, and which
//     entities it may ask about. A backend uses its service's secret key. An app uses its service's public key (values
//     only, for the context it sends), or an app token (delivery.ts appToken) its backend hands it at sign-in with the
//     app link: then it asks as that entity, for that service, only, and replacing the entity's link replaces it at once;
//   - the entity is named in the evaluation context by its dimension, as the rules name it: {"company": "acme"}. When
//     several dimensions are named, the lowest asks and the others must be the ones above it. The server fills in the
//     levels above from its own data, and ignores anything else the context says about who is asking (the app, the
//     environment), as for CDN files (evaluator.ts contextFor);
//   - naming none: a key for one entity (or one with the entities below it) asks as that entity; an `all` key asks as
//     no entity (what everyone gets before sign-in).
// The rest of the context is what the device or request knows about itself, nested ({"app": {"version": "6.0.0"}} is
// app.version). An attribute written dotted ({"app.version": …}) is refused (400 INVALID_CONTEXT), as are a key that
// looks like a misspelled dimension and `entity`: flagd JSON (backends, CDN files) reads nested attributes only and
// can't say so, so OFREP says it, and nothing is quietly asked as no entity. `targetingKey` is the device or user a %
// of devices is decided for (`device.id`, unless the context has that), never the entity.

import { createHmac } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { HttpError, type Db } from './db.ts';
import { appTokenSecret, authenticate, mayAsk, sameSecret, type KeyCache, type Principal } from './auth.ts';
import { authSettingsFromEnv, clientAddressFor } from './betterAuth.ts';
import { ensureClientApp, readAppToken, shortHash, type AppCache, type LinkCache } from './delivery.ts';
import { contextFor, evaluate, HIDDEN_PREFIX, sortedFlagKeys, type EvalResult, type FlagDef, type Snapshot } from './evaluator.ts';
import type { EventHub } from './events.ts';
import { ENTITY_FIELD } from './dimensions.ts';
import type { Snapshots } from './plugin.ts';

/** An events stream's address carries a signature made with the environment's secret, for the service and entity it
 *  is for, so only someone given it in an answer (a valid credential for them) can listen. It says only that a publish
 *  may have changed those answers, never what. Without a service: the whole environment's, from older answers. */
const eventsSignature = (envSecret: string, service?: string, entity?: string | null) =>
  createHmac('sha256', envSecret).update(service === undefined ? 'ofrep-events' : `ofrep-events/${service}/${entity ?? ''}`).digest('base64url').slice(0, 22);
const EVENTS_INACTIVITY_SEC = 120;
const HEARTBEAT_MS = 25_000;

/** How many change-event streams one server keeps open at once: per environment, and per client address (the
 *  connection's, or what a trusted proxy says: FF_TRUSTED_PROXIES, as for sign-in). Beyond them, 429: the provider
 *  polls instead. */
export type StreamLimits = { perEnvironment: number; perClient: number };
export const STREAM_LIMITS: StreamLimits = { perEnvironment: 10_000, perClient: 100 };
export function streamLimitsFrom(env: Readonly<Record<string, string | undefined>>): StreamLimits {
  const read = (name: string, fallback: number) => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    if (!/^[1-9]\d*$/.test(raw)) throw new Error(`${name}: "${raw}" isn’t a whole number above 0`);
    return Number(raw);
  };
  return {
    perEnvironment: read('FF_EVENT_STREAMS_PER_ENVIRONMENT', STREAM_LIMITS.perEnvironment),
    perClient: read('FF_EVENT_STREAMS_PER_CLIENT', STREAM_LIMITS.perClient),
  };
}

type Ofrep = { status: 400 | 403 | 404; errorCode: string; errorDetails: string };
class OfrepError extends Error {
  readonly status: Ofrep['status'];
  readonly errorCode: string;
  constructor(status: Ofrep['status'], errorCode: string, errorDetails: string) {
    super(errorDetails);
    this.status = status;
    this.errorCode = errorCode;
  }
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
const missing = (v: unknown) => v === undefined || v === null || v === '';

/** {"app": {"version": "6.0.0"}} → {"app.version": "6.0.0"}; lists and plain values stay as they are. */
export function flattenContext(ctx: Json, prefix = '', out: Json = {}): Json {
  for (const [k, v] of Object.entries(ctx)) {
    const name = prefix ? `${prefix}.${k}` : k;
    if (isObject(v)) flattenContext(v, name, out);
    else out[name] = v;
  }
  return out;
}

/** How many single-letter edits turn one word into the other (Levenshtein), up to `max` + 1. */
function edits(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}
const plain = (s: string) => s.toLowerCase().replace(/[_-]/g, '');
/** A key that is probably a dimension written wrong: another case, a plural, or a letter or two off ("compnay"). */
function looksLikeDimension(key: string, dimension: string): boolean {
  const [k, d] = [plain(key), plain(dimension)];
  if (k === d) return true;
  const singular = k.endsWith('ies') ? `${k.slice(0, -3)}y` : k.endsWith('es') && !d.endsWith('e') ? k.slice(0, -2) : k.endsWith('s') ? k.slice(0, -1) : k;
  if (singular === d) return true;
  const max = d.length >= 5 ? 2 : 1;
  return edits(k, d, max) <= max;
}

/** What's wrong with a context, in words, or null. Only what would otherwise be read as something else without a word:
 *  an attribute written dotted (flagd JSON reads only nested ones), `entity`, or a key that looks like a misspelled
 *  dimension (the request would ask as no entity, or as the one above). It names the dimensions, never an entity. */
export function contextProblem(snap: Pick<Snapshot, 'dimensions' | 'fields'>, ctx: Json): string | null {
  const dims = snap.dimensions;
  const byDimension = dims.length ? `name the entity by its dimension: ${dims.map((d) => `"${d}"`).join(', ')}` : 'this installation has no dimensions';
  const dotted = (o: Json, prefix: string): string | null => {
    for (const [k, v] of Object.entries(o)) {
      const name = prefix ? `${prefix}.${k}` : k;
      if (k.includes('.') && Object.hasOwn(snap.fields, name) && !dims.includes(name)) {
        const [head, ...rest] = k.split('.');
        return `"${k}" is written dotted: nest it, {"${head}": {"${rest.join('.')}": …}}, as flagd JSON and the CDN files read it`;
      }
      if (isObject(v)) { const p = dotted(v, name); if (p) return p; }
    }
    return null;
  };
  const d = dotted(ctx, '');
  if (d) return d;
  for (const [k, v] of Object.entries(ctx)) {
    if (dims.includes(k) || (Object.hasOwn(snap.fields, k) && k !== ENTITY_FIELD)) continue;
    if (k === ENTITY_FIELD) return `"${ENTITY_FIELD}" isn’t read from the context: ${byDimension}`;
    if (typeof v === 'string' && dims.some((dim) => looksLikeDimension(k, dim))) return `"${k}" isn’t a dimension: ${byDimension}`;
  }
  return null;
}

/** Which entity asks, from the evaluation context and the key (see the top of this file). */
export function askingEntity(snap: Snapshot, p: Pick<Principal, 'scope' | 'entity'>, ctx: Json): string | null {
  const named = snap.dimensions.filter((d) => !missing(ctx[d]));
  if (!named.length) {
    if (p.entity && !Object.hasOwn(snap.entities, p.entity)) throw new OfrepError(403, 'GENERAL', `this key’s entity "${p.entity}" is gone`);
    return p.entity;
  }
  const lowest = named[named.length - 1];
  const key = String(ctx[lowest]);
  const info = Object.hasOwn(snap.entities, key) ? snap.entities[key] : null;
  // An entity that doesn't exist and one the credential can't ask about get the same answer, so a credential for some
  // entities only (every app's token is one) can't be used to find out which entities exist. It is the context that is
  // wrong, not the credential: a 400, which OpenFeature's providers report for this evaluation. A 401 or 403 stops the
  // web provider for good, so those are kept for a wrong credential and for a backend's key in a browser.
  const unknown = () => new OfrepError(400, 'INVALID_CONTEXT', `"${key}" isn’t an entity this key can ask about`);
  if (!info || info.dimension !== lowest || !mayAsk(p, key, info.path)) throw unknown();
  for (const d of named) {
    if (info.at[d] !== String(ctx[d])) throw new OfrepError(400, 'INVALID_CONTEXT', `${lowest} "${key}" isn’t under ${d} "${String(ctx[d])}"`);
  }
  return key;
}

/** What every answer to one request says about itself (OpenFeature's flagMetadata): which entity asked, and for a
 *  backend's secret key, the rule that decided. The publish (`revision`) is added apart, see `withRevision`. */
type Said = { entity: string | null; rules: boolean };

/** One flag's answer in OFREP's words. A flag that uses the app's code default has no value: the provider then returns
 *  the default written in the app (OFREP's codeDefaultFlag). */
function answer(r: EvalResult, said: Said): Json {
  if (r.errorCode) return { key: r.key, errorCode: r.errorCode === 'FLAG_NOT_FOUND' ? 'FLAG_NOT_FOUND' : 'GENERAL', errorDetails: r.errorDetails ?? r.errorCode };
  // the variant's name, unless it's an inner one: a typed-in value (val-…) or the code default
  const variant = r.variant && !r.codeDefault && !r.variant.startsWith(HIDDEN_PREFIX) ? { variant: r.variant } : {};
  const metadata: Record<string, string | number | boolean> = {
    ...(said.entity ? { entity: said.entity } : {}),
    ...(said.rules && r.decidedBy.ruleKey ? { ruleKey: r.decidedBy.ruleKey } : {}),
    ...(r.group ? { group: r.group } : {}),
  };
  return { key: r.key, reason: r.reason, ...variant, ...(r.codeDefault ? {} : { value: r.value }), metadata };
}
/** The answer with the publish that answered in its metadata (not for errors, which have none). */
const withRevision = (a: Json, revision: number): Json => (isObject(a.metadata) ? { ...a, metadata: { revision, ...a.metadata } } : a);

/** If-None-Match matches this ETag: weakly, any of a list, or `*`. */
const matches = (header: string | undefined, etag: string) => !!header && header.split(',').some((t) => {
  const v = t.trim();
  return v === '*' || v.replace(/^W\//, '') === etag.replace(/^W\//, '');
});

// ---------------------------------------------------------------- whose answers a publish changed
// A change event wakes only the streams whose answers may have changed, worked out from the snapshot before and after
// the publish (both are in memory): a flag's settings for everyone, its variants or its services change what every
// entity of those services gets; an entity's own settings change what it and the entities under it get; an entity
// moved or gone changes its own. A new entity changes nobody's: no stream is for it yet. When nothing in the snapshot
// changed (a replaced app link, a flag's description), every stream of the environment hears it, as before.
/** Whether a publish may have changed the answers of this service for this entity (null: for no entity). */
export type Reach = (service: string, entity: string | null) => boolean;
const EVERYONE: Reach = () => true;
const flagJson = new WeakMap<FlagDef, string>();
const jsonOf = (f: FlagDef) => { let s = flagJson.get(f); if (s === undefined) flagJson.set(f, (s = JSON.stringify(f))); return s; };
const own = <T,>(o: Record<string, T>, k: string): T | undefined => (Object.hasOwn(o, k) ? o[k] : undefined);

export function whoseAnswersChanged(prev: Snapshot | undefined, next: Snapshot): Reach {
  if (!prev || prev === next) return EVERYONE;
  if (JSON.stringify(prev.dimensions) !== JSON.stringify(next.dimensions) || JSON.stringify(prev.fields) !== JSON.stringify(next.fields)) return EVERYONE;
  let visible = false;
  const services = new Set<string>();                 // every entity of these services
  const owners = new Map<string, Set<string>>();      // service → entities whose own settings changed
  for (const key of new Set([...Object.keys(prev.flags), ...Object.keys(next.flags)])) {
    const [a, b] = [own(prev.flags, key), own(next.flags, key)];
    if (a === b || (a && b && jsonOf(a) === jsonOf(b))) continue;
    visible = true;
    const reached = new Set([...(a?.delivery ?? []), ...(b?.delivery ?? [])]);
    if (!a || !b || JSON.stringify({ ...a, entities: null }) !== JSON.stringify({ ...b, entities: null })) {
      for (const s of reached) services.add(s);
      continue;
    }
    for (const e of new Set([...Object.keys(a.entities), ...Object.keys(b.entities)])) {
      if (JSON.stringify(own(a.entities, e)) === JSON.stringify(own(b.entities, e))) continue;
      for (const s of reached) {
        let set = owners.get(s);
        if (!set) owners.set(s, (set = new Set()));
        set.add(e);
      }
    }
  }
  const moved = new Set<string>();                    // entities whose place changed, or that are gone
  for (const key of new Set([...Object.keys(prev.entities), ...Object.keys(next.entities)])) {
    const [a, b] = [own(prev.entities, key), own(next.entities, key)];
    if (a && b && a.name === b.name && a.dimension === b.dimension && a.path.join('/') === b.path.join('/')) continue;
    visible = true;
    if (a && (!b || a.dimension !== b.dimension || a.path.join('/') !== b.path.join('/'))) moved.add(key);
  }
  if (!visible) return EVERYONE;
  return (service, entity) => {
    if (services.has(service)) return true;
    if (!entity) return false;
    const path = [...(own(next.entities, entity)?.path ?? [entity]), ...(own(prev.entities, entity)?.path ?? [])];
    if (path.some((k) => moved.has(k))) return true;
    const changed = owners.get(service);
    return !!changed && path.some((k) => changed.has(k));
  };
}

type Asker = Pick<Principal, 'environment' | 'project' | 'scope' | 'entity' | 'kind'>;
/** An open change-event stream: for one service and entity (entity null: for no entity), or, from an answer before
 *  streams had a scope, for the whole environment (service null). */
type Stream = { write: (text: string) => void; close: () => void; service: string | null; entity: string | null };

export function ofrepApi({ db, plane, keys, links, apps, hub, env = process.env }: {
  db: Db; plane: Snapshots; keys: KeyCache; links: LinkCache; apps: AppCache; hub: Pick<EventHub, 'subscribe'>;
  /** FF_EVENT_STREAMS_PER_ENVIRONMENT, FF_EVENT_STREAMS_PER_CLIENT, and the proxies (FF_TRUSTED_PROXIES, FF_CLIENT_IP_HEADER) */
  env?: Readonly<Record<string, string | undefined>>;
}) {
  const app = new Hono();
  const limits = streamLimitsFrom(env);
  const clientAddress = clientAddressFor(authSettingsFromEnv(env as NodeJS.ProcessEnv));
  // Browsers call it from the app's own origin, with the key in a header and no cookies.
  app.use('/ofrep/*', cors({
    origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Authorization', 'Content-Type', 'If-None-Match', 'X-API-Key'],
    exposeHeaders: ['ETag'], maxAge: 86400,
  }));

  /** Who the credential is: an app's link token, or a backend's API key. Every wrong token gets the same answer. */
  async function credential(c: Context): Promise<Asker> {
    const raw = c.req.header('authorization')?.replace(/^Bearer\s+/i, '').trim() || c.req.header('x-api-key')?.trim();
    const t = raw ? readAppToken(raw) : null;
    if (!t) return authenticate(db, { authorization: raw ? `Bearer ${raw}` : undefined, origin: c.req.header('origin') }, keys);
    const wrong = () => new HttpError(401, 'unknown or replaced app link');
    const snap = plane.snapshots.get(t.environment);
    if (!snap || !Object.hasOwn(snap.entities, t.entity)) throw wrong();
    const l = await links.get(db);
    const envSecret = l.envs.get(t.environment);
    const v = l.versions.get(t.entity);
    if (!envSecret || v === undefined || !sameSecret(t.secret, appTokenSecret(envSecret, t.app, t.entity, v))) throw wrong();
    try { await ensureClientApp(db, apps, t.app); } catch { throw wrong(); }
    return { environment: t.environment, project: t.app, scope: 'entity', entity: t.entity, kind: 'client' };
  }

  // Catching up with a publish another server made: one look at the database per environment at a time, and a rebuild
  // only when it is ahead, so a made-up revision costs one small query.
  const catchingUp = new Map<string, Promise<Snapshot | undefined>>();
  function caughtUp(environment: string, revision: number): Promise<Snapshot | undefined> {
    const cur = plane.snapshots.get(environment);
    if (!plane.refresh || !cur || cur.revision >= revision) return Promise.resolve(cur);
    let p = catchingUp.get(environment);
    if (!p) {
      p = (async () => {
        const row = (await db.query<{ revision: string }>(`select revision from environment where key = $1`, [environment])).rows[0];
        const now = plane.snapshots.get(environment);
        return row && now && Number(row.revision) > now.revision ? plane.refresh!(db, environment) : now;
      })().finally(() => catchingUp.delete(environment));
      catchingUp.set(environment, p);
    }
    return p;
  }

  /** The credential, the snapshot of its environment, the asking entity and the attributes, from the request. */
  async function request(c: Context) {
    const p = await credential(c);
    let snap = plane.snapshots.get(p.environment);
    if (!snap) throw new Error(`no snapshot for ${p.environment}`);
    // the revision a change event named (flagConfigEtag): this server catches up with it first
    const heard = /^\d{1,15}$/.test(c.req.query('flagConfigEtag') ?? '') ? Number(c.req.query('flagConfigEtag')) : null;
    if (heard !== null && heard > snap.revision) snap = (await caughtUp(p.environment, heard)) ?? snap;
    let body: unknown;
    try { body = await c.req.json(); } catch { throw new OfrepError(400, 'PARSE_ERROR', 'the body isn’t JSON'); }
    if (!isObject(body) || !isObject(body.context)) throw new OfrepError(400, 'INVALID_CONTEXT', 'the body needs a context: {"context": {…}}');
    const { targetingKey, ...rest } = body.context;
    const problem = contextProblem(snap, rest);
    if (problem) throw new OfrepError(400, 'INVALID_CONTEXT', problem);
    const entity = askingEntity(snap, p, rest);
    const attrs = flattenContext(rest);
    if (!missing(targetingKey) && missing(attrs['device.id'])) attrs['device.id'] = String(targetingKey);
    const said: Said = { entity, rules: p.kind === 'server' };
    return { p, snap, entity, said, ctx: contextFor(snap, { project: p.project, entity }, attrs, { trust: 'app' }) };
  }

  const failed = (c: Context, e: unknown, key?: string) => {
    if (!(e instanceof OfrepError)) throw e;
    c.header('Cache-Control', 'no-store');
    return c.json({ ...(key ? { key } : {}), errorCode: e.errorCode, errorDetails: e.message }, e.status);
  };

  // The change-event stream for one service and entity (or none), signed with the environment's secret.
  const streamUri = (environment: string, envSecret: string, service: string, entity: string | null) =>
    `/ofrep/v1/events/${encodeURIComponent(environment)}/${encodeURIComponent(service)}${entity ? `/${encodeURIComponent(entity)}` : ''}/${eventsSignature(envSecret, service, entity)}`;

  app.post('/ofrep/v1/evaluate/flags', async (c) => {
    let r: Awaited<ReturnType<typeof request>>;
    try { r = await request(c); } catch (e) { return failed(c, e); }
    const flags = sortedFlagKeys(r.snap)
      .filter((k) => r.snap.flags[k].delivery.includes(r.p.project))
      .map((k) => answer(evaluate(r.snap, k, r.ctx, false), r.said));
    const envSecret = (await links.get(db)).envs.get(r.snap.environment);
    const uri = envSecret ? streamUri(r.snap.environment, envSecret, r.p.project, r.entity) : '';
    // The ETag covers the answers and the stream they listen to, not the publish's revision: a publish that changes
    // nothing for this context is a 304, and an answer for another entity or service (its own stream) never is.
    const etag = `W/"${shortHash(`${JSON.stringify(flags)}\n${uri}`)}"`;
    c.header('ETag', etag);
    c.header('Cache-Control', 'private, no-cache');
    if (matches(c.req.header('if-none-match'), etag)) return c.body(null, 304);
    const eventStreams = uri ? [{ type: 'sse', endpoint: { requestUri: uri }, inactivityDelaySec: EVENTS_INACTIVITY_SEC }] : [];
    const metadata = { environment: r.snap.environment, revision: r.snap.revision, ...(r.entity ? { entity: r.entity } : {}) };
    return c.body(`{"flags":${JSON.stringify(flags.map((a) => withRevision(a, r.snap.revision)))},"metadata":${JSON.stringify(metadata)},"eventStreams":${JSON.stringify(eventStreams)}}`,
      200, { 'Content-Type': 'application/json' });
  });

  // Change events for client providers: one "refetchEvaluation" per publish that may change a stream's answers, with
  // its revision as the etag (the provider sends it back as flagConfigEtag). One heartbeat timer for every stream keeps
  // proxies from closing them; it runs while any is open.
  const open = new Map<string, Set<Stream>>();
  const perClient = new Map<string, number>();
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  // the snapshot each environment's streams last heard about: the next publish is compared with it
  const heardOf = new Map<string, Snapshot>(plane.snapshots);
  hub.subscribe((environment, revision) => {
    const now = plane.snapshots.get(environment);
    const reach = now ? whoseAnswersChanged(heardOf.get(environment), now) : EVERYONE;
    if (now) heardOf.set(environment, now);
    const data = `data: ${JSON.stringify({ type: 'refetchEvaluation', etag: String(revision) })}\n\n`;
    for (const s of open.get(environment) ?? []) if (s.service === null || reach(s.service, s.entity)) s.write(data);
  });
  const opened = (environment: string, client: string, s: Stream) => {
    let set = open.get(environment);
    if (!set) open.set(environment, set = new Set());
    set.add(s);
    perClient.set(client, (perClient.get(client) ?? 0) + 1);
    heartbeat ??= setInterval(() => { for (const set of open.values()) for (const s of set) s.write(': heartbeat\n\n'); }, HEARTBEAT_MS);
    heartbeat.unref?.();
  };
  const closed = (environment: string, client: string, s: Stream) => {
    const set = open.get(environment);
    if (set?.delete(s) && !set.size) open.delete(environment);
    const n = (perClient.get(client) ?? 1) - 1;
    if (n > 0) perClient.set(client, n); else perClient.delete(client);
    if (!open.size && heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  };

  const listen = async (c: Context, environment: string, signature: string, scope: { service: string | null; entity: string | null }) => {
    const envSecret = (await links.get(db)).envs.get(environment);
    const right = envSecret && (scope.service === null ? eventsSignature(envSecret) : eventsSignature(envSecret, scope.service, scope.entity));
    if (!right || !sameSecret(signature, right)) return c.json({ error: 'no such event stream' }, 404);
    const connection = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
    const client = clientAddress(c.req.raw.headers, connection) ?? '';
    if ((open.get(environment)?.size ?? 0) >= limits.perEnvironment || (perClient.get(client) ?? 0) >= limits.perClient) {
      c.header('Retry-After', '60');
      c.header('Cache-Control', 'no-store');
      return c.json({ error: 'too many open event streams: ask for flags without one, or try again later' }, 429);
    }
    c.header('Cache-Control', 'no-store');
    c.header('X-Accel-Buffering', 'no');
    let end = () => {};
    const ended = new Promise<void>((resolve) => { end = resolve; });
    const s: Stream = { write: () => {}, close: () => end(), ...scope };
    opened(environment, client, s);       // counted now, so streams opened at the same moment can't pass the limit
    return streamSSE(c, async (stream) => {
      s.write = (text) => { stream.write(text).catch(() => end()); };
      stream.onAbort(() => end());
      try {
        if (!stream.aborted) {
          await stream.write(': connected\n\n');
          await ended;
        }
      } finally {
        closed(environment, client, s);
      }
    });
  };
  app.get('/ofrep/v1/events/:env/:signature', (c) => listen(c, c.req.param('env'), c.req.param('signature'), { service: null, entity: null }));
  app.get('/ofrep/v1/events/:env/:service/:signature', (c) =>
    listen(c, c.req.param('env'), c.req.param('signature'), { service: c.req.param('service'), entity: null }));
  app.get('/ofrep/v1/events/:env/:service/:entity/:signature', (c) =>
    listen(c, c.req.param('env'), c.req.param('signature'), { service: c.req.param('service'), entity: c.req.param('entity') }));

  app.post('/ofrep/v1/evaluate/flags/:key', async (c) => {
    const key = c.req.param('key');
    let r: Awaited<ReturnType<typeof request>>;
    try { r = await request(c); } catch (e) { return failed(c, e, key); }
    const a = withRevision(answer(evaluate(r.snap, key, r.ctx, false), r.said), r.snap.revision);
    c.header('Cache-Control', 'no-store');
    if (a.errorCode === 'FLAG_NOT_FOUND') {
      // "not in this service" and "no such flag" apart, for a backend's secret key only: an app's key may see its own
      // service's flags, not which others exist
      const service = r.p.project;
      a.errorDetails = !r.said.rules ? `no flag "${key}" in service "${service}": check its key, and that the flag is sent to this service`
        : Object.hasOwn(r.snap.flags, key) ? `the flag "${key}" isn’t sent to service "${service}": add the service on the flag’s Settings tab`
          : `no flag "${key}" in environment "${r.snap.environment}"`;
      return c.json(a, 404);
    }
    if (a.errorCode) return c.json(a, 400);
    return c.json(a);
  });

  return app;
}
