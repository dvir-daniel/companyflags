// OpenFeature Remote Evaluation Protocol (OFREP 0.4, github.com/open-feature/protocol), so apps and backends use
// OpenFeature's own providers: the OFREP web provider (browsers, React), the Kotlin and Swift providers (Android, iOS)
// and the server providers. No SDK of ours.
//
//   POST /ofrep/v1/evaluate/flags          every flag sent to the key's app, for one context (client providers):
//                                          one ETag for the answer, If-None-Match → 304
//   POST /ofrep/v1/evaluate/flags/:key     one flag, for a context per request (server providers)
//   GET  /ofrep/v1/events/:env/:signature  server-sent events: "refetchEvaluation" on every publish in the environment.
//                                          The bulk answer lists it (eventStreams), so client providers stop polling.
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
// The rest of the context is what the device or request knows about itself, nested or dotted ({"app": {"version":
// "6.0.0"}} is app.version). `targetingKey` is the device ID that a % of devices is by, unless `device.id` is given.

import { createHmac } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { HttpError, type Db } from './db.ts';
import { appTokenSecret, authenticate, mayAsk, sameSecret, type KeyCache, type Principal } from './auth.ts';
import { ensureClientApp, readAppToken, shortHash, type AppCache, type LinkCache } from './delivery.ts';
import { contextFor, evaluate, HIDDEN_PREFIX, sortedFlagKeys, type EvalResult, type Snapshot } from './evaluator.ts';
import type { EventHub } from './events.ts';
import type { Snapshots } from './plugin.ts';

/** The events stream's address for an environment carries a signature made with the environment's secret, so only
 *  someone given it in an answer (a valid credential for that environment) can listen. It says only that the
 *  environment published, never what. */
const eventsSignature = (envSecret: string) => createHmac('sha256', envSecret).update('ofrep-events').digest('base64url').slice(0, 22);
const EVENTS_INACTIVITY_SEC = 120;
const HEARTBEAT_MS = 25_000;

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
  // A credential for some entities only (every app's token is one) gets the same answer for an entity that doesn't
  // exist as for one it can't ask about, so it can't be used to find out which entities exist.
  const cantAsk = () => new OfrepError(403, 'GENERAL', `this key can’t ask about "${key}"`);
  if (!info || info.dimension !== lowest) throw p.scope === 'all' ? new OfrepError(400, 'INVALID_CONTEXT', `no ${lowest} "${key}"`) : cantAsk();
  if (!mayAsk(p, key, info.path)) throw cantAsk();
  for (const d of named) {
    if (info.at[d] !== String(ctx[d])) throw new OfrepError(400, 'INVALID_CONTEXT', `${lowest} "${key}" isn’t under ${d} "${String(ctx[d])}"`);
  }
  return key;
}

/** One flag's answer in OFREP's words. A flag that uses the app's code default has no value: the provider then returns
 *  the default written in the app (OFREP's codeDefaultFlag). */
function answer(r: EvalResult): Json {
  if (r.errorCode) return { key: r.key, errorCode: r.errorCode === 'FLAG_NOT_FOUND' ? 'FLAG_NOT_FOUND' : 'GENERAL', errorDetails: r.errorDetails ?? r.errorCode };
  // the variant's name, unless it's an inner one: a typed-in value (val-…) or the code default
  const variant = r.variant && !r.codeDefault && !r.variant.startsWith(HIDDEN_PREFIX) ? { variant: r.variant } : {};
  const metadata = r.group ? { metadata: { group: r.group } } : {};
  return { key: r.key, reason: r.reason, ...variant, ...(r.codeDefault ? {} : { value: r.value }), ...metadata };
}

