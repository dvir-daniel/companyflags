// Flags as code (server/flagsAsCode.ts): what the file owns, its scope, the record of what it last applied, requests
// that a push reuses instead of filing again, the default of existing flags, and the note (reason, link) on a push.
// dev applies at once; prod needs an approval (test/fixtures.ts).

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.ts';
import { DEFINITION, OWNABLE, describe, hasChanges, planFlags, pullFlags, pushFlags, type FlagsFile, type Plan } from '../server/flagsAsCode.ts';
import type { Actor } from '../server/layers.ts';
import { ownedWords } from '../web/src/pages/managedKit.ts';

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.stop(); });

const alice: Actor = { name: 'alice', type: 'user' };
const plan = (file: unknown) => planFlags(t.db, file);
async function push(file: unknown, note = {}) {
  const p = await plan(file);
  assert.deepEqual(p.problems, [], p.problems.join('\n'));
  return { plan: p, done: await pushFlags(t.db, p, alice, note) };
}
const lines = (p: Plan) => p.steps.map(describe);
const count = async (sql: string, params: unknown[] = []) => Number((await t.db.query<{ n: string }>(`select count(*) as n from (${sql}) x`, params)).rows[0].n);
const openRequests = (flag: string) => count(`select cs.id from change_set cs join change_set_item i on i.change_set_id = cs.id
  join flag f on f.id = i.flag_id where f.key = $1 and cs.status = 'in_review'`, [flag]);

test('a push again files no second request: the plan shows the open one, and push reuses it', async () => {
  const file: FlagsFile = { owns: [...OWNABLE], flags: { fac_reuse: { kind: 'ops', type: 'bool', services: { dev: ['web'], prod: ['web'] } } } };
  await push(file);
  file.flags.fac_reuse.services = { dev: ['web'], prod: ['web', 'ios'] };
  const first = await push(file);
  assert.equal(first.done[0].result, 'request');
  const request = first.done[0].request!;

  const again = await plan(file);
  assert.deepEqual(lines(again), [`services of fac_reuse in prod: web → web, ios (waiting in request #${request})`]);
  assert.equal(hasChanges(again), false, 'a step waiting in its request is no change');
  for (let i = 0; i < 3; i++) {
    const r = await pushFlags(t.db, await plan(file), alice);
    assert.deepEqual(r.map((d) => [d.result, d.request, d.reused]), [['request', request, true]]);
  }
  assert.equal(await openRequests('fac_reuse'), 1, 'one request, however many pushes');

  // a different change is a request of its own; the plan lists the one still open as waiting
  file.flags.fac_reuse.services = { dev: ['web'], prod: ['web', 'android'] };
  const other = await plan(file);
  assert.equal(other.steps[0].request, undefined);
  assert.deepEqual(other.waiting.map((w) => w.request), [request]);
});

test('--reason and the link are on the request and in History', async () => {
  const file: FlagsFile = { owns: [...OWNABLE], flags: { fac_note: { kind: 'ops', type: 'bool', description: 'one', services: { dev: [], prod: [] } } } };
  await push(file);
  file.flags.fac_note.description = 'two';
  file.flags.fac_note.services = { dev: ['web'], prod: ['web'] };
  const link = 'https://github.com/acme/web/pull/12';
  const { done } = await push(file, { reason: 'Web gets the note', link });
  const request = done.find((d) => d.result === 'request')!.request;
  const cs = (await t.as('bob').get(`/change-sets/${request}`)).json;
  assert.equal(cs.reason ?? cs.changeSet?.reason, `Web gets the note: services of fac_note in prod: none → web (${link})`);
  const h = await t.db.query<{ change_type: string; comment: string | null; after: { steps: string[]; link: string } }>(
    `select change_type, comment, after from change_history where change_type in ('flags.push', 'delivery.update') order by id desc limit 2`);
  const pushed = h.rows.find((r) => r.change_type === 'flags.push')!;
  assert.equal(pushed.comment, `Web gets the note · ${link}`);
  assert.deepEqual(pushed.after.steps, ['change fac_note: description', 'services of fac_note in dev: none → web',
    `services of fac_note in prod: none → web (request #${request})`]);
  assert.match(h.rows.find((r) => r.change_type === 'delivery.update')!.comment ?? '', /^Web gets the note: services of fac_note in dev/);
  await assert.rejects(pushFlags(t.db, await plan(file), alice, { link: 'javascript:alert(1)' }), /the link is an http or https address/);
});

test('owns: a file without it owns the definition, not the services; a field it doesn’t own can’t be in it', async () => {
  assert.ok(!DEFINITION.includes('services'));
  const bad = await plan({ flags: { fac_owns: { kind: 'ops', type: 'bool', services: { dev: ['web'] } } } });
  assert.deepEqual(bad.problems, ['fac_owns: services is in the file, but the file doesn’t own it: add "services" to "owns", or take it out']);
  const narrow = await plan({ owns: ['description'], flags: { fac_owns: { kind: 'ops', type: 'bool', name: 'Owns' } } });
  assert.match(narrow.problems.join('\n'), /fac_owns: name is in the file, but the file doesn’t own it/);
  const typo = await plan({ owns: ['rules'], flags: { fac_owns: { kind: 'ops', type: 'bool', descripton: 'x' } }, extra: 1 });
  assert.deepEqual(typo.problems.map((p) => p.split(':')[0]), ['"extra" isn’t a field of the file', 'owns is a list of fields', 'fac_owns']);
});

