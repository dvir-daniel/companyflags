// The change journal (server/journal.ts), at its interface: every kind of change is one history row per
// environment it reaches; a kind that changes what's served is also one new version and one publish there; its
// effects on the app's memory run once, only after the transaction commits; and it is declared restorable or not.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { openDb, type Db } from '../server/db.ts';
import { audit, change, changeEverywhere, journaled, KINDS, RESTORABLE, type ChangeKind, type Effects, type Env } from '../server/journal.ts';
import { randomSecret } from '../server/control.ts';
import type { Actor } from '../server/layers.ts';
import { testDatabase } from './helpers.ts';

const actor: Actor = { name: 'tester', type: 'user' };
let store: Db;
let db: Db;
let drop: () => Promise<void>;
let envs: Env[];
const calls: string[] = [];
const effects: Effects = {
  forgetClientLinks: () => { calls.push('forgetClientLinks'); },
  forgetClientApps: () => { calls.push('forgetClientApps'); },
  forgetApiKeys: () => { calls.push('forgetApiKeys'); },
  refresh: async (env) => { calls.push(`refresh ${env}`); },
  wake: () => { calls.push('wake'); },
};

before(async () => {
  const t = await testDatabase();
  drop = t.drop;
  store = (await openDb({ url: t.url })).db;
  await store.query(`insert into environment (key, name, min_approvals, link_secret) values ('dev', 'Development', 0, $1), ('prod', 'Production', 1, $2)`,
    [randomSecret(), randomSecret()]);
  envs = (await store.query<Env>(`select id, key from environment order by id`)).rows;
  db = journaled(store, effects);
});
after(async () => { await store.close(); await drop(); });

/** Revisions, history rows and outbox rows per environment (and history rows with no environment). */
async function state() {
  const n = async (sql: string, p: unknown[] = []) => Number((await store.query<{ n: number }>(sql, p)).rows[0].n);
  const out: Record<string, { revision: number; history: number; publishes: number }> = {};
  for (const e of envs) {
    out[e.key] = {
      revision: await n(`select revision as n from environment where id = $1`, [e.id]),
      history: await n(`select count(*) as n from change_history where environment_id = $1`, [e.id]),
      publishes: await n(`select count(*) as n from publish_queue where environment_id = $1`, [e.id]),
    };
  }
  return { envs: out, unplaced: await n(`select count(*) as n from change_history where environment_id is null`) };
}
const lastRows = async (n: number) => (await store.query<any>(`select h.*, e.key as env from change_history h
  left join environment e on e.id = h.environment_id order by h.id desc limit $1`, [n])).rows.reverse();

/** Records one change of `kind` the way its declaration says, in one transaction on the journaled database. */
async function record(kind: ChangeKind, entry: Record<string, unknown> = {}) {
  const k = KINDS[kind];
  await db.transaction(async (tx) => {
    if (k.serves === 'environment') await change(tx, envs[0], actor, { kind, ...entry });
    else if (k.serves === 'everywhere') await changeEverywhere(tx, actor, { kind, ...entry });
    else await audit(tx, actor, { kind, environment: envs[0].id, ...entry });
    assert.deepEqual(calls, [], `${kind}: nothing runs before the transaction commits`);
  });
}

for (const [kind, k] of Object.entries(KINDS) as [ChangeKind, (typeof KINDS)[ChangeKind]][]) {
  test(`${kind}: ${k.serves ? `a new version of ${k.serves === 'environment' ? 'one environment' : 'every environment'}` : 'history only'}, ${k.restore ? 'restorable' : 'not restored'}`, async () => {
    assert.equal(typeof k.restore, 'boolean', 'declared restorable or not');
    const was = await state();
    calls.length = 0;
    await record(kind, { flag: 'f', entity: 'c', before: { a: 1 }, after: { a: 2 }, comment: 'why' });
    const now = await state();
    const reached = k.serves === 'everywhere' ? envs : [envs[0]];
    for (const e of envs) {
      const hit = reached.includes(e);
      assert.equal(now.envs[e.key].revision - was.envs[e.key].revision, hit && k.serves ? 1 : 0, `${e.key}: the revision moves once when it changes what's served`);
      assert.equal(now.envs[e.key].history - was.envs[e.key].history, hit ? 1 : 0, `${e.key}: exactly one history row`);
      assert.equal(now.envs[e.key].publishes - was.envs[e.key].publishes, hit && k.serves ? 1 : 0, `${e.key}: one publish when it changes what's served`);
    }
    assert.equal(now.unplaced, was.unplaced);
    // one shape: every field said, and a served change carries its environment's new revision
    for (const row of await lastRows(reached.length)) {
      assert.deepEqual([row.change_type, row.changed_by, row.actor_type, row.flag, row.entity, row.before, row.after, row.comment],
        [kind, 'tester', 'user', 'f', 'c', { a: 1 }, { a: 2 }, 'why']);
      assert.equal(row.revision === null ? null : Number(row.revision), k.serves ? now.envs[row.env].revision : null);
    }
    // after the commit: its own effects once each, and the publisher woken when there's a version to publish
    const expected = [...('then' in k ? k.then : []).map((e) => (e === 'refresh' ? `refresh ${envs[0].key}` : e)), ...(k.serves ? ['wake'] : [])];
    assert.deepEqual([...calls].sort(), expected.sort());
  });
}

