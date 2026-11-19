// Console (control-plane) API. The sign-in (identity.ts: a Better Auth session cookie) says which email is asking;
// the access module (access.ts) says who that person is and what their role lets them do: viewers can look but not
// change anything, and settings (environments, apps, people, single sign-on) are for admins.
// Every change (any method but GET) must carry X-Requested-With: companyfeatures, which a page on another site can't
// send without the server's permission (CORS), and isn't accepted from a cross-site request at all (CSRF).

import { Hono } from 'hono';
import { stream, streamSSE } from 'hono/streaming';
import { all, HttpError, one, type Db } from './db.ts';
import type { Identity } from './identity.ts';
import { may, mustBeAllowed, type Access, type Person } from './access.ts';
import { serviceProvider, type SingleSignOn } from './sso.ts';
import type { Cdn } from './cdn.ts';
import { appToken, clientLink } from './delivery.ts';
import { addSampleData } from './demo.ts';
import { notRolledBack, RESTORABLE } from './journal.ts';
import { HISTORY_CSV_HEADER, historyBatches, historyCsv, historyFilter, historyPage } from './history.ts';
import {
  contextFor, entityChain, evaluate, forEntity, HIDDEN_PREFIX, CODE_DEFAULT, sortedFlagKeys, UnknownEntityError,
  type EntityInfo, type EvalContext, type FlagDef, type Snapshot,
} from './evaluator.ts';
import { mayApprove, type ChangeSetFacts } from './policy.ts';
import type { EventHub } from './events.ts';
import { fieldInfo, type FieldInfo } from './fields.ts';
import {
  applyChangeSet, cancelChangeSet, createChangeSet, restoreItems, reviewChangeSet, scheduleChangeSet, submitChange, summarizeLayers, versionsServed,
  type Actor, type Item, type LayerDoc,
} from './layers.ts';
import { entityKeyProblem, isVersionFlag } from './checks.ts';
import { overdue, readyToCleanUp, releaseState, stepText, type ReleaseState } from './release.ts';
import { DEFAULT_PAGE_SIZE, likePattern, listQuery, pageOf, searchHit } from './listing.ts';
import { entityWords, sourceText } from './words.ts';
import {
  addVersion, archiveFlag, updateFlagMeta, createApiKey, createEnvironment, createFlag, createProject, deleteProject, dimensionRows, revokeApiKey, rotateClientLink,
  saveDimensions, setDelivery, updateEnvironment, updateProject, upsertEntity, upsertVariations, type NewFlag,
} from './control.ts';
import { loadLayers, type DataPlane } from './snapshot.ts';

// `db` is the app's journaled database (journal.ts): what a change does after it commits (waking the publisher,
// forgetting cached links and keys, building a new environment's snapshot) happens there, not in the routes.
type Deps = { db: Db; plane: DataPlane; hub: EventHub; identity: Identity; access: Access; sso: SingleSignOn; cdn: Cdn };
type User = Person;

// The only POSTs a viewer may make: they run the evaluator and change nothing. Exact addresses: an entity or
// environment can't be called "trace" or "compare" (checks.ts RESERVED_KEYS), and nothing else ends this way.
const LOOK_ONLY = new Set(['POST /api/trace', 'POST /api/compare']);
/** The header the console sends with every change; a cross-site page can't add it (see the top of this file). */
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'companyfeatures';
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Per snapshot (a new publish makes a new one): what doesn't depend on who asks is worked out once.
const perSnapshot = <T,>() => new WeakMap<Snapshot, T>();
const entityCounts = perSnapshot<Map<string, number>>();                // entity → flags with its own settings
const childGrids = perSnapshot<Map<string, GridRow[]>>();               // entity → it and its children, side by side
const comparisons = new WeakMap<Snapshot, WeakMap<Snapshot, Map<string, CompareRow[]>>>();
const COMPARISONS_KEPT = 50;                                             // per pair of snapshots (attributes vary)
const sortedFlags = perSnapshot<FlagDef[]>();
const flagsOf = (snap: Snapshot) => {
  let list = sortedFlags.get(snap);
  if (!list) sortedFlags.set(snap, (list = sortedFlagKeys(snap).map((k) => snap.flags[k])));
  return list;
};
type Cell = { variant: string; value: unknown; codeDefault: boolean; section: string; cases: number; own: boolean };
type GridRow = { key: string; valueType: FlagDef['valueType']; enabled: boolean; cells: Record<string, Cell>; differs: string[] };
type Outcome = { sent: boolean; value: unknown; codeDefault: boolean; variant: string | null; source: string; rule: string | null; byDevice: boolean };
type CompareRow = { key: string; a: Outcome; b: Outcome; same: boolean };

