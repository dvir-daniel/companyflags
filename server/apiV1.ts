// The stable HTTP API: /api/v1, for scripts and integrations (docs/reference/http-api.md says exactly what it holds).
// Breaking changes to it come only in a /api/v2. The rest of /api is the console's own and may change in any release.
//
//   GET  /api/v1/environments                                     the environments
//   GET  /api/v1/services                                         the services, kind app or backend
//   GET  /api/v1/environments/:env/flags                          the flags in an environment
//   GET  /api/v1/environments/:env/flags/:key                     one flag there, with its defaults (to publish)
//   PUT  /api/v1/environments/:env/flags/:key/enabled             turn it on or off there
//   POST /api/v1/environments/:env/publish                        several changes at once, as one version (or a request)
//   GET  /api/v1/history                                          History, newest first
//   GET  /api/v1/dimensions/:dimension/entities                   a dimension's entities
//   PUT  /api/v1/dimensions/:dimension/entities/:key              add an entity, or change its name or parent
//
// The same rules as the console's: who is asking (a cfp_ access token, or the console's sign-in) and what their role
// lets them do, approvals where an environment needs them, and History for every change. One contract throughout:
//   - an error is { error, code }: the sentence, and a stable code (db.ts ERROR_CODES);
//   - a list takes ?limit (1–200, default 50) and ?cursor, and answers { items, next }: next is the cursor of the next
//     page, null on the last;
//   - the environment is in the address, never a default; a service is a "service" everywhere.

import { Hono } from 'hono';
import { all, HttpError, one, type Db } from './db.ts';
import { jsonBody } from './http.ts';
import type { Person } from './access.ts';
import type { TokenPerson } from './tokens.ts';
import { HIDDEN_PREFIX, CODE_DEFAULT } from './evaluator.ts';
import { historyFilter, historyPage } from './history.ts';
import { submitChange, type Item, type LayerDoc, type Submitted } from './layers.ts';
import { loadLayers } from './snapshot.ts';
import { upsertEntity } from './control.ts';
import { entityKeyProblem } from './checks.ts';
import { likePattern } from './listing.ts';

type V1 = Hono<{ Variables: { user: Person } }>;

export const V1_LIMIT = 50;
export const V1_MAX = 200;

/** A page's size and where it starts: ?limit and ?cursor. A cursor is opaque to callers (base64url JSON). */
function paging(c: { req: { query: (k: string) => string | undefined } }): { limit: number; after: unknown } {
  const l = c.req.query('limit');
  const limit = l === undefined ? V1_LIMIT : Number(l);
  if (!Number.isInteger(limit) || limit < 1 || limit > V1_MAX) throw new HttpError(400, `limit: a whole number from 1 to ${V1_MAX}`, {}, 'bad_request');
  const cursor = c.req.query('cursor');
  if (!cursor) return { limit, after: null };
  try {
    return { limit, after: (JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { a: unknown }).a };
  } catch {
    throw new HttpError(400, 'cursor: send back the `next` of the page before, as it came', {}, 'bad_request');
  }
}
const cursorOf = (after: unknown) => Buffer.from(JSON.stringify({ a: after }), 'utf8').toString('base64url');

/** { items, next }: `rows` holds one more than the page when there is a next page. */
function page<T>(rows: T[], limit: number, keyOf: (row: T) => unknown) {
  const items = rows.slice(0, limit);
  return { items, next: rows.length > limit ? cursorOf(keyOf(items[items.length - 1])) : null };
}

const kindWord = (k: string) => (k === 'client' ? 'app' : 'backend');

/** The submit answer, in this API's words: applied now (with the version), or a request waiting for review. */
const submitted = (r: Submitted) => (r.applied
  ? { applied: true, revision: r.revision, ...(r.bypass ? { breakGlass: true } : {}) }
  : { applied: false, request: r.changeSetId });