test('the last-applied record: the console shows "Managed in repo", and the plan says which steps undo a console edit', async () => {
  const file: FlagsFile = { source: 'acme/web', owns: ['description', 'owner', 'services'],
    flags: { fac_managed: { kind: 'ops', type: 'bool', description: 'From the repo', owner: 'payments', services: { dev: ['web'], prod: [] } } } };
  await push(file);
  const m = (await t.as('alice').get('/flags-as-code/managed/fac_managed')).json.managed;
  assert.deepEqual([m.source, m.fields, m.appliedBy], ['acme/web', ['description', 'owner', 'services'], 'alice']);
  assert.equal((await t.as('alice').get('/flags-as-code/managed/new_checkout')).json.managed, null);

  // an edit in the console to a field the file owns: the next plan undoes it, and says so
  assert.equal((await t.as('alice').put('/flags/fac_managed/meta', { description: 'Edited in the console' })).status, 200);
  const p = await plan(file);
  assert.deepEqual(lines(p), ['change fac_managed: description (undoes a change made outside this file since its last push)']);
  // a change in the file alone is a plain step
  file.flags.fac_managed.owner = 'growth';
  await push({ ...file, flags: { fac_managed: { ...file.flags.fac_managed, description: 'Edited in the console' } } });
  assert.deepEqual(lines(await plan(file)), ['change fac_managed: description']);

  // another file can't take it over; a file that drops it lets it go
  const other = await plan({ ...file, source: 'acme/ios' });
  assert.deepEqual(other.problems, ['fac_managed: the file "acme/web" manages it: a flag is managed by one file']);
  await push({ ...file, scope: { prefix: 'fac_managed' }, flags: {} });
  assert.equal((await t.as('alice').get('/flags-as-code/managed/fac_managed')).json.managed, null);
  // the console's words for the fields (web/src/pages/managedInRepo.tsx)
  assert.equal(ownedWords(m.fields), 'kind, description, owner and services');
  assert.equal(ownedWords([]), 'kind');
});

test('default applies to existing flags: at once where nothing needs approval, as a request (reused) where it does', async () => {
  const file: FlagsFile = { flags: { fac_default: { kind: 'config', type: 'string', variants: { a: 'A', b: 'B' }, default: 'a' } } };
  await push(file);
  assert.equal((await pullFlags(t.db)).flags.fac_default.default, 'a', 'pull writes the default every environment serves');
  file.flags.fac_default.default = 'b';
  const p = await plan(file);
  assert.deepEqual(lines(p), ['default of fac_default in dev: a → b', 'default of fac_default in prod: a → b (a request: it needs approval there)']);
  const { done } = await push(file);
  assert.deepEqual(done.map((d) => d.result), ['done', 'request']);
  const flag = (await t.as('alice').get('/flags/fac_default')).json;
  assert.deepEqual([flag.layers.dev.base.defaultVariation, flag.layers.prod.base.defaultVariation], ['b', 'a']);
  assert.deepEqual(lines(await plan(file)), [`default of fac_default in prod: a → b (waiting in request #${done[1].request})`]);
  await pushFlags(t.db, await plan(file), alice);
  assert.equal(await openRequests('fac_default'), 1);
  const typo = await plan({ flags: { fac_default: { ...file.flags.fac_default, variants: undefined, default: 'c' } } });
  assert.deepEqual(typo.problems, ['fac_default: default "c" isn’t one of its variants']);
});

test('scope: a prefix or services the file owns; it refuses flags outside them and lists only its own', async () => {
  const mine: FlagsFile = { owns: [...OWNABLE], scope: { prefix: 'fac_scope_' }, flags: { fac_scope_a: { kind: 'ops', type: 'bool', services: { dev: ['web'] } } } };
  await push(mine);
  await push({ owns: [...OWNABLE], flags: { fac_scope_b: { kind: 'ops', type: 'bool', services: { dev: ['ios'] } } } });
  const p = await plan(mine);
  assert.deepEqual(p.onlyHere, ['fac_scope_b'], 'only the flags in its scope');
  const outside = await plan({ ...mine, flags: { ...mine.flags, new_checkout: { kind: 'release', type: 'bool' } } });
  assert.deepEqual(outside.problems, ['new_checkout: outside this file’s scope: its keys start with "fac_scope_"']);

  const web: FlagsFile = { owns: [...OWNABLE], scope: { services: ['web'] }, flags: { fac_scope_a: { kind: 'ops', type: 'bool', services: { dev: ['web'], prod: ['web'] } } } };
  assert.deepEqual((await plan(web)).problems, []);
  assert.ok(!(await plan(web)).onlyHere.includes('fac_scope_b'), 'a flag in ios belongs to another file');
  const ios = await plan({ ...web, flags: { fac_scope_b: { kind: 'ops', type: 'bool' } } });
  assert.deepEqual(ios.problems, ['fac_scope_b: it is also in ios, outside this file’s scope: another file or the console owns it']);
  const names = await plan({ ...web, flags: { fac_scope_a: { kind: 'ops', type: 'bool', services: { dev: ['web', 'android'] } } } });
  assert.deepEqual(names.problems, ['fac_scope_a: android is outside this file’s scope (services: web)']);
});
