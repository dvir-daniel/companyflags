// Background workers: the outbox publisher (each change waits in publish_queue until its environment's new snapshot is
// built), the runner of change sets scheduled for later, and catching up with publishes made by other server processes
// on the same database.

import { all, type Db } from './db.ts';
import { joinScopes, NOBODY, type EventHub, type PublishScope } from './events.ts';
import { scopeOfRevisions } from './journal.ts';
import { applyChangeSet } from './layers.ts';
import type { DataPlane } from './snapshot.ts';
import type { OnPublish } from './plugin.ts';

type QueueRow = { id: string; env_key: string; revision: string };

export type WorkerOptions = {
  /** Called when another server process changed what an environment serves: drop what this one keeps in memory. */
  onRemoteChange?: () => void;
  /** How long after a publish its onPublish (the CDN purge) runs once more: PURGE_AGAIN_MS. */
  purgeAgainAfterMs?: number;
  /** Days the publish log keeps a publish (retention.publishLogDays): default 30. */
  publishLogDays?: number;
  /** tests: how often old publish log rows are dropped (PRUNE_EVERY_MS) */
  pruneEveryMs?: number;
};

/** How often old publish log rows are dropped. */
const PRUNE_EVERY_MS = 60 * 60 * 1000;

/** Per environment: the revision it is at (the database's), the one this server serves, and the oldest publish
 *  still waiting, with the error of its last try (a snapshot that can't be built). `purgeError`: the newest publish
 *  that had files to purge didn't purge them (the CDN said no, or its token can't be read): apps reading CDN files
 *  may get the change only when the CDN's minute is up. */
export type PublishState = {
  environment: string; revision: number; serving: number | null; waitingSince: string | null; lagSeconds: number; error: string | null;
  purgeError: string | null;
};

/** How far each environment's publishing is behind, and whether its last purge went through (index.ts /readyz, the
 *  metrics plugin). */
export async function publishState(db: Db, plane: Pick<DataPlane, 'snapshots'>): Promise<PublishState[]> {
  const rows = await all<{ key: string; revision: string; since: string | null; lag: number | null; error: string | null; purge: string | null }>(db, `
    select e.key, e.revision, w.created_at as since, extract(epoch from now() - w.created_at)::float8 as lag, w.last_error as error,
      p.last_error as purge
    from environment e left join lateral (select q.created_at, q.last_error from publish_queue q
      where q.environment_id = e.id and q.published_at is null order by q.id limit 1) w on true
    left join lateral (select q.last_error from publish_queue q
      where q.environment_id = e.id and q.published_at is not null and (q.purged_at is not null or q.last_error like 'purge:%')
      order by q.id desc limit 1) p on true
    order by e.id`);
  return rows.map((r) => ({
    environment: r.key, revision: Number(r.revision), serving: plane.snapshots.get(r.key)?.revision ?? null,
    waitingSince: r.since ? new Date(r.since).toISOString() : null, lagSeconds: Math.max(0, Math.round(Number(r.lag ?? 0))), error: r.error,
    purgeError: r.purge?.startsWith('purge:') ? r.purge : null,
  }));
}

/** The revisions after `from` up to `to`, which a listener hasn't heard of (scopeOfRevisions reads at most 500). */
const after = (from: number, to: number) => Array.from({ length: Math.min(Math.max(0, to - from), 501) }, (_, i) => from + 1 + i);

/** How often each server process runs a round: publishing, scheduled changes, catching up with the others. */
export const ROUND_MS = 1000;
/** Another server may still serve the old flags for a round after a publish (catchUp below), and a CDN that asks it
 *  right after the purge keeps the old file. The purge runs once more after a round and a margin for a slow one. */
export const PURGE_AGAIN_MS = ROUND_MS + 10_000;

