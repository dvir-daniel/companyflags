// Import and export (server/values.ts): another system's values in, ours out, in CompanyFlags values, key-value
// JSON, flagd and JSONata. An import shows what it would change first, refuses everything while anything is wrong,
// creates missing flags only when asked (in no service, so apps keep reading the old system), sets entities' own
// values, and asks for review where approval is needed. An export imports back unchanged, and the values it gives for an
// entity are what the evaluator answers.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.ts';
import { runJsonata } from '../server/transform.ts';

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.stop(); });

const exportOf = async (format: string, o: Record<string, unknown> = {}, by = 'alice') => {
  const r = await t.as(by).post('/migration/export', { environment: 'dev', format, ...o });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.output;
};
const preview = (body: Record<string, unknown>) => t.as('dana').post('/migration/preview', { environment: 'dev', ...body });
const doImport = async (body: Record<string, unknown>) => { const r = await t.as('dana').post('/migration/import', { environment: 'dev', ...body }); await t.settle(); return r; };

test('an export imports back unchanged', async () => {
  const values = await exportOf('values');
  assert.equal(values.flags.max_upload_mb.value, 100);
  assert.deepEqual(values.flags.max_upload_mb.variants, { standard: 100, enterprise: 1000, huge: 5000 });
  const plan = (await preview({ format: 'values', input: values })).json.plan;
  assert.deepEqual([plan.problems, plan.changes, plan.create], [[], [], []]);
  assert.equal(plan.unchanged, Object.keys(values.flags).length);
});

test('only admins import; everyone can export', async () => {
  assert.equal((await t.as('alice').post('/migration/preview', { environment: 'dev', format: 'kv', input: {} })).status, 403);
  assert.equal((await t.as('alice').post('/migration/import', { environment: 'dev', format: 'kv', input: {} })).status, 403);
  assert.equal(typeof (await exportOf('kv')).max_upload_mb, 'number');
});

test('the preview says what would change, and every problem; with a problem nothing is imported', async () => {
  const body = { format: 'kv', text: JSON.stringify({ max_upload_mb: 1000, new_checkout: 'yes', 'Bad-Key': 1, old_only_flag: 3 }) };
  const plan = (await preview(body)).json.plan;
  assert.deepEqual(plan.changes, [{ flag: 'max_upload_mb', entity: null, text: 'Everyone gets 1000 (was 100)' }]);
  assert.deepEqual(plan.problems, [
    'Bad-Key: a flag key has lowercase letters, digits and underscores, and starts with a letter.',
    'new_checkout: its values are true or false, not "yes".',
    'old_only_flag: there’s no such flag. Turn on “Create missing flags”, or create it first.',
  ], 'every problem at once');
  const r = await doImport({ format: 'kv', input: { max_upload_mb: 1000, new_checkout: 'yes' } });
  assert.equal(r.status, 422);
  assert.equal((await t.baseOf('max_upload_mb', 'dev')).layer.defaultVariation, 'standard', 'nothing changed');
});

test('a missing flag is created when asked: a config flag in no service, so apps keep reading the old system', async () => {
  const input = { flags: { banner_text: { value: 'Hello', name: 'Banner text', entities: { acme: 'Hello, Acme' } } } };
  const plan = (await preview({ format: 'values', input, createFlags: true })).json.plan;
  assert.deepEqual(plan.create.map((l: { text: string }) => l.text), ['New flag: everyone gets "Hello", 1 entity gets its own value, in no service yet']);
  const r = await doImport({ format: 'values', input, createFlags: true, reason: 'From the old config service' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.created, r.json.applied], [1, true]);
  const flag = (await t.as('alice').get('/flags/banner_text')).json;
  assert.equal(flag.kind ?? flag.flag?.kind, 'config');
  assert.deepEqual(flag.delivery ?? flag.flag?.delivery, { dev: [], prod: [] });
  // not in the web service: OFREP says it isn't there, so OpenFeature's Multi-Provider asks the old system
  const before = await t.trace({ service: 'web', entity: 'acme', flag: 'banner_text' });
  assert.equal(before.errorCode, 'FLAG_NOT_FOUND');
  // in the web service: acme gets its own value, everyone else the default
  assert.equal((await t.as('alice').put('/flags/banner_text/delivery', { environment: 'dev', services: ['web'], before: [] })).status, 200);
  await t.settle();
  assert.equal((await t.trace({ service: 'web', entity: 'acme', flag: 'banner_text' })).value, 'Hello, Acme');
  assert.equal((await t.trace({ service: 'web', entity: 'globex', flag: 'banner_text' })).value, 'Hello');
  // and the export says the same
  assert.deepEqual((await exportOf('values')).flags.banner_text, { value: 'Hello', on: true, entities: { acme: 'Hello, Acme' } });
});

test('entities: a value sets its own default, null removes its own settings', async () => {
  let r = await doImport({ format: 'values', input: { flags: { max_upload_mb: { entities: { globex: 1000 } } } } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await t.trace({ service: 'web', entity: 'globex', flag: 'max_upload_mb' })).value, 1000);
  assert.equal((await exportOf('values')).flags.max_upload_mb.entities.globex, 1000);
  r = await doImport({ format: 'values', input: { flags: { max_upload_mb: { entities: { globex: null } } } } });
  assert.equal(r.json.changed, 1);
  assert.equal((await t.trace({ service: 'web', entity: 'globex', flag: 'max_upload_mb' })).value, 100);
  const plan = (await preview({ format: 'values', input: { flags: { max_upload_mb: { entities: { nobody: 1 } } } } })).json.plan;
  assert.deepEqual(plan.problems, ['max_upload_mb: there’s no entity “nobody”.']);
});