export function consoleApi({ db, plane, hub, identity, access, sso, cdn }: Deps) {
  const app = new Hono<{ Variables: { user: User } }>();

  // who is asking, and may they change anything at all
  app.use('*', async (c, next) => {
    const who = await identity.who(c.req.raw.headers);
    if (who && !READS.has(c.req.method)) {
      // the sign-in is a cookie, which a browser sends whoever made the page: changes need proof
      // that the console made them
      if (c.req.header(CSRF_HEADER) !== CSRF_VALUE || c.req.header('sec-fetch-site') === 'cross-site') {
        throw new HttpError(403, `changes must come from the console (the ${CSRF_HEADER}: ${CSRF_VALUE} header, same site)`);
      }
      const body = await c.req.text();
      if (body) {
        try { JSON.parse(body); } catch { throw new HttpError(400, 'the request body isn’t valid JSON'); }
      }
    }
    const u = await access.signedIn(who);
    if (!READS.has(c.req.method) && !LOOK_ONLY.has(`${c.req.method} ${c.req.path}`)) mustBeAllowed(u, 'changes');
    c.set('user', u);
    await next();
  });
  // what only those who change things may see (secrets): not viewers
  const notViewer = (u: User, what: string) => { if (!may(u, 'changes')) throw new HttpError(403, `viewers can’t see ${what}: ask an admin for a role`); };
  // the in-memory snapshot of an environment (404 for one that doesn't exist)
  const snapshot = (env: string) => {
    const s = plane.snapshots.get(env);
    if (!s) throw new HttpError(404, `environment "${env}" not found`);
    return s;
  };
  const actor = (u: User): Actor => ({ name: u.key, type: 'user' });
  const adminOnly = (u: User) => mustBeAllowed(u, 'changesSettings');
  // when a request doesn't say which environment: the first one
  const firstEnv = async () => (await one<{ key: string }>(db, `select key from environment order by id limit 1`))?.key ?? '';

  // ------------------------------------------------------------ lists
  // Every list is paged and searched the same way (listing.ts). Without ?page the full list comes back.
  const query = (c: { req: { query: (k: string) => string | undefined } }) => listQuery((k) => c.req.query(k));
  // flag descriptions for searching in-memory lists; cached per publish so typing a search doesn't hit the database
  let descCache: { tick: string; map: Map<string, string | null> } | null = null;
  const descriptions = async () => {
    const tick = [...plane.snapshots].map(([k, v]) => `${k}@${v.revision}`).join(',');
    if (descCache?.tick !== tick) {
      descCache = { tick, map: new Map((await all<{ key: string; description: string | null }>(db,
        `select key, description from flag where archived_at is null`)).map((f) => [f.key, f.description])) };
    }
    return descCache.map;
  };
  // "Who is asking" for the console's simulations: same rules as real app requests (evaluator.ts)
  const simulate = (snap: Snapshot, project: string, entity: string | null, attrs: Record<string, unknown> | undefined): EvalContext => {
    try { return contextFor(snap, { project, entity }, attrs, { trust: 'console' }); }
    catch (e) { if (e instanceof UnknownEntityError) throw new HttpError(404, e.message); throw e; }
  };
  // the installation's dimensions, top to bottom, with how many entities each has
  const dimensionsNow = async () => (await dimensionRows(db)).map(({ key, singular, plural, entities, withParent }) => ({ key, singular, plural, entities, withParent }));

  // ------------------------------------------------------------ meta
  app.get('/meta', async (c) => {
    const [environments, projects, dimensions, entities, users, fieldRows, pending] = await Promise.all([
      all(db, `select key, name, min_approvals as "minApprovals", revision from environment order by id`),
      all(db, `select key, kind from project order by id`),
      dimensionsNow(),
      all(db, `select c.key, c.name, d.key as dimension, p.key as parent, c.created_at as "createdAt" from entity c
        join dimension d on d.id = c.dimension_id left join entity p on p.id = c.parent_id where c.archived_at is null order by c.name`),
      // with their status: invited until they use their invite link, removed once an admin removed their access,
      // no_account for people from before accounts who haven't made one (or been invited) yet
      access.people(),
      // the stored attributes, with their group, label and known values from fields.ts (code, not columns: no migration)
      all<Omit<FieldInfo, 'group' | 'label' | 'knownValues'>>(db, `select name, value_type as "valueType", comes_from as "comesFrom",
        can_split_by as "canSplitBy", description from condition_field order by name`),
      // requests waiting for a review, in every environment, with their reviews: the console's badge counts those
      // this person may approve (policy.ts mayApprove: not their own, not already approved by them as they are now)
      all<ChangeSetFacts>(db, `select cs.author, cs.status, coalesce((select json_agg(json_build_object('reviewer', r.reviewer,
          'decision', r.decision, 'current', r.for_content_hash = cs.content_hash)) from change_set_review r where r.change_set_id = cs.id), '[]') as reviews
        from change_set cs where cs.status = 'in_review'`),
    ]);
    const dataPlane = Object.fromEntries([...plane.snapshots].map(([k, s]) => [k, { revision: s.revision, builtAt: s.builtAt }]));
    const { removed: _, ...me } = c.get('user');
    const pendingApprovals = pending.filter((cs) => mayApprove(me, cs)).length;
    const fields = fieldRows.map((r) => fieldInfo(r, dimensions));
    return c.json({ me, signIn: identity.kind, environments, projects, dimensions, entities, users, fields, dataPlane, pendingApprovals });
  });

  // ------------------------------------------------------------ flags
  app.get('/flags', async (c) => {
    // one page for one environment (page 0 when no page is given): only these rows' delivery and status are loaded.
    // Filters: ?status=on|off (in this environment), ?kind=, ?owner=. Sort: ?sort=key|status|owner|kind|changed&dir=asc|desc.
    const pg = query(c) ?? { page: 0, size: DEFAULT_PAGE_SIZE, q: '' };
    const envKey = c.req.query('environment') ?? await firstEnv();
    const status = c.req.query('status') ?? '';
    const kind = c.req.query('kind') ?? '';
    const owner = c.req.query('owner') ?? '';
    const tag = c.req.query('tag') ?? '';
    const dir = c.req.query('dir') === 'desc' ? 'desc' : 'asc';
    const SORT: Record<string, string> = {
      key: 'f.key', status: 'coalesce(bl.enabled, false)', owner: `coalesce(f.owner, '')`, kind: 'f.kind', changed: 'changed.at',
    };
    const order = `${SORT[c.req.query('sort') ?? 'key'] ?? SORT.key} ${dir} nulls last, f.key`;
    // the counts need only the flag and its base layer here; the page also needs when it last changed (the lateral)
    const fromFlags = `from flag f
      left join environment env on env.key = $1
      left join flag_layer bl on bl.flag_id = f.id and bl.entity_id is null and bl.environment_id = env.id`;
    const from = `${fromFlags}
      left join lateral (select max(l.updated_at) as at, (array_agg(l.updated_by order by l.updated_at desc))[1] as by
        from flag_layer l where l.flag_id = f.id and l.environment_id = env.id) changed on true`;
    const search = `($2 = '' or f.key like $3 or lower(coalesce(f.description, '')) like $3 or lower(coalesce(f.name, '')) like $3
      or exists (select 1 from unnest(f.tags) t where t like $3))`;
    const filters = `f.archived_at is null and ${search}
      and ($4 = '' or coalesce(bl.enabled, false) = ($4 = 'on'))
      and ($5 = '' or f.kind = $5)
      and ($6 = '' or f.owner = $6)
      and ($7 = '' or $7 = any(f.tags))`;
    const args = [envKey, pg.q, likePattern(pg.q), status, kind, owner, tag];
    const [counts, rows, owners, tags] = await Promise.all([
      one<{ matched: string; all: string }>(db, `select count(*) filter (where ${filters}) as matched,
        count(*) filter (where f.archived_at is null) as all ${fromFlags}`, args),
      all<any>(db, `select f.id, f.key, f.name, f.tags, f.value_type as "valueType", f.kind, f.free_values as "freeValues", f.description, f.owner,
        f.remove_by::text as "removeBy", f.archived_at as "archivedAt", f.created_at as "createdAt",
        changed.at as "changedAt", changed.by as "changedBy"
        ${from} where ${filters} order by ${order} limit $8 offset $9`, [...args, pg.size, pg.page * pg.size]),
      all<{ owner: string }>(db, `select distinct owner from flag where archived_at is null and owner is not null order by owner`),
      all<{ tag: string }>(db, `select distinct unnest(tags) as tag from flag where archived_at is null order by 1`),
    ]);
    const ids = rows.map((r) => r.id);
    const [delivery, summaries, versions] = ids.length ? await Promise.all([
      all<{ flag_id: string; project: string }>(db, `select d.flag_id, p.key as project
        from flag_delivery d join project p on p.id = d.project_id join environment e on e.id = d.environment_id
        where e.key = $1 and d.flag_id = any($2::bigint[]) order by p.id`, [envKey, ids]),
      // every environment's state (the table shows a column per environment), and the version that last changed it here
      summarizeLayers(db, { flagIds: ids }),
      // one look per flag on the page, at its newest entry here (the index on flag, newest first), however long its history
      all<{ flag: string; rev: number }>(db, `select f.flag, (select h.revision::int from change_history h
          where h.flag = f.flag and h.environment_id = e.id and h.revision is not null order by h.id desc limit 1) as rev
        from unnest($2::text[]) as f(flag), environment e where e.key = $1`, [envKey, rows.map((r) => r.key)]),
    ]) : [[], [], []];
    const group = <T, K>(list: T[], key: (x: T) => K) => {
      const m = new Map<K, T[]>();
      for (const x of list) { const k = key(x); const l = m.get(k); if (l) l.push(x); else m.set(k, [x]); }
      return m;
    };
    const deliveryOf = group(delivery, (d) => String(d.flag_id));
    const summaryOf = group(summaries, (x) => x.flag);
    const versionOf = new Map(versions.map((v) => [v.flag, v.rev]));
    for (const f of rows) {
      f.delivery = { [envKey]: (deliveryOf.get(String(f.id)) ?? []).map((d) => d.project) };
      f.envs = Object.fromEntries((summaryOf.get(f.key) ?? []).map((l) => [l.env,
        { enabled: l.enabled, entityLayers: l.entityLayers, defaultVariation: l.defaultVariation, defaultValue: l.defaultValue, rules: l.rules }]));
      f.lastVersion = versionOf.get(f.key) ?? null;
      delete f.id;
    }
    return c.json({ rows, matched: Number(counts!.matched), all: Number(counts!.all), page: pg.page, size: pg.size,
      owners: owners.map((o) => o.owner), tags: tags.map((t) => t.tag) });
  });

  app.post('/flags', async (c) => {
    const body = await c.req.json<NewFlag>();
    return c.json(await createFlag(db, body, actor(c.get('user'))), 201);
  });

  app.get('/flags/:key', async (c) => {
    const f = await one<any>(db, `select id, key, name, tags, value_type as "valueType", kind, free_values as "freeValues", description, owner,
      remove_by::text as "removeBy", archived_at as "archivedAt", created_at as "createdAt" from flag where key = $1`, [c.req.param('key')]);
    if (!f) throw new HttpError(404, 'flag not found');
    // every environment at once: one query each for the variants, the environments, the deliveries and the layers
    const [variations, envs, sent, allLayers] = await Promise.all([
      all(db, `select key, value from flag_variation where flag_id = $1 and not is_code_default order by id`, [f.id]),
      all<{ id: number; key: string }>(db, `select id, key from environment order by id`),
      all<{ environment_id: number; key: string }>(db, `select d.environment_id, p.key from flag_delivery d join project p on p.id = d.project_id
        where d.flag_id = $1 order by p.id`, [f.id]),
      loadLayers(db, null, [f.id]),
    ]);
    const delivery: Record<string, string[]> = {};
    const layers: Record<string, unknown> = {};
    for (const e of envs) {
      delivery[e.key] = sent.filter((d) => Number(d.environment_id) === Number(e.id)).map((r) => r.key);
      const ls = allLayers.filter((l) => l.environmentId === Number(e.id));
      layers[e.key] = {
        base: ls.find((l) => l.entityKey === null)?.layer ?? null,
        entities: ls.filter((l) => l.entityKey !== null).map((l) => ({ entity: l.entityKey, layer: l.layer }))
          .sort((a, b) => a.entity!.localeCompare(b.entity!)),
      };
    }
    // a version release (docs/design/release-versions.md): the version each environment was on before the one it's on,
    // for rolling back from everyone. Read from its history: the newest change of the defaults' version there.
    const versions = f.kind === 'release' && isVersionFlag({ valueType: f.valueType, variants: variations as { key: string; value: unknown }[] })
      ? await versionsBefore(f.key, envs, layers as Record<string, { base: { defaultVariation: string | null } | null }>, variations as { key: string; value: unknown }[]) : undefined;
    delete f.id;
    return c.json({ ...f, variations, delivery, layers, ...(versions ? { versions } : {}) });
  });

  /** Per environment: the version it was on before its current one, since when it's been on the current one, and the
   *  versions it has served while on (what on call may roll back to without review: layers.ts versionsServed). */
  async function versionsBefore(flagKey: string, envs: { id: number; key: string }[], layers: Record<string, { base: { defaultVariation: string | null } | null }>,
    variants: { key: string; value: unknown }[]) {
    const rows = await all<{ env: number; before: string | null; after: string | null; at: string }>(db, `select distinct on (h.environment_id)
        h.environment_id as env, h.before->>'defaultVariation' as before, h.after->>'defaultVariation' as after, h.changed_at as at
      from change_history h where h.flag = $1 and h.entity is null and h.change_type = 'layer.update'
        and (h.before->>'defaultVariation') is distinct from (h.after->>'defaultVariation')
      order by h.environment_id, h.id desc`, [flagKey]);
    const value = (k: string | null) => (k ? (variants.find((v) => v.key === k)?.value as string | undefined) ?? null : null);
    const served = await versionsServed(db, flagKey);
    return Object.fromEntries(envs.map((e) => {
      const r = rows.find((x) => Number(x.env) === Number(e.id));
      const now = layers[e.key]?.base?.defaultVariation ?? null;
      // the newest change of the version must be the one that put it on the current one; otherwise it isn't known
      const known = r && r.after === now;
      return [e.key, { previous: known ? value(r.before) : null, since: known ? new Date(r.at).toISOString() : null,
        served: [...(served.get(Number(e.id)) ?? [])].map(value).filter((v): v is string => !!v) }];
    }));
  }

  // Where the environment needs approvals: 202 { applied: false, changeSetId } (a request); else 200 { applied: true, revision }.
  app.put('/flags/:key/delivery', async (c) => {
    const { environment, projects, before, reason } = await c.req.json<{ environment: string; projects: string[]; before?: string[]; reason?: string }>();
    const r = await setDelivery(db, c.req.param('key'), environment, projects, actor(c.get('user')), { before, reason });
    return c.json(r, r.applied ? 200 : 202);
  });

  app.put('/flags/:key/variations', async (c) => {
    const { variations } = await c.req.json<{ variations: { key: string; value: unknown }[] }>();
    await upsertVariations(db, c.req.param('key'), variations, actor(c.get('user')));
    return c.json({ ok: true });
  });

  // A version release's next version (control.ts addVersion): added everywhere, served by nobody until a step serves it.
  app.post('/flags/:key/versions', async (c) => {
    const { version } = await c.req.json<{ version?: unknown }>();
    return c.json(await addVersion(db, c.req.param('key'), version, actor(c.get('user'))), 201);
  });

  app.put('/flags/:key/meta', async (c) => {
    return c.json(await updateFlagMeta(db, c.req.param('key'), await c.req.json(), actor(c.get('user'))));
  });

  app.post('/flags/:key/archive', async (c) => {
    await archiveFlag(db, c.req.param('key'), actor(c.get('user')));
    return c.json({ ok: true });
  });

  // Who a change to the rules for everyone would not reach (M3 warning before saving them): every entity whose chain
  // skips the rules for everyone here — its own "Own settings only", or one above it. `entityLayers`: how many entities
  // have settings of their own on the flag. With ?entity=: `following`, how many entities under it follow its settings
  // on this flag (their chain reaches it, not skipped): saving its settings changes what they get too.
  app.get('/flags/:key/impact/:env', async (c) => {
    const snap = snapshot(c.req.param('env'));
    const f = Object.hasOwn(snap.flags, c.req.param('key')) ? snap.flags[c.req.param('key')] : undefined;
    const of = c.req.query('entity');
    if (!f) return c.json({ ownOnly: [], entityLayers: 0, ...(of ? { following: 0 } : {}) });
    const all_ = Object.values(snap.entities);
    const skips = all_.filter((e) => entityChain(f, e).levels.some((l) => l.level === 'everyone' && l.skippedBy));
    const following = of ? all_.filter((e) => e.key !== of && e.path.includes(of)
      && entityChain(f, e).levels.some((l) => l.owner === of && !l.skippedBy)).length : undefined;
    return c.json({ ownOnly: skips.map((e) => e.key).sort(), entityLayers: Object.keys(f.entities).length, ...(of ? { following } : {}) });
  });

  // ------------------------------------------------------------ releases (release.ts)
  // Every release (a flag of kind 'release') and where it is in each environment, read from the snapshots: the step
  // isn't stored, so the filters on it are applied here, not in SQL. ?show=rolling|not_started|done|overdue, ?owner=,
  // and the search and paging of every list (listing.ts). ?environment= the one the console shows: rolling and not
  // started are about that one (without it, about any). Soonest remove-by date first.
  app.get('/releases', async (c) => {
    const pg = query(c) ?? { page: 0, size: Number.MAX_SAFE_INTEGER, q: '' };
    const show = c.req.query('show') ?? '';
    const owner = c.req.query('owner') ?? '';
    const only = c.req.query('environment') ?? '';
    type Row = { key: string; name: string | null; tags: string[]; description: string | null; owner: string | null; removeBy: string | null; createdAt: string };
    const [envs, flags, changed, waiting, values] = await Promise.all([
      all<{ key: string }>(db, `select key from environment order by id`),
      all<Row>(db, `select key, name, tags, description, owner, remove_by::text as "removeBy", created_at as "createdAt"
        from flag where kind = 'release' and archived_at is null order by remove_by nulls last, key`),
      all<{ flag: string; env: string; at: string }>(db, `select f.key as flag, e.key as env, max(l.updated_at) as at
        from flag_layer l join flag f on f.id = l.flag_id join environment e on e.id = l.environment_id
        where f.kind = 'release' and f.archived_at is null group by f.key, e.key`),
      // the newest request still open per release and environment
      all<{ flag: string; env: string; id: number; status: string }>(db, `select distinct on (f.key, e.key) f.key as flag, e.key as env,
          cs.id::int as id, cs.status::text as status
        from change_set cs join environment e on e.id = cs.environment_id
        join change_set_item i on i.change_set_id = cs.id join flag f on f.id = i.flag_id
        where f.kind = 'release' and cs.status in ('in_review', 'approved', 'scheduled') order by f.key, e.key, cs.id desc`),
      // the values from the database, not the snapshot: a version added since the last publish is ready already (adding
      // one publishes nothing, control.ts upsertVariations)
      all<{ flag: string; key: string; value: unknown }>(db, `select f.key as flag, v.key, v.value from flag_variation v join flag f on f.id = v.flag_id
        where f.kind = 'release' and f.archived_at is null and not v.is_code_default order by v.id`),
    ]);
    const valuesOf = new Map<string, { key: string; value: unknown }[]>();
    for (const v of values) (valuesOf.get(v.flag) ?? valuesOf.set(v.flag, []).get(v.flag)!).push({ key: v.key, value: v.value });
    const today = new Date().toISOString().slice(0, 10);
    const changedAt = new Map(changed.map((r) => [`${r.flag}/${r.env}`, r.at]));
    const open = new Map(waiting.map((r) => [`${r.flag}/${r.env}`, { id: r.id, status: r.status }]));
    const rows = flags.map((f) => {
      const per: Record<string, (ReleaseState & { text: string; sent: boolean; changedAt: string | null; waiting: { id: number; status: string } | null }) | null> = {};
      for (const { key: env } of envs) {
        const def = plane.snapshots.get(env)?.flags[f.key];
        const state = def ? releaseState(valuesOf.get(f.key) ?? Object.entries(def.variations).map(([key, value]) => ({ key, value })), def.base) : null;
        per[env] = state && { ...state, text: stepText(state), sent: def!.delivery.length > 0,
          changedAt: changedAt.get(`${f.key}/${env}`) ?? null, waiting: open.get(`${f.key}/${env}`) ?? null };
      }
      const states = Object.values(per).filter((s) => s !== null);
      return { ...f, envs: per, overdue: overdue(f.removeBy, today), ready: readyToCleanUp(states.map((s) => ({ state: s, sent: s.sent }))) };
    });
    const keep = (r: (typeof rows)[number]) => {
      const steps = (only ? [r.envs[only] ?? null] : Object.values(r.envs)).map((s) => s?.step);
      if (show === 'rolling' && !steps.some((s) => s === 'early' || s === 'percent')) return false;
      if (show === 'not_started' && !steps.every((s) => !s || s === 'not_started')) return false;
      if (show === 'done' && !r.ready) return false;
      if (show === 'overdue' && !r.overdue) return false;
      return (!owner || r.owner === owner) && searchHit(pg.q, r.key, r.name, r.description, ...r.tags);
    };
    const owners = [...new Set(flags.map((f) => f.owner).filter((o): o is string => !!o))].sort();
    return c.json({ ...pageOf(rows, pg, keep), environments: envs.map((e) => e.key), owners });
  });

  // The save: PUT a whole layer with If-Match. How it goes live (now, a review, break-glass) is decided in layers.ts.
  type SaveBody = { layer?: LayerDoc; expectedVersion?: number | null; reason?: string; bypassReason?: string; allowReshuffle?: boolean };
  const submitted = (c: any, r: Awaited<ReturnType<typeof submitChange>>) => c.json(r, r.applied ? 200 : 202);
  async function saveLayer(c: any, body: SaveBody, proposed: LayerDoc | null) {
    const ifMatch = c.req.header('if-match');
    const expected = ifMatch !== undefined ? (ifMatch === 'none' ? null : Number(ifMatch.replace(/"/g, ''))) : body.expectedVersion ?? null;
    const entity = c.req.param('entity') === 'base' ? null : c.req.param('entity');
    const item: Item = { flag: c.req.param('key'), entity, expectedLayerVersion: expected, proposed, allowReshuffle: !!body.allowReshuffle };
    return submitted(c, await submitChange(db, c.req.param('env'), [item], c.get('user'), { reason: body.reason, bypassReason: body.bypassReason }));
  }

  app.put('/flags/:key/layers/:env/:entity', async (c) => {
    const body = await c.req.json<SaveBody>();
    if (!body.layer) throw new HttpError(422, 'nothing to save');
    return saveLayer(c, body, body.layer);
  });

  app.delete('/flags/:key/layers/:env/:entity', async (c) => saveLayer(c, await c.req.json<SaveBody>().catch(() => ({})), null));

  // Publish several layer changes of one flag together: applied atomically (one revision) where no
  // approval is needed, otherwise one change request covering all of them.
  app.post('/flags/:key/publish/:env', async (c) => {
    const body = await c.req.json<{ items: { entity: string | null; expectedVersion: number | null; layer: LayerDoc | null; allowReshuffle?: boolean }[]; reason?: string }>();
    const items: Item[] = (body.items ?? []).map((i) => ({ flag: c.req.param('key'), entity: i.entity, expectedLayerVersion: i.expectedVersion, proposed: i.layer, allowReshuffle: !!i.allowReshuffle }));
    return submitted(c, await submitChange(db, c.req.param('env'), items, c.get('user'), { reason: body.reason }));
  });

  // ------------------------------------------------------------ drafts and versions (one environment)
  // Publish a draft that spans flags: every change in one version where no review is needed, otherwise
  // one change request covering all of them.
  app.post('/environments/:env/publish', async (c) => {
    const body = await c.req.json<{ items: { flag: string; entity: string | null; expectedVersion: number | null; layer: LayerDoc | null; allowReshuffle?: boolean }[]; reason?: string }>();
    const items: Item[] = (body.items ?? []).map((i) => ({ flag: i.flag, entity: i.entity, expectedLayerVersion: i.expectedVersion, proposed: i.layer, allowReshuffle: !!i.allowReshuffle }));
    return submitted(c, await submitChange(db, c.req.param('env'), items, c.get('user'), { reason: body.reason }));
  });

  // Every version of an environment (a revision that changed something), newest first. `notRolledBack`: how many of
  // a version's changes a restore doesn't undo; `restorable`: the kinds of change it does undo (flag settings).
  app.get('/environments/:env/versions', async (c) => {
    const env = await one<{ id: number; revision: string }>(db, `select id, revision from environment where key = $1`, [c.req.param('env')]);
    if (!env) throw new HttpError(404, 'environment not found');
    const pg = query(c) ?? { page: 0, size: 50, q: '' };
    // Every version has at least one entry (journal.ts version()), so the environment's counter says how many there
    // are: nothing is counted. The page's versions are read newest first from the index on (environment, version),
    // and only their entries are grouped, so the list costs the same after years of changes.
    const total = Number(env.revision);
    const rows = await all<any>(db, `with page as (select distinct revision from change_history
          where environment_id = $1 and revision is not null order by revision desc limit $2 offset $3)
      select h.revision::int as revision, min(h.changed_at) as at,
        array_agg(distinct h.changed_by) as by, max(h.comment) as comment, max(h.change_set_id)::int as "changeSetId",
        count(*)::int as changes, coalesce(array_agg(distinct h.flag) filter (where h.flag is not null), '{}') as flags,
        array_agg(distinct h.change_type) as kinds, bool_or(h.actor_type = 'bypass') as emergency,
        count(*) filter (where not (h.change_type = any($4::text[])))::int as "notRolledBack"
      from change_history h where h.environment_id = $1 and h.revision in (select revision from page)
      group by h.revision order by h.revision desc`, [env.id, pg.size, pg.page * pg.size, RESTORABLE]);
    return c.json({ rows, current: total, restorable: RESTORABLE, matched: total, all: total, page: pg.page, size: pg.size });
  });

  // What restoring version N would do, before it is asked for: how many versions came after it, the flags whose
  // settings it puts back, and the later changes it leaves as they are (restore undoes flag settings only: the
  // journal's RESTORABLE kinds), in words.
  app.get('/environments/:env/versions/:revision{[0-9]+}/restore-preview', async (c) => {
    const env = await one<{ id: number; revision: string }>(db, `select id, revision from environment where key = $1`, [c.req.param('env')]);
    if (!env) throw new HttpError(404, 'environment not found');
    const to = Number(c.req.param('revision'));
    if (!Number.isSafeInteger(to) || to >= Number(env.revision)) throw new HttpError(422, `version ${to} isn’t an earlier version of ${c.req.param('env')}`);
    const [r, left] = await Promise.all([
      one<{ versions: number; flags: string[] }>(db, `select count(distinct h.revision)::int as versions,
          coalesce(array_agg(distinct h.flag order by h.flag) filter (where h.flag is not null and h.change_type = any($3::text[])), '{}') as flags
        from change_history h where h.environment_id = $1 and h.revision > $2`, [env.id, to, RESTORABLE]),
      notRolledBack(db, env.id, to),
    ]);
    return c.json({ versions: r!.versions, flags: r!.flags, notRolledBack: left });
  });

  // Restore: every flag setting changed after version N goes back to how it was at N, as one new version (or a
  // request). Restore undoes flag settings only; `notRolledBack` lists the later changes it leaves as they are.
  app.post('/environments/:env/versions/:revision{[0-9]+}/restore', async (c) => {
    const envKey = c.req.param('env');
    const to = Number(c.req.param('revision'));
    const body = await c.req.json<{ reason?: string }>().catch(() => ({} as { reason?: string }));
    const { items, notRolledBack } = await restoreItems(db, envKey, to);
    if (!items.length) {
      throw new HttpError(422, notRolledBack.length
        ? `Nothing to roll back: restore undoes flag settings only, and they’re all as they were in version ${to}. Not rolled back: ${notRolledBack.map((n) => n.text).join('; ')}`
        : `Nothing to roll back: every setting is already as it was in version ${to}`, { notRolledBack });
    }
    const reason = `Roll back to version ${to}${body.reason?.trim() ? `: ${body.reason.trim()}` : ''}`;
    const r = await submitChange(db, envKey, items, c.get('user'), { reason });
    return c.json({ ...r, restored: items.length, notRolledBack }, r.applied ? 200 : 202);
  });

  // The conditions rules use in an environment, with how many flags use each (the Conditions tab).
  app.get('/environments/:env/conditions', async (c) => {
    return c.json(await all(db, `select cond as condition, count(distinct r.flag_id)::int as flags, count(*)::int as rules,
        (array_agg(distinct f.key))[1:5] as examples
      from flag_rule r join flag_layer l on l.id = r.layer_id join environment e on e.id = l.environment_id
      join flag f on f.id = r.flag_id and f.archived_at is null,
      lateral jsonb_array_elements(r.conditions) as x(cond)
      where e.key = $1 group by cond order by flags desc, rules desc`, [c.req.param('env')]));
  });

  // ------------------------------------------------------------ change sets
  // ?status= one status; ?flag= only requests with a change to that flag (the release page shows what's waiting)
  app.get('/change-sets', async (c) => {
    const status = c.req.query('status');
    const flag = c.req.query('flag');
    const params: unknown[] = [];
    const where: string[] = [];
    if (status) { params.push(status); where.push(`cs.status::text = $${params.length}`); }
    if (flag) {
      params.push(flag);
      where.push(`exists (select 1 from change_set_item i join flag f on f.id = i.flag_id where i.change_set_id = cs.id and f.key = $${params.length})`);
    }
    const rows = await all<any>(db, `select cs.id, e.key as environment, cs.status, cs.author, cs.reason, cs.scheduled_at as "scheduledAt",
      cs.created_at as "createdAt", cs.decided_at as "decidedAt", cs.applied_at as "appliedAt", cs.applied_revision as "appliedRevision",
      cs.last_error as "lastError",
      (select json_agg(json_build_object('kind', i.kind, 'flag', f.key, 'entity', cu.key) order by i.seq) from change_set_item i join flag f on f.id = i.flag_id
        left join entity cu on cu.id = i.entity_id where i.change_set_id = cs.id) as items,
      (select json_agg(json_build_object('reviewer', r.reviewer, 'decision', r.decision, 'current', r.for_content_hash = cs.content_hash))
        from change_set_review r where r.change_set_id = cs.id) as reviews
      from change_set cs join environment e on e.id = cs.environment_id
      ${where.length ? `where ${where.join(' and ')}` : ''} order by cs.id desc limit 200`, params);
    return c.json(rows);
  });

  app.get('/change-sets/:id{[0-9]+}', async (c) => {
    const id = Number(c.req.param('id'));
    const cs = await one<any>(db, `select cs.id, e.key as environment, e.min_approvals as "minApprovals", cs.status, cs.author, cs.reason, cs.content_hash as "contentHash",
      cs.scheduled_at as "scheduledAt", cs.created_at as "createdAt", cs.applied_revision as "appliedRevision", cs.last_error as "lastError"
      from change_set cs join environment e on e.id = cs.environment_id where cs.id = $1`, [id]);
    if (!cs) throw new HttpError(404, 'change set not found');
    // a layer item's before / proposed are layers; a delivery item's are { projects: [app keys] }
    cs.items = await all(db, `select i.seq, i.kind, f.key as flag, cu.key as entity, i.expected_layer_version as "expectedLayerVersion",
      i.expected_base_version as "expectedBaseVersion", i.before, case when i.kind = 'delivery' then i.proposed else i.proposed->'doc' end as proposed
      from change_set_item i join flag f on f.id = i.flag_id left join entity cu on cu.id = i.entity_id where i.change_set_id = $1 order by i.seq`, [id]);
    cs.reviews = await all(db, `select reviewer, decision, comment, for_content_hash = $2 as current, created_at as "createdAt"
      from change_set_review where change_set_id = $1 order by created_at`, [id, cs.contentHash]);
    return c.json(cs);
  });

  app.post('/change-sets', async (c) => {
    const body = await c.req.json<{ environment: string; reason?: string; items: Item[] }>();
    return c.json(await createChangeSet(db, body.environment, body.items, c.get('user').key, body.reason ?? null), 201);
  });

  app.post('/change-sets/:id{[0-9]+}/review', async (c) => {
    const { decision, comment } = await c.req.json<{ decision: 'approve' | 'reject'; comment?: string }>();
    return c.json(await reviewChangeSet(db, Number(c.req.param('id')), c.get('user'), decision, comment ?? null));
  });

  app.post('/change-sets/:id{[0-9]+}/apply', async (c) => {
    return c.json(await applyChangeSet(db, Number(c.req.param('id')), actor(c.get('user'))));
  });

  app.post('/change-sets/:id{[0-9]+}/schedule', async (c) => {
    const { at } = await c.req.json<{ at: string }>();
    await scheduleChangeSet(db, Number(c.req.param('id')), at, c.get('user'));
    return c.json({ ok: true });
  });

  app.post('/change-sets/:id{[0-9]+}/cancel', async (c) => {
    await cancelChangeSet(db, Number(c.req.param('id')), c.get('user').key);
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------ history + publishing
  // History, newest first, any age (history.ts): filters by flag, entity, environment, version, person (`by`),
  // kind of change (`type`) and time (`from`, `to`); `before=<id>` is the page after the last entry shown.
  app.get('/history', async (c) => c.json(await historyPage(db, historyFilter((k) => c.req.query(k)))));

  // Every entry the same filters match, with no limit: CSV for a spreadsheet, or JSON (`format=json`).
  app.get('/history/export', async (c) => {
    const f = historyFilter((k) => (k === 'limit' ? undefined : c.req.query(k)));   // checked before anything is sent
    const json = c.req.query('format') === 'json';
    const day = new Date().toISOString().slice(0, 10);
    const scope = [c.req.query('environment'), c.req.query('flag'), c.req.query('entity')]
      .filter(Boolean).join('-').replace(/[^A-Za-z0-9_.-]/g, '_');
    c.header('Content-Type', json ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="history${scope ? `-${scope}` : ''}-${day}.${json ? 'json' : 'csv'}"`);
    c.header('Cache-Control', 'no-store');
    return stream(c, async (out) => {
      let n = 0;
      // a CSV starts with a byte-order mark, so spreadsheets read it as UTF-8
      await out.write(json ? '[' : `﻿${HISTORY_CSV_HEADER.join(',')}\r\n`);
      for await (const rows of historyBatches(db, f)) {
        await out.write(json ? rows.map((r) => `${n++ ? ',' : ''}\n${JSON.stringify(r)}`).join('') : rows.map((r) => `${historyCsv(r)}\r\n`).join(''));
      }
      if (json) await out.write('\n]\n');
    });
  });

  app.get('/publish-queue', async (c) => c.json(await all(db, `select q.id, e.key as environment, q.revision, q.created_at as "createdAt",
    q.published_at as "publishedAt", q.attempts, q.last_error as "lastError"
    from publish_queue q join environment e on e.id = q.environment_id order by q.id desc limit 50`)));

  // ------------------------------------------------------------ dimensions, entities, app links, API keys
  // The dimensions, top to bottom (dimensions.ts), with how many entities each has. Admins save the whole chain.
  app.get('/dimensions', async (c) => c.json(await dimensionsNow()));
  app.put('/dimensions', async (c) => {
    adminOnly(c.get('user'));
    const { dimensions } = await c.req.json<{ dimensions?: unknown }>();
    await saveDimensions(db, dimensions, actor(c.get('user')));
    return c.json(await dimensionsNow());
  });

  // A dimension's entities: how many flags each has its own settings on, per environment, and how many entities are
  // under it. ?parent=<key>: only those under it (the tree); ?parent= (empty): only those with no parent.
  type EntityRow = { key: string; name: string; dimension: string; parent: string | null; parentName: string | null; children: number; createdAt: string };
  const entityRows = (q: { dimension: string; key?: string; parent?: string }) => all<EntityRow>(db,
    `select c.key, c.name, d.key as dimension, p.key as parent, p.name as "parentName",
            (select count(*)::int from entity b where b.parent_id = c.id and b.archived_at is null) as children, c.created_at as "createdAt"
     from entity c join dimension d on d.id = c.dimension_id left join entity p on p.id = c.parent_id
     where c.archived_at is null and d.key = $1 and ($2::text is null or c.key = $2)
       and ($3::text is null or ($3 = '' and c.parent_id is null) or p.key = $3)
     order by c.name, c.key`, [q.dimension, q.key ?? null, q.parent ?? null]);
  // entity → flags with its own settings there (counted once per publish)
  const countsOf = (snap: Snapshot) => {
    let m = entityCounts.get(snap);
    if (!m) {
      m = new Map();
      for (const f of Object.values(snap.flags)) for (const k of Object.keys(f.entities)) m.set(k, (m.get(k) ?? 0) + 1);
      entityCounts.set(snap, m);
    }
    return m;
  };
  const withCounts = (r: EntityRow) => ({
    ...r, flagsWithSettings: Object.fromEntries([...plane.snapshots].flatMap(([env, snap]) => {
      const n = countsOf(snap).get(r.key);
      return n ? [[env, n]] : [];
    })),
  });
  const dimensionKnown = async (key: string) => {
    if (!await one(db, `select 1 from dimension where key = $1`, [key])) throw new HttpError(404, `no dimension “${key}”`);
  };
  // the entity in the snapshot, in that dimension (404 otherwise)
  const entityIn = (snap: Snapshot, dimension: string, key: string) => {
    const e = Object.hasOwn(snap.entities, key) ? snap.entities[key] : null;
    if (!e || e.dimension !== dimension) throw new HttpError(404, `no ${dimension} “${key}”`);
    return e;
  };

  app.get('/dimensions/:dimension', async (c) => {
    await dimensionKnown(c.req.param('dimension'));
    const all_ = (await entityRows({ dimension: c.req.param('dimension'), parent: c.req.query('parent') })).map(withCounts);
    const pg = query(c);
    if (!pg) return c.json(all_);
    return c.json(pageOf(all_, pg, (r) => searchHit(pg.q, r.name, r.key, r.parentName ?? undefined)));
  });

  app.post('/dimensions/:dimension', async (c) => {
    const body = await c.req.json<{ key: string; name: string; parent?: string | null }>();
    const keyProblem = entityKeyProblem(body.key ?? '');
    if (keyProblem) throw new HttpError(422, keyProblem);
    return c.json(await upsertEntity(db, c.req.param('dimension'), body.key, body, actor(c.get('user')), true, c.get('user')), 201);
  });

  // One entity: the same row as in the list (404 for one that doesn't exist, was archived, or is in another dimension).
  app.get('/dimensions/:dimension/:key', async (c) => {
    const [row] = await entityRows({ dimension: c.req.param('dimension'), key: c.req.param('key') });
    if (!row) throw new HttpError(404, `no ${c.req.param('dimension')} “${c.req.param('key')}”`);
    return c.json(withCounts(row));
  });

  app.put('/dimensions/:dimension/:key', async (c) => {
    const body = await c.req.json<{ name: string; parent?: string | null }>();
    return c.json(await upsertEntity(db, c.req.param('dimension'), c.req.param('key'), body, actor(c.get('user')), false, c.get('user')));
  });

  // One entity's view of every flag in an environment: what it gets (worked out by the evaluator), the exceptions that
  // depend on the request, and what everyone else gets.
  app.get('/dimensions/:dimension/:key/flags', async (c) => {
    const key = c.req.param('key');
    const env = c.req.query('environment') ?? await firstEnv();
    const snap = snapshot(env);
    const entity = entityIn(snap, c.req.param('dimension'), key);
    const pg = query(c) ?? { page: 0, size: Number.MAX_SAFE_INTEGER, q: '' };
    const onlyOwn = c.req.query('own') === '1';
    const descs = await descriptions();
    const sorted = flagsOf(snap);
    const withOwn = countsOf(snap).get(key) ?? 0;
    const page = pageOf(sorted, pg, (f) => (!onlyOwn || !!f.entities[key]) && searchHit(pg.q, f.key, descs.get(f.key)));
    const owners = new Map((await all<{ key: string; owner: string | null }>(db,
      `select key, owner from flag where key = any($1::text[])`, [page.rows.map((f) => f.key)])).map((f) => [f.key, f.owner]));
    const rows = page.rows.map((f) => {
      const own = f.entities[key] ?? null;
      const answer = forEntity(f, snap, entity);
      // "why it gets this": the chain's levels in order (overrides, its own, each one above it, everyone's), which are
      // set, which are skipped and by whom, and whose default it ends in
      const chain = entityChain(f, entity);
      const levels = chain.levels.map((l) => ({
        who: l.level, key: l.owner, name: l.owner ? snap.entities[l.owner]?.name ?? l.owner : null,
        dimension: l.owner ? snap.entities[l.owner]?.dimension ?? null : null, distance: l.distance,
        set: l.set, skipped: !!l.skippedBy, skippedBy: l.skippedBy, inherit: l.owner ? l.layer?.inherit ?? null : null, rules: l.rules.length,
        defaultVariant: l.owner ? l.layer?.defaultVariation ?? null : l.level === 'everyone' ? f.base.defaultVariation : null,
        defaultWins: chain.default.level === l.level && chain.default.owner === l.owner,
      }));
      // shared variants, plus the typed-in values of this entity and those above it (other entities' values stay hidden)
      const used = new Set([answer.gets.variant, ...answer.exceptions.map((e) => e.variant), ...chain.levels.map((l) => (l.owner ? l.layer?.defaultVariation ?? '' : ''))]);
      return {
        key: f.key, valueType: f.valueType, kind: f.kind,
        description: descs.get(f.key) ?? null, owner: owners.get(f.key) ?? null,
        enabled: !!f.base.enabled, delivery: f.delivery, hasOwn: !!own, ownVersion: own?.version ?? null, levels,
        variations: Object.entries(f.variations).filter(([k]) => k !== CODE_DEFAULT && (!k.startsWith(HIDDEN_PREFIX) || used.has(k)))
          .map(([k, value]) => ({ key: k, value, own: k.startsWith(HIDDEN_PREFIX) })),
        answer,
        everyone: forEntity(f, snap, null).gets,
      };
    });
    const above = entity.path.slice(1).map((k) => snap.entities[k]).filter(Boolean);
    const children = childrenOf(snap, key);
    return c.json({ entity, above, children, environment: env, revision: snap.revision, withOwn, ...page, rows });
  });

  // An entity and the entities right under it side by side: what each gets for every flag, and where one differs from
  // it. `?diff=1`: only flags where some differs. A cell's `cases`: answers that depend on the request (app, version…).
  app.get('/dimensions/:dimension/:key/children', async (c) => {
    const key = c.req.param('key');
    const env = c.req.query('environment') ?? await firstEnv();
    const snap = snapshot(env);
    const entity = entityIn(snap, c.req.param('dimension'), key);
    const children = childrenOf(snap, key);
    const pg = query(c) ?? { page: 0, size: Number.MAX_SAFE_INTEGER, q: '' };
    const onlyDiff = c.req.query('diff') === '1';
    const descs = await descriptions();
    const all_ = childGrid(snap, entity, children).map((r) => ({ ...r, description: descs.get(r.key) ?? null }));
    const differing = all_.filter((r) => r.differs.length > 0).length;
    const page = pageOf(all_, pg, (r) => (!onlyDiff || r.differs.length > 0) && searchHit(pg.q, r.key, r.description));
    return c.json({ entity, children, environment: env, revision: snap.revision, differing, ...page });
  });

  // The entity's app link in an environment: its backend gives it to the app at login (":app" = android / ios / web).
  // The link is a secret (anyone with it reads the entity's file): editors and above, not viewers.
  app.get('/dimensions/:dimension/:key/link', async (c) => {
    notViewer(c.get('user'), 'app links');
    const env = c.req.query('environment') ?? await firstEnv();
    entityIn(snapshot(env), c.req.param('dimension'), c.req.param('key'));
    // with ?app=: the link for that app, and the same link as a token for OpenFeature's OFREP providers (ofrep.ts)
    const appKey = c.req.query('app');
    if (appKey && (await one<{ kind: string }>(db, `select kind from project where key = $1`, [appKey]))?.kind !== 'client') {
      throw new HttpError(404, `no app "${appKey}"`);
    }
    const path = await clientLink(db, env, c.req.param('key'), appKey);
    return c.json({ path, ...(appKey ? { token: await appToken(db, env, c.req.param('key'), appKey) } : {}) });
  });

  app.post('/dimensions/:dimension/:key/link/rotate', async (c) => {
    const env = c.req.query('environment') ?? await firstEnv();
    entityIn(snapshot(env), c.req.param('dimension'), c.req.param('key'));
    // the old link stops working here at once, and every environment publishes again, which purges the CDN (journal.ts)
    await rotateClientLink(db, c.req.param('key'), actor(c.get('user')));
    return c.json({ path: await clientLink(db, env, c.req.param('key')) });
  });

  app.get('/api-keys', async (c) => c.json(await all(db, `select k.id, k.key_prefix as prefix, k.label, e.key as environment, p.key as project,
    p.kind as "projectKind", k.scope, cu.key as entity, d.key as dimension, k.created_at as "createdAt", k.last_used_at as "lastUsedAt", k.revoked_at as "revokedAt"
    from api_key k join environment e on e.id = k.environment_id join project p on p.id = k.project_id left join entity cu on cu.id = k.entity_id
    left join dimension d on d.id = cu.dimension_id
    order by k.revoked_at nulls first, k.id desc`)));

  // A key reads flags for the entities its scope allows, from outside the console: only admins make or revoke one,
  // as for the rest of Settings.
  app.post('/api-keys', async (c) => {
    adminOnly(c.get('user'));
    const body = await c.req.json<{ environment: string; project: string; scope: string; entity?: string; label?: string }>();
    return c.json(await createApiKey(db, body, actor(c.get('user'))), 201);
  });

  app.post('/api-keys/:id{[0-9]+}/revoke', async (c) => {
    adminOnly(c.get('user'));
    await revokeApiKey(db, Number(c.req.param('id')), actor(c.get('user')));  // not accepted here from now on
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------ settings (admins): environments, apps
  // A made-up installation to explore with (demo.ts): only into an empty one.
  app.post('/sample-data', async (c) => {
    adminOnly(c.get('user'));
    await addSampleData(db);
    return c.json({ ok: true }, 201);
  });

  app.post('/environments', async (c) => {
    adminOnly(c.get('user'));
    return c.json(await createEnvironment(db, await c.req.json(), actor(c.get('user'))), 201);   // its app files are served at once
  });

  app.put('/environments/:env', async (c) => {
    adminOnly(c.get('user'));
    return c.json(await updateEnvironment(db, c.req.param('env'), await c.req.json(), actor(c.get('user'))));
  });

  app.post('/apps', async (c) => {
    adminOnly(c.get('user'));
    // an app key asked for before it existed is answered again once this commits (journal.ts)
    return c.json(await createProject(db, await c.req.json(), actor(c.get('user'))), 201);
  });

  // an app's kind; its key can't change. Both this and a delete are refused (409, saying what) while anything uses it
  app.put('/apps/:key', async (c) => {
    adminOnly(c.get('user'));
    return c.json(await updateProject(db, c.req.param('key'), await c.req.json(), actor(c.get('user'))));
  });

  app.delete('/apps/:key', async (c) => {
    adminOnly(c.get('user'));
    return c.json(await deleteProject(db, c.req.param('key'), actor(c.get('user'))));
  });

  // ------------------------------------------------------------ people (access.ts)
  app.put('/people/:key', async (c) => {
    adminOnly(c.get('user'));
    const { role } = await c.req.json<{ role: string }>();
    return c.json(await access.setRole(c.req.param('key'), role, actor(c.get('user'))));
  });

  // adding someone gives them an invite link (`#/join/<invite>`), shown to the admin once
  app.post('/people', async (c) => {
    adminOnly(c.get('user'));
    return c.json(await access.add(await c.req.json(), actor(c.get('user'))), 201);
  });

  // a new invite link (the old one stops working); also gives back access to someone whose access was removed
  app.post('/people/:key/invite', async (c) => {
    adminOnly(c.get('user'));
    return c.json(await access.invite(c.req.param('key'), actor(c.get('user'))));
  });

  // a password reset link (`#/reset/<token>`), shown to the admin once: works once, for a day (betterAuth.ts)
  app.post('/people/:key/password-reset', async (c) => {
    adminOnly(c.get('user'));
    if (!identity.passwordResetToken) throw new HttpError(409, 'this sign-in has no passwords');
    return c.json(await access.passwordReset(c.req.param('key'), actor(c.get('user')), identity.passwordResetToken));
  });

  // signs them out everywhere and deletes their accounts; their name stays in the history
  app.delete('/people/:key', async (c) => {
    adminOnly(c.get('user'));
    return c.json(await access.remove(c.req.param('key'), actor(c.get('user'))));
  });

  // ------------------------------------------------------------ single sign-on (sso.ts): admins add connections
  // `base`: the console's address, for what the identity provider's admin enters on their side (serviceProvider)
  app.get('/sso', async (c) => {
    const base = sso.base(c.req.url);
    const connections = (await sso.list()).map((x) => ({ ...x, serviceProvider: serviceProvider(base, x.id) }));
    return c.json({ available: sso.available, base, connections });
  });
  app.post('/sso', async (c) => {
    adminOnly(c.get('user'));
    const base = sso.base(c.req.url);
    const conn = await sso.add(await c.req.json(), actor(c.get('user')), { headers: c.req.raw.headers, base });
    return c.json({ ...conn, serviceProvider: serviceProvider(base, conn.id) }, 201);
  });
  app.put('/sso/:id', async (c) => {
    adminOnly(c.get('user'));
    const { requireSso } = await c.req.json<{ requireSso: boolean }>();
    return c.json(await sso.setRequireSso(c.req.param('id'), requireSso === true, actor(c.get('user'))));
  });
  app.delete('/sso/:id', async (c) => {
    adminOnly(c.get('user'));
    return c.json(await sso.remove(c.req.param('id'), actor(c.get('user'))));
  });

  // ------------------------------------------------------------ the CDN purge (cdn.ts): admins set the Cloudflare zone
  // and token; everyone can see whether it's set up (never the token) and how the last publishes' purges went
  app.get('/cdn', async (c) => c.json(await cdn.state()));
  app.put('/cdn', async (c) => {
    adminOnly(c.get('user'));
    await cdn.save(await c.req.json(), actor(c.get('user')));
    return c.json(await cdn.state());
  });
  app.delete('/cdn', async (c) => {
    adminOnly(c.get('user'));
    await cdn.remove(actor(c.get('user')));
    return c.json(await cdn.state());
  });
  app.post('/cdn/purge', async (c) => {
    adminOnly(c.get('user'));
    const { environment } = await c.req.json<{ environment?: unknown }>();
    await cdn.purgeNow(environment, actor(c.get('user')));
    return c.json({ purged: true });
  });

  // ------------------------------------------------------------ trace / playground (S9: runs the real evaluator)
  app.post('/trace', async (c) => {
    const body = await c.req.json<{ environment: string; project: string; entity: string | null; attrs: Record<string, unknown>; flag?: string }>();
    const snap = snapshot(body.environment);
    const ctx = simulate(snap, body.project, body.entity, body.attrs);
    if (body.flag) return c.json({ revision: snap.revision, result: evaluate(snap, body.flag, ctx) });
    // every flag's answer, without the step-by-step explanation nobody sees here
    const results = sortedFlagKeys(snap).map((k) => {
      const r = evaluate(snap, k, ctx, 'metadata');
      return { key: k, value: r.value, variant: r.variant, codeDefault: r.codeDefault, reason: r.reason, errorCode: r.errorCode, metadata: r.metadata, decidedBy: r.decidedBy };
    });
    return c.json({ revision: snap.revision, results });
  });

  // Compare two sides (two entities, two environments or two apps) flag by flag: what each one gets and why.
  type Side = { environment: string; project: string; entity: string | null };
  app.post('/compare', async (c) => {
    const body = await c.req.json<{ a: Side; b: Side; attrs?: Record<string, unknown>; q?: string; onlyDiff?: boolean; page?: number; size?: number }>();
    if (!body.a || !body.b) throw new HttpError(422, 'a and b: the two sides to compare (environment, project, entity)');
    const prep = (side: Side) => {
      const snap = snapshot(side.environment);
      const ctx = simulate(snap, side.project, side.entity, body.attrs);
      // "Acme 12’s rule", and for settings it follows from above "Acme’s rule"
      const who = ctx.entity ? entityWords(ctx.entity.key, (k) => snap.entities[k]) : null;
      return { snap, side, ctx, who };
    };
    const A = prep(body.a);
    const B = prep(body.b);
    const info = await descriptions();
    // worked out once per pair of snapshots and question; a publish starts over
    let byPair = comparisons.get(A.snap)?.get(B.snap);
    if (!byPair) {
      let forA = comparisons.get(A.snap);
      if (!forA) comparisons.set(A.snap, (forA = new WeakMap()));
      forA.set(B.snap, (byPair = new Map()));
    }
    const question = JSON.stringify([body.a, body.b, body.attrs ?? null]);
    let compared = byPair.get(question);
    if (!compared) {
      compared = compareAll(A, B);
      if (byPair.size >= COMPARISONS_KEPT) byPair.delete(byPair.keys().next().value!);
      byPair.set(question, compared);
    }
    const rows = compared.map((r) => ({ ...r, description: info.get(r.key) ?? null }));
    const different = rows.filter((r) => !r.same).length;
    const pg = listQuery((k) => (body as Record<string, unknown>)[k]) ?? { page: 0, size: Number.MAX_SAFE_INTEGER, q: (body.q ?? '').trim().toLowerCase() };
    // the counts cover every flag; the rows are one page of the filtered ones
    return c.json({ different, ...pageOf(rows, pg, (r) => (!body.onlyDiff || !r.same) && searchHit(pg.q, r.key, r.description)) });
  });

  app.get('/events', (c) => streamSSE(c, async (stream) => {
    let open = true;
    let wakeUp = () => {};
    const off = hub.subscribeConsole((event, data) => { stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => {}); });
    stream.onAbort(() => { open = false; wakeUp(); });
    try {
      while (open) {
        await stream.writeSSE({ event: 'heartbeat', data: '{}' });
        // the next heartbeat in 15 s, or now if the console went away (so nothing waits on a closed stream)
        await new Promise<void>((resolve) => { const t = setTimeout(resolve, 15000); wakeUp = () => { clearTimeout(t); resolve(); }; });
      }
    } finally {
      off();                    // however the loop ends, the subscriber goes
    }
  }));

  return app;
}

const childrenOf = (snap: Snapshot, parent: string) =>
  Object.values(snap.entities).filter((x) => x.parent === parent).sort((a, b) => a.name.localeCompare(b.name));

// An entity and its children, flag by flag (once per snapshot and entity; descriptions are added per request).
function childGrid(snap: Snapshot, entity: EntityInfo, children: EntityInfo[]): GridRow[] {
  let byEntity = childGrids.get(snap);
  if (!byEntity) childGrids.set(snap, (byEntity = new Map()));
  const known = byEntity.get(entity.key);
  if (known) return known;
  const all_ = [entity, ...children];
  const rows = flagsOf(snap).map((f): GridRow => {
    const sigs: Record<string, string> = {};
    const cells = Object.fromEntries(all_.map((m) => {
      const a = forEntity(f, snap, m);
      const g = a.gets;
      sigs[m.key] = JSON.stringify([g.variant, a.exceptions.map((e) => [e.variant, e.when, e.percent])]);
      return [m.key, { variant: g.variant, value: g.variant === CODE_DEFAULT ? null : f.variations[g.variant] ?? null, codeDefault: g.variant === CODE_DEFAULT,
        section: g.section, cases: a.exceptions.length, own: !!f.entities[m.key] }];
    }));
    const differs = children.filter((b) => sigs[b.key] !== sigs[entity.key]).map((b) => b.key);
    return { key: f.key, valueType: f.valueType, enabled: !!f.base.enabled, cells, differs };
  });
  byEntity.set(entity.key, rows);
  return rows;
}

type Prepared = { snap: Snapshot; side: { project: string }; ctx: EvalContext; who: ReturnType<typeof entityWords> | null };
// Two sides flag by flag: what each one gets and why.
function compareAll(A: Prepared, B: Prepared): CompareRow[] {
  const outcome = (x: Prepared, key: string): Outcome => {
    const r = evaluate(x.snap, key, x.ctx, false);
    const sent = !r.errorCode;
    const byDevice = r.reason === 'SPLIT';
    const source = !Object.hasOwn(x.snap.flags, key) ? 'Flag doesn’t exist here'
      : sourceText(r.decidedBy, { entity: x.who, nameOf: (k) => x.snap.entities[k]?.name, project: x.side.project, byDevice });
    return { sent, value: sent && !r.codeDefault ? r.value : null, codeDefault: !!r.codeDefault, variant: r.variant ?? null, source, rule: r.decidedBy.ruleName, byDevice };
  };
  const keys = [...new Set([...sortedFlagKeys(A.snap), ...sortedFlagKeys(B.snap)])].sort();
  return keys.map((key) => {
    const a = outcome(A, key);
    const b = outcome(B, key);
    const same = a.sent === b.sent && a.codeDefault === b.codeDefault && JSON.stringify(a.value) === JSON.stringify(b.value);
    return { key, a, b, same };
  });
}