/** If-None-Match matches this ETag: weakly, any of a list, or `*`. */
const matches = (header: string | undefined, etag: string) => !!header && header.split(',').some((t) => {
  const v = t.trim();
  return v === '*' || v.replace(/^W\//, '') === etag.replace(/^W\//, '');
});

type Asker = Pick<Principal, 'environment' | 'project' | 'scope' | 'entity'>;

export function ofrepApi({ db, plane, keys, links, apps, hub }: {
  db: Db; plane: Snapshots; keys: KeyCache; links: LinkCache; apps: AppCache; hub: Pick<EventHub, 'subscribe'>;
}) {
  const app = new Hono();
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
    return { environment: t.environment, project: t.app, scope: 'entity', entity: t.entity };
  }

  /** The credential, the snapshot of its environment, the asking entity and the attributes, from the request. */
  async function request(c: Context) {
    const p = await credential(c);
    const snap = plane.snapshots.get(p.environment);
    if (!snap) throw new Error(`no snapshot for ${p.environment}`);
    let body: unknown;
    try { body = await c.req.json(); } catch { throw new OfrepError(400, 'PARSE_ERROR', 'the body isn’t JSON'); }
    if (!isObject(body) || !isObject(body.context)) throw new OfrepError(400, 'INVALID_CONTEXT', 'the body needs a context: {"context": {…}}');
    const { targetingKey, ...rest } = body.context;
    const entity = askingEntity(snap, p, rest);
    const attrs = flattenContext(rest);
    if (!missing(targetingKey) && missing(attrs['device.id'])) attrs['device.id'] = String(targetingKey);
    return { p, snap, ctx: contextFor(snap, { project: p.project, entity }, attrs, { trust: 'app' }) };
  }

  const failed = (c: Context, e: unknown, key?: string) => {
    if (!(e instanceof OfrepError)) throw e;
    c.header('Cache-Control', 'no-store');
    return c.json({ ...(key ? { key } : {}), errorCode: e.errorCode, errorDetails: e.message }, e.status);
  };

  app.post('/ofrep/v1/evaluate/flags', async (c) => {
    let r: Awaited<ReturnType<typeof request>>;
    try { r = await request(c); } catch (e) { return failed(c, e); }
    const flags = sortedFlagKeys(r.snap)
      .filter((k) => r.snap.flags[k].delivery.includes(r.p.project))
      .map((k) => answer(evaluate(r.snap, k, r.ctx, false)));
    const content = JSON.stringify(flags);
    const etag = `W/"${shortHash(content)}"`;
    c.header('ETag', etag);
    c.header('Cache-Control', 'private, no-cache');
    if (matches(c.req.header('if-none-match'), etag)) return c.body(null, 304);
    const envSecret = (await links.get(db)).envs.get(r.snap.environment);
    const eventStreams = envSecret ? [{ type: 'sse', endpoint: { requestUri: `/ofrep/v1/events/${encodeURIComponent(r.snap.environment)}/${eventsSignature(envSecret)}` },
      inactivityDelaySec: EVENTS_INACTIVITY_SEC }] : [];
    return c.body(`{"flags":${content},"metadata":${JSON.stringify({ environment: r.snap.environment })},"eventStreams":${JSON.stringify(eventStreams)}}`,
      200, { 'Content-Type': 'application/json' });
  });

  // Change events for client providers: one "refetchEvaluation" per publish in the environment, with its revision as
  // the etag (the provider sends it back as flagConfigEtag). Heartbeats keep proxies from closing the stream.
  app.get('/ofrep/v1/events/:env/:signature', async (c) => {
    const { env, signature } = c.req.param();
    const envSecret = (await links.get(db)).envs.get(env);
    if (!envSecret || !sameSecret(signature, eventsSignature(envSecret))) return c.json({ error: 'no such event stream' }, 404);
    c.header('Cache-Control', 'no-store');
    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (stream) => {
      let open = true;
      let wake = () => {};
      const off = hub.subscribe((environment, revision) => {
        if (environment === env) stream.writeSSE({ data: JSON.stringify({ type: 'refetchEvaluation', etag: String(revision) }) }).catch(() => {});
      });
      stream.onAbort(() => { open = false; wake(); });
      try {
        await stream.write(': connected\n\n');
        while (open) {
          await new Promise<void>((resolve) => { const t = setTimeout(resolve, HEARTBEAT_MS); wake = () => { clearTimeout(t); resolve(); }; });
          if (open) await stream.write(': heartbeat\n\n');
        }
      } finally {
        off();
      }
    });
  });

  app.post('/ofrep/v1/evaluate/flags/:key', async (c) => {
    const key = c.req.param('key');
    let r: Awaited<ReturnType<typeof request>>;
    try { r = await request(c); } catch (e) { return failed(c, e, key); }
    const a = answer(evaluate(r.snap, key, r.ctx, false));
    c.header('Cache-Control', 'no-store');
    if (a.errorCode === 'FLAG_NOT_FOUND') return c.json(a, 404);
    if (a.errorCode) return c.json(a, 400);
    return c.json(a);
  });

  return app;
}