export function v1Routes({ db }: { db: Db }): V1 {
  const app = new Hono<{ Variables: { user: Person } }>();
  const actor = (u: Person) => ({ name: u.key, type: (u as Partial<TokenPerson>).token?.agent ? 'agent' as const : 'user' as const });
  const environment = async (key: string) => {
    const e = await one<{ id: number; key: string }>(db, `select id, key from environment where key = $1`, [key]);
    if (!e) throw new HttpError(404, `no environment “${key}”`, {}, 'not_found');
    return e;
  };

  app.get('/environments', async (c) => {
    const { limit, after } = paging(c);
    const rows = await all<{ key: string; name: string; approvals: number }>(db, `select key, name, min_approvals as approvals from environment
      where ($1::text is null or key > $1) order by key limit $2`, [after, limit + 1]);
    return c.json(page(rows, limit, (r) => r.key));
  });

  app.get('/services', async (c) => {
    const { limit, after } = paging(c);
    const rows = await all<{ key: string; kind: string }>(db, `select key, kind from project where ($1::text is null or key > $1) order by key limit $2`, [after, limit + 1]);
    return c.json(page(rows.map((r) => ({ key: r.key, kind: kindWord(r.kind) })), limit, (r) => r.key));
  });

  // The flags, by key, without archived ones. ?q= part of a key, name or tag.
  app.get('/environments/:env/flags', async (c) => {
    const env = await environment(c.req.param('env'));
    const { limit, after } = paging(c);
    const q = (c.req.query('q') ?? '').trim().toLowerCase();
    const rows = await all<FlagRow>(db, `${FLAG_SELECT}
      where f.archived_at is null and ($2::text is null or f.key > $2)
        and ($3 = '' or f.key like $4 or lower(coalesce(f.name, '')) like $4 or $3 = any(f.tags))
      order by f.key limit $5`, [env.id, after, q, likePattern(q), limit + 1]);
    return c.json(page(rows.map(flagOut), limit, (r) => r.key));
  });

  // One flag in an environment: what it is, whether it is on, its variants, and its defaults (`layer`, with its
  // `version`): a publish sends the layer back changed, with that version.
  app.get('/environments/:env/flags/:key', async (c) => {
    const env = await environment(c.req.param('env'));
    const f = await one<FlagRow & { id: string }>(db, `${FLAG_SELECT} where f.key = $2 and f.archived_at is null`, [env.id, c.req.param('key')]);
    if (!f) throw new HttpError(404, `no flag “${c.req.param('key')}”`, {}, 'not_found');
    const [variants, layers] = await Promise.all([
      all<{ key: string; value: unknown }>(db, `select key, value from flag_variation where flag_id = $1 and not is_code_default order by id`, [f.id]),
      loadLayers(db, env.id, [f.id]),
    ]);
    const base = layers.find((l) => l.entityKey === null)?.layer as (LayerDoc & { version: number; updatedAt?: unknown; updatedBy?: unknown }) | undefined;
    const { updatedAt: _a, updatedBy: _b, ...layer } = base ?? ({} as Record<string, unknown>);
    return c.json({
      ...flagOut(f),
      variants: variants.filter((v) => !v.key.startsWith(HIDDEN_PREFIX) && v.key !== CODE_DEFAULT),
      layer: base ? layer : null,
    });
  });

  // On or off in one environment: { "enabled": false, "reason": "…" }. Where the environment needs approval, a request
  // for review (202), as in the console; the reason goes to the reviewer.
  app.put('/environments/:env/flags/:key/enabled', async (c) => {
    const env = await environment(c.req.param('env'));
    const body = await jsonBody<{ enabled?: unknown; reason?: unknown }>(c);
    if (typeof body.enabled !== 'boolean') throw new HttpError(422, 'enabled: true or false', {}, 'invalid');
    if (body.reason !== undefined && typeof body.reason !== 'string') throw new HttpError(422, 'reason: a sentence', {}, 'invalid');
    const f = await one<{ id: string }>(db, `select id from flag where key = $1 and archived_at is null`, [c.req.param('key')]);
    if (!f) throw new HttpError(404, `no flag “${c.req.param('key')}”`, {}, 'not_found');
    const base = (await loadLayers(db, env.id, [f.id])).find((l) => l.entityKey === null)?.layer as (LayerDoc & { version: number; updatedAt?: unknown; updatedBy?: unknown }) | undefined;
    if (!base) throw new HttpError(404, `no defaults for “${c.req.param('key')}” in ${env.key}`, {}, 'not_found');
    const { version, updatedAt: _a, updatedBy: _b, ...layer } = base;
    const item: Item = { flag: c.req.param('key'), entity: null, expectedLayerVersion: version, proposed: { ...layer, enabled: body.enabled } as LayerDoc };
    const r = await submitChange(db, env.key, [item], c.get('user'), { reason: body.reason as string | undefined });
    return c.json(submitted(r), r.applied ? 200 : 202);
  });

  // Several changes in one environment together: { items: [{ flag, entity, version, layer }], reason }. Each layer is
  // as GET …/flags/:key answers it (entity null: the flag's defaults), sent with the version it had; null removes an
  // entity's own settings.
  app.post('/environments/:env/publish', async (c) => {
    const env = await environment(c.req.param('env'));
    const body = await jsonBody<{ items?: unknown; reason?: unknown }>(c);
    if (!Array.isArray(body.items) || !body.items.length) throw new HttpError(422, 'items: the changes, [{ "flag": "…", "entity": null, "version": 3, "layer": { … } }]', {}, 'invalid');
    const items: Item[] = body.items.map((raw, i) => {
      const it = (raw ?? {}) as { flag?: unknown; entity?: unknown; version?: unknown; layer?: unknown; allowReshuffle?: unknown };
      if (typeof it.flag !== 'string') throw new HttpError(422, `items[${i}].flag: a flag’s key`, {}, 'invalid');
      if (it.entity !== null && it.entity !== undefined && typeof it.entity !== 'string') throw new HttpError(422, `items[${i}].entity: an entity’s key, or null`, {}, 'invalid');
      if (it.version !== null && it.version !== undefined && !Number.isInteger(it.version)) throw new HttpError(422, `items[${i}].version: the layer’s version as you read it, or null for a new one`, {}, 'invalid');
      if (it.layer !== null && (typeof it.layer !== 'object' || Array.isArray(it.layer))) throw new HttpError(422, `items[${i}].layer: the layer, or null to remove an entity’s own settings`, {}, 'invalid');
      const { version: _v, updatedAt: _a, updatedBy: _b, ...layer } = (it.layer ?? {}) as Record<string, unknown>;
      return { flag: it.flag, entity: (it.entity as string | null) ?? null, expectedLayerVersion: (it.version as number | null) ?? null,
        proposed: it.layer === null ? null : layer as LayerDoc, allowReshuffle: it.allowReshuffle === true };
    });
    const r = await submitChange(db, env.key, items, c.get('user'), { reason: typeof body.reason === 'string' ? body.reason : undefined });
    return c.json(submitted(r), r.applied ? 200 : 202);
  });

  // History, newest first: ?environment, ?flag, ?entity, ?by, ?type, ?from, ?to filter it, as in the console.
  app.get('/history', async (c) => {
    const { limit, after } = paging(c);
    if (after !== null && !Number.isSafeInteger(after)) throw new HttpError(400, 'cursor: send back the `next` of the page before, as it came', {}, 'bad_request');
    const f = historyFilter((k) => (k === 'before' || k === 'limit' || k === 'q' || k === 'revision' ? undefined : c.req.query(k)));
    const rows = await historyPage(db, f, after as number | null, limit + 1);
    const items = rows.map(({ changeSetId, actorType, ...r }) => ({ ...r, actor: actorType, request: changeSetId }));
    return c.json(page(items, limit, (r) => r.id));
  });

  app.get('/dimensions/:dimension/entities', async (c) => {
    const { limit, after } = paging(c);
    const d = await one<{ id: number }>(db, `select id from dimension where key = $1`, [c.req.param('dimension')]);
    if (!d) throw new HttpError(404, `no dimension “${c.req.param('dimension')}”`, {}, 'not_found');
    const rows = await all<{ key: string; name: string; parent: string | null }>(db, `select e.key, e.name, p.key as parent from entity e
      left join entity p on p.id = e.parent_id where e.dimension_id = $1 and e.archived_at is null and ($2::text is null or e.key > $2)
      order by e.key limit $3`, [d.id, after, limit + 1]);
    return c.json(page(rows, limit, (r) => r.key));
  });

  // Adds the entity, or changes its name or parent: { "name": "Acme Corp", "parent": null }. 201 when it's new.
  app.put('/dimensions/:dimension/entities/:key', async (c) => {
    const key = c.req.param('key');
    const body = await jsonBody<{ name?: unknown; parent?: unknown }>(c);
    if (typeof body.name !== 'string') throw new HttpError(422, 'name: the entity’s name, e.g. Acme Corp', {}, 'invalid');
    if (body.parent !== undefined && body.parent !== null && typeof body.parent !== 'string') throw new HttpError(422, 'parent: the key of the entity above it, or null', {}, 'invalid');
    const exists = await one<{ dimension: string }>(db, `select d.key as dimension from entity e join dimension d on d.id = e.dimension_id where e.key = $1`, [key]);
    if (exists && exists.dimension !== c.req.param('dimension')) {
      throw new HttpError(409, `“${key}” is taken already, by an entity in another dimension (keys are unique across every dimension)`, {}, 'already_exists');
    }
    if (!exists) {
      const problem = entityKeyProblem(key);
      if (problem) throw new HttpError(422, problem, {}, 'invalid');
    }
    const doc = { name: body.name, ...(body.parent !== undefined ? { parent: body.parent as string | null } : {}) };
    const r = await upsertEntity(db, c.req.param('dimension'), key, doc, actor(c.get('user')), !exists, c.get('user'));
    return c.json(r, exists ? 200 : 201);
  });

  return app;
}

type FlagRow = {
  key: string; name: string | null; description: string | null; kind: string; valueType: string; tags: string[]; owner: string | null;
  removeBy: string | null; enabled: boolean | null; services: string[];
};
// $1: the environment's id
const FLAG_SELECT = `select f.id, f.key, f.name, f.description, f.kind, f.value_type as "valueType", f.tags, f.owner, f.remove_by::text as "removeBy",
    bl.enabled, coalesce((select array_agg(p.key order by p.key) from flag_delivery d join project p on p.id = d.project_id
      where d.flag_id = f.id and d.environment_id = $1), '{}') as services
  from flag f left join flag_layer bl on bl.flag_id = f.id and bl.entity_id is null and bl.environment_id = $1`;
const flagOut = ({ key, name, description, kind, valueType, tags, owner, removeBy, enabled, services }: FlagRow) =>
  ({ key, name, description, kind, valueType, tags, owner, removeBy, enabled: !!enabled, services });