test('restore undoes flag settings only, and only kinds of one environment can be restorable', () => {
  assert.deepEqual([...RESTORABLE].sort(), ['layer.create', 'layer.delete', 'layer.update']);
  for (const kind of RESTORABLE) assert.equal(KINDS[kind].serves, 'environment', kind);
});

test('a rolled-back transaction runs no effects and leaves nothing behind', async () => {
  const was = await state();
  calls.length = 0;
  await assert.rejects(db.transaction(async (tx) => {
    await change(tx, envs[0], actor, { kind: 'environment.create' });
    await changeEverywhere(tx, actor, { kind: 'entity.create', entity: 'x' });
    await audit(tx, actor, { kind: 'api_key.revoke' });
    throw new Error('changed my mind');
  }), /changed my mind/);
  assert.deepEqual(calls, []);
  assert.deepEqual(await state(), was);
});

test('one version holds several changes; a transaction runs each effect once, after it commits', async () => {
  const was = await state();
  calls.length = 0;
  const revision = await db.transaction(async (tx) => {
    const r = await change(tx, envs[0], actor, [{ kind: 'layer.update', flag: 'a' }, { kind: 'layer.create', flag: 'b', entity: 'c' }]);
    await changeEverywhere(tx, actor, { kind: 'entity.update', entity: 'c' });
    await audit(tx, actor, { kind: 'api_key.revoke' });
    await audit(tx, actor, { kind: 'api_key.revoke' });
    return r;
  });
  assert.equal(revision, was.envs.dev.revision + 1);
  const rows = (await store.query<{ revision: number }>(`select revision from change_history where environment_id = $1 and flag in ('a', 'b')`, [envs[0].id])).rows;
  assert.deepEqual(rows.map((r) => Number(r.revision)), [revision, revision], 'both changes in the one version');
  assert.deepEqual([...calls].sort(), ['forgetApiKeys', 'wake']);
});

test('a kind is recorded only the way it is declared', async () => {
  await assert.rejects(db.transaction((tx) => change(tx, envs[0], actor, { kind: 'person.add' })), /recorded with audit/);
  await assert.rejects(db.transaction((tx) => change(tx, envs[0], actor, { kind: 'entity.update' })), /recorded with changeEverywhere/);
  await assert.rejects(db.transaction((tx) => audit(tx, actor, { kind: 'layer.update' })), /recorded with change,/);
  await assert.rejects(db.transaction((tx) => change(tx, envs[0], actor, [])), /at least one change/);
});

test('outside a transaction a statement commits at once, so its effects run at once', async () => {
  calls.length = 0;
  await audit(db, actor, { kind: 'api_key.revoke' });
  assert.deepEqual(calls, ['forgetApiKeys']);
  calls.length = 0;
  await audit(store, actor, { kind: 'api_key.revoke' });
  assert.deepEqual(calls, [], 'a database that isn’t journaled has nothing in memory to tell');
});

test('the journal is the only module that writes history, bumps a revision or enqueues a publish', () => {
  const dir = new URL('../server/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts') && x !== 'journal.ts')) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    assert.doesNotMatch(src, /insert into change_history/i, f);
    assert.doesNotMatch(src, /insert into publish_queue/i, f);
    assert.doesNotMatch(src, /revision\s*=\s*revision\s*\+/i, f);
  }
});