test('a value that isn’t one of a flag’s variants is refused for everyone’s default (it has named variants)', async () => {
  const plan = (await preview({ format: 'kv', input: { max_upload_mb: 42 } })).json.plan;
  assert.deepEqual(plan.problems, ['max_upload_mb: 42 isn’t one of its variants (standard = 100, enterprise = 1000, huge = 5000).']);
  const added = (await preview({ format: 'values', input: { flags: { max_upload_mb: { value: 42, variants: { small: 42 } } } } })).json.plan;
  assert.deepEqual([added.problems, added.changes.map((l: { text: string }) => l.text)], [[], ['New variant small: 42', 'Everyone gets 42 (was 100)']]);
});

test('flagd in: the default and on/off, targeting left with a warning; flagd out: one service’s file', async () => {
  const plan = (await preview({ format: 'flagd', input: { flags: {
    new_checkout: { state: 'DISABLED', variants: { on: true, off: false }, defaultVariant: 'off', targeting: { fractional: [['on', 50], ['off', 50]] } },
  } } })).json.plan;
  assert.deepEqual(plan.changes.map((l: { text: string }) => l.text), ['Switched off']);
  assert.deepEqual(plan.warnings, ['new_checkout: its targeting isn’t brought over, only its default and on/off. Add rules in the console.']);
  assert.equal((await t.as('alice').post('/migration/export', { environment: 'dev', format: 'flagd' })).status, 422, 'which service’s file?');
  const file = await exportOf('flagd', { service: 'server-ds' });
  assert.equal(file.$schema, 'https://flagd.dev/schema/v0/flags.json');
  assert.ok(file.flags.max_upload_mb);
});

test('JSONata in and out: any shape, made into or from a values document', async () => {
  const oldShape = { settings: [{ name: 'max_upload_mb', value: 5000 }] };
  const plan = (await preview({ format: 'jsonata', input: oldShape, expression: '{ "flags": settings{ name: { "value": value } } }' })).json.plan;
  assert.deepEqual(plan.changes.map((l: { text: string }) => l.text), ['Everyone gets 5000 (was 100)']);
  const expression = 'flags.$each(function($v, $k) { { "name": $k, "value": $v.value } })[name = "max_upload_mb"]';
  const out = await exportOf('jsonata', { expression }, 'dana');
  assert.deepEqual(out, { name: 'max_upload_mb', value: 100 });
  const editor = await t.as('alice').post('/migration/export', { environment: 'dev', format: 'jsonata', expression });
  assert.equal(editor.status, 403, 'an expression runs on the server: only admins, as for an import');
  const broken = await preview({ format: 'jsonata', input: {}, expression: '{ "flags": ' });
  assert.equal(broken.status, 422);
  assert.match(broken.json.error, /^The JSONata expression doesn’t read/);
});

test('a JSONata expression that runs without end is stopped', async () => {
  await assert.rejects(runJsonata('($f := function($x) { 1 + $f($x) }; $f(0))', {}), /levels deep/);
  // JSONata turns a call in tail position into a loop: the time limit stops that one
  await assert.rejects(runJsonata('($f := function($x) { $f($x + 1) }; $f(0))', {}, { timeoutMs: 50, maxDepth: 500 }), /ran longer than 50 ms/);
  await assert.rejects(runJsonata('$count([1..9000000].($ * 2))', {}, { timeoutMs: 50, maxDepth: 300 }), /ran longer than 50 ms/);
});

test('a JSONata expression that takes all the memory, makes too much or never returns stops, and the server goes on answering', async () => {
  const exporting = (expression: string) => t.as('dana').post('/migration/export', { environment: 'dev', format: 'jsonata', expression });
  // while each runs, the server answers others: it runs in a worker of its own, never on the server's own thread
  let answered = 0;
  const others = setInterval(() => { void t.call('GET', '/healthz').then((r) => { if (r.status === 200) answered++; }); }, 50);
  try {
    for (const [expression, said] of [
      // one built-in on a huge list; on a busy machine the time limit may stop it first
      ['$count($sort([1..3000000]))', /more memory than an expression may use|ran longer than 1000 ms/],
      ['$pad("", 50000000)', /result is larger than 4 MB/],
      ['$contains("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!", /^(a+)+$/)', /ran longer than 1000 ms/],   // a regular expression that backtracks without end
    ] as const) {
      const r = await exporting(expression);
      assert.equal(r.status, 422, expression);
      assert.match(r.json.error, said, expression);
    }
  } finally {
    clearInterval(others);
  }
  assert.ok(answered >= 10, `the server answered meanwhile (${answered} times)`);
  assert.deepEqual((await exportOf('jsonata', { expression: '$count($keys(flags)) > 0' }, 'dana')), true, 'and runs the next expression');
});

test('into an environment that needs approval, the changes are one request', async () => {
  const r = await t.as('dana').post('/migration/import', { environment: 'prod', format: 'kv', input: { max_upload_mb: 1000 }, reason: 'Matching the old system' });
  await t.settle();
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.applied, false);
  const cs = (await t.as('bob').get(`/change-sets/${r.json.request}`)).json;
  assert.equal(JSON.stringify(cs).includes('Matching the old system'), true);
  assert.equal((await t.baseOf('max_upload_mb', 'prod')).layer.defaultVariation, 'standard', 'not yet');
});