export function startWorkers(db: Db, plane: DataPlane, hub: EventHub, log: (m: string) => void = () => {}, onPublish?: OnPublish, opts: WorkerOptions = {}) {
  // The revision this process's listeners (the hub) last heard of, per environment. The snapshot can be ahead of it:
  // OFREP catches up on its own when a provider names a newer revision (ofrep.ts), and catchUp still tells everyone.
  // Each tells them whose answers may have changed since the revision they heard of (journal.ts scopeOfRevisions):
  // anyone's when History can't say.
  const told = new Map<string, number>();
  for (const [env, snap] of plane.snapshots) told.set(env, snap.revision);
  const tell = async (env: string, revision: number) => {
    const from = told.get(env);
    const scope = from === undefined ? null : revision <= from ? NOBODY
      : await scopeOfRevisions(db, env, after(from, revision)).catch(() => null);
    hub.publish(env, revision, scope);
    told.set(env, Math.max(revision, told.get(env) ?? 0));
  };
  const purgesAgain = new Map<string, { timer: ReturnType<typeof setTimeout>; scope: PublishScope; ids: string[] }>();

  async function publishOnce() {
    // Claim with a lease; messages are idempotent "env is at revision N" signals, so duplicates are harmless.
    const rows = await all<QueueRow>(db, `
      with claimed as (
        select id from publish_queue
        where published_at is null and (claimed_until is null or claimed_until < now())
        order by id for update skip locked limit 100)
      update publish_queue q set claimed_until = now() + interval '30 seconds', attempts = attempts + 1
      from claimed c join environment e on true
      where q.id = c.id and e.id = q.environment_id
      returning q.id, e.key as env_key, q.revision`);
    if (!rows.length) return 0;
    // coalesce: rebuild each environment's snapshot once, at its highest revision
    const byEnv = new Map<string, QueueRow[]>();
    for (const r of rows) {
      const list = byEnv.get(r.env_key);
      if (list) list.push(r); else byEnv.set(r.env_key, [r]);
    }
    for (const [env, list] of byEnv) {
      const ids = list.map((r) => r.id);
      let scope: PublishScope;
      try {
        const snap = await plane.refresh(db, env);
        await db.query(`update publish_queue set published_at = now() where id = any($1::bigint[])`, [ids]);
        // whose answers these versions changed: the purge drops only their files (cdn.ts)
        scope = await scopeOfRevisions(db, env, list.map((r) => Number(r.revision))).catch(() => null);
        await tell(env, snap.revision);
        log(`published ${env}@${snap.revision}`);
      } catch (e) {
        // what an environment serves is stuck at its old snapshot until this works: said in the log every time, and
        // /readyz names the environment in `failing` while its publish waits with an error (index.ts readiness)
        const said = (e as Error)?.message ?? String(e);
        const top = list.reduce((a, r) => Math.max(a, Number(r.revision)), 0);
        log(`publishing ${env}@${top} failed (it serves what it served before; trying again in 30 seconds): ${said}`);
        await db.query(`update publish_queue set last_error = $2 where id = any($1::bigint[])`, [ids, said]);
        continue;
      }
      // The plugins' onPublish (a CDN purge) runs on its own, after the rows are marked: a slow or failed purge only
      // delays the change by the CDN's minute, and never holds up this loop (other publishes, scheduled applies).
      if (onPublish) {
        afterPublish(onPublish, env, ids, scope);
        purgeAgainLater(onPublish, env, ids, scope);
      }
    }
    return rows.length;
  }

  // Once more, later: a CDN that refilled from a server still behind gets the new file (PURGE_AGAIN_MS). A publish in
  // the meantime moves it on, so a burst of them ends with one, for what all of them changed.
  function purgeAgainLater(hook: OnPublish, env: string, ids: string[], scope: PublishScope) {
    const waiting = purgesAgain.get(env);
    if (waiting) clearTimeout(waiting.timer);
    const due = waiting ? { scope: joinScopes(waiting.scope, scope), ids: [...waiting.ids, ...ids] } : { scope, ids };
    const timer = setTimeout(() => {
      purgesAgain.delete(env);
      if (!stopped) afterPublish(hook, env, due.ids, due.scope);
    }, opts.purgeAgainAfterMs ?? PURGE_AGAIN_MS);
    timer.unref?.();
    purgesAgain.set(env, { timer, ...due });
  }

  // Only an answer of 'purged' says a cache was purged (Settings → CDN shows when), and clears a failed purge's error.
  // A failure is logged, and kept on the rows as "purge: <plugin>: <what went wrong>", the words Settings → CDN shows
  // (web/src/pages/cdn.tsx) and /readyz warns of (publishState).
  function afterPublish(hook: OnPublish, env: string, ids: string[], scope: PublishScope) {
    const purged = () => db.query(`update publish_queue set purged_at = now(),
        last_error = case when last_error like 'purge:%' then null else last_error end where id = any($1::bigint[])`, [ids]).catch(() => {});
    let p: ReturnType<OnPublish>;
    try { p = hook(env, scope); } catch (e) { p = Promise.reject(e); }
    p.then(async (done) => {
      if (done === 'purged') await purged();
    }, async (e) => {
      const said = (e as Error)?.message ?? String(e);
      log(`after publishing ${env}: ${said}`);
      if ((e as { purged?: unknown })?.purged === true) await purged();
      await db.query(`update publish_queue set last_error = $2 where id = any($1::bigint[])`, [ids, `purge: ${said}`]).catch(() => {});
    });
  }

  async function scheduleOnce() {
    const due = await all<{ id: string }>(db, `select id from change_set where status = 'scheduled' and scheduled_at <= now() order by scheduled_at limit 10`);
    for (const d of due) {
      try {
        await applyChangeSet(db, Number(d.id), { name: 'scheduler', type: 'scheduler' });
        log(`scheduled change set #${d.id} applied`);
      } catch (e) {
        log(`scheduled change set #${d.id} not applied: ${(e as Error).message}`);
      }
    }
  }

  // Several server processes can share one database. Each publishes what it changes itself (the journal refreshes its
  // snapshot at once, and the outbox above purges the CDN once, whichever process claims the row). The others notice
  // here, on every round: an environment whose revision is ahead of this process's snapshot, or one it has never seen,
  // is rebuilt, and the consoles and event streams connected to this process hear about it (also when the snapshot
  // was already rebuilt, by OFREP, or by this process's own change whose outbox row another process claimed). Links,
  // API keys and apps cached here are dropped too, so a replaced link stops working here as well.
  async function catchUp() {
    const envs = await all<{ key: string; revision: string; pending: boolean }>(db, `
      select e.key, e.revision, exists (select 1 from publish_queue q where q.environment_id = e.id and q.published_at is null) as pending
      from environment e`);
    let changed = false;
    for (const e of envs) {
      const revision = Number(e.revision);
      const cur = plane.snapshots.get(e.key);
      const current = !!cur && cur.revision >= revision;
      // rebuilt already: whoever publishes its outbox row tells its own listeners, so wait while one is waiting
      if (current && ((told.get(e.key) ?? cur.revision) >= revision || e.pending)) continue;
      const snap = current ? cur : await plane.refresh(db, e.key);
      await tell(e.key, snap.revision);
      changed = true;
    }
    if (changed) opts.onRemoteChange?.();
  }

  // The publish log (publish_queue) gets a row per publish: rows older than the retention are dropped, once an hour,
  // keeping each environment's newest (Settings → CDN shows how the last purges went).
  let prunedAt = 0;
  async function pruneOnce() {
    if (Date.now() - prunedAt < (opts.pruneEveryMs ?? PRUNE_EVERY_MS)) return;
    prunedAt = Date.now();
    const r = await db.query(`delete from publish_queue q where q.published_at is not null
        and q.published_at < now() - make_interval(days => $1)
        and q.id <> (select max(n.id) from publish_queue n where n.environment_id = q.environment_id)`, [opts.publishLogDays ?? 30]);
    if (r.affected) log(`dropped ${r.affected} publish log rows older than ${opts.publishLogDays ?? 30} days`);
  }

  let stopped = false;
  let current: Promise<void> | null = null;
  const loop = (): Promise<void> => {
    if (current) return current;
    if (stopped) return Promise.resolve();
    current = (async () => {
      await scheduleOnce();
      while ((await publishOnce()) > 0) { /* drain */ }
      await catchUp().catch((e) => log(`catching up with other servers: ${(e as Error).message ?? e}`));
      await pruneOnce().catch((e) => log(`dropping old publish log rows: ${(e as Error).message ?? e}`));
    })().finally(() => { current = null; });
    return current;
  };

  // Poll as the correctness path; wake() is the fast-path hint (the role LISTEN/NOTIFY plays on real Postgres).
  const timer = setInterval(() => { loop().catch((e) => log(`worker error: ${e}`)); }, ROUND_MS);
  return {
    wake: () => { if (!stopped) setImmediate(() => loop().catch((e) => log(`worker error: ${e}`))); },
    /** No new rounds; resolves once the round in progress (if any) has finished, so the database can be closed. */
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      for (const w of purgesAgain.values()) clearTimeout(w.timer);
      purgesAgain.clear();
      if (current) await current.catch(() => {});
    },
    drain: async () => { if (current) await current.catch(() => {}); await loop(); },
  };
}
