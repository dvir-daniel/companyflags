// Background workers: the outbox publisher (each change waits in publish_queue until its environment's new snapshot is
// built), the runner of change sets scheduled for later, and catching up with publishes made by other server processes
// on the same database.

import { all, type Db } from './db.ts';
import type { EventHub } from './events.ts';
import { applyChangeSet } from './layers.ts';
import type { DataPlane } from './snapshot.ts';
import type { OnPublish } from './plugin.ts';

type QueueRow = { id: string; env_key: string; revision: string };

export type WorkerOptions = {
  /** Called when another server process changed what an environment serves: drop what this one keeps in memory. */
  onRemoteChange?: () => void;
};

export function startWorkers(db: Db, plane: DataPlane, hub: EventHub, log: (m: string) => void = () => {}, onPublish?: OnPublish, opts: WorkerOptions = {}) {
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
      try {
        const snap = await plane.refresh(db, env);
        await db.query(`update publish_queue set published_at = now() where id = any($1::bigint[])`, [ids]);
        hub.publish(env, snap.revision);
        log(`published ${env}@${snap.revision}`);
      } catch (e) {
        await db.query(`update publish_queue set last_error = $2 where id = any($1::bigint[])`, [ids, String(e)]);
        continue;
      }
      // The plugins' onPublish (a CDN purge) runs on its own, after the rows are marked: a slow or failed purge only
      // delays the change by the CDN's minute, and never holds up this loop (other publishes, scheduled applies).
      if (onPublish) afterPublish(onPublish, env, ids);
    }
    return rows.length;
  }

  // Only an answer of 'purged' says a cache was purged (Settings → CDN shows when). A failure is logged, and kept on
  // the rows as "purge: <plugin>: <what went wrong>", the words Settings → CDN shows (web/src/pages/cdn.tsx).
  function afterPublish(hook: OnPublish, env: string, ids: string[]) {
    const purged = () => db.query(`update publish_queue set purged_at = now() where id = any($1::bigint[])`, [ids]).catch(() => {});
    let p: ReturnType<OnPublish>;
    try { p = hook(env); } catch (e) { p = Promise.reject(e); }
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
  // is rebuilt, and the consoles connected to this process hear about it. Links, API keys and apps cached here are
  // dropped too, so a replaced link stops working here as well.
  async function catchUp() {
    const envs = await all<{ key: string; revision: string }>(db, `select key, revision from environment`);
    let changed = false;
    for (const e of envs) {
      const cur = plane.snapshots.get(e.key);
      if (cur && cur.revision >= Number(e.revision)) continue;
      const snap = await plane.refresh(db, e.key);
      hub.publish(e.key, snap.revision);
      changed = true;
    }
    if (changed) opts.onRemoteChange?.();
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
    })().finally(() => { current = null; });
    return current;
  };

  // Poll as the correctness path; wake() is the fast-path hint (the role LISTEN/NOTIFY plays on real Postgres).
  const timer = setInterval(() => { loop().catch((e) => log(`worker error: ${e}`)); }, 1000);
  return {
    wake: () => { if (!stopped) setImmediate(() => loop().catch((e) => log(`worker error: ${e}`))); },
    /** No new rounds; resolves once the round in progress (if any) has finished, so the database can be closed. */
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      if (current) await current.catch(() => {});
    },
    drain: async () => { if (current) await current.catch(() => {}); await loop(); },
  };
}
