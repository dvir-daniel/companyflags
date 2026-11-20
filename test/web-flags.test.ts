// The Flags list's helpers (web/src/pages/flagsKit.ts): every flag a filter matches across pages, the bulk switch as
// publish items and batches, the CSV, overdue flags, and what a new flag starts on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODE_DEFAULT, type FlagDetail } from '../web/src/api.ts';
import {
  allMatching, density, flagsCsv, isOverdue, mapLimit, ROW_CLASS, startDefault, startsLine, switchBatches, switchItems, versionsHref,
  type FlagPage, type Row,
} from '../web/src/pages/flagsKit.ts';

const row = (key: string, over: Partial<Row> = {}): Row => ({
  key, name: null, tags: [], valueType: 'bool', kind: 'release', description: null, owner: null, removeBy: null, archivedAt: null,
  delivery: {}, envs: { dev: { enabled: true, entityLayers: 0, defaultVariation: 'on', defaultValue: true, rules: 0 } }, ...over,
});
const base = (enabled: boolean, version = 3) => ({
  version, enabled, variationWhenOff: null, defaultVariation: 'on', inherit: null, rules: [], updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'alice',
});
const detail = (key: string, enabled: boolean, o: Partial<FlagDetail> = {}): FlagDetail => ({
  key, name: null, tags: [], valueType: 'bool', kind: 'release', description: null, owner: null, removeBy: null, archivedAt: null,
  variations: [], delivery: {}, layers: { prod: { base: base(enabled), entities: [] } }, ...o,
});

test('every flag a filter matches, a page of 200 at a time, until the count is reached', async () => {
  const rows = Array.from({ length: 450 }, (_, i) => row(`f${i}`));
  const asked: string[] = [];
  const get = async (path: string): Promise<FlagPage> => {
    asked.push(path);
    const u = new URL(path, 'http://x');
    const page = Number(u.searchParams.get('page')); const size = Number(u.searchParams.get('size'));
    return { rows: rows.slice(page * size, (page + 1) * size), matched: rows.length, all: 500, page, size };
  };
  const got = await allMatching({ env: 'prod', q: 'f', status: 'on', kind: '', owner: '', tag: '', sort: 'key', dir: 'asc', stale: '' }, get);
  assert.equal(got.length, 450);
  assert.equal(asked.length, 3);
  assert.ok(asked.every((p) => p.includes('size=200') && p.includes('status=on') && p.includes('q=f')), 'the same filters on every page');
  // an empty answer ends it, whatever the count says
  assert.deepEqual(await allMatching({ env: 'prod', q: '', status: '', kind: '', owner: '', tag: '', sort: 'key', dir: 'asc' },
    async () => ({ rows: [], matched: 10, all: 10, page: 0, size: 200 })), []);
});

test('the bulk switch: each flag’s defaults with On/off set, against its version; flags already that way are left out', () => {
  const items = switchItems([detail('a', true), detail('b', false), detail('c', true, { archivedAt: '2026-01-01' }), detail('d', true, { layers: {} })], 'prod', false);
  assert.deepEqual(items, [{ flag: 'a', entity: null, expectedVersion: 3,
    layer: { enabled: false, variationWhenOff: null, defaultVariation: 'on', inherit: null, rules: [] } }]);
  assert.ok(!('version' in items[0].layer) && !('updatedAt' in items[0].layer), 'only the settings, not when or by whom');
  assert.deepEqual(switchItems([detail('a', true), detail('b', false)], 'prod', true).map((i) => i.flag), ['b']);
});

test('the bulk switch goes in at most three batches: now, one request, and break-glass', () => {
  assert.deepEqual(switchBatches([{ key: 'a', path: 'now' }, { key: 'b', path: 'review' }, { key: 'c', path: 'break-glass' }, { key: 'd', path: 'review' }]),
    { now: ['a'], review: ['b', 'd'], breakGlass: ['c'] });
});

test('several reads at once, never more than the limit, answers in order', async () => {
  let running = 0; let most = 0;
  const out = await mapLimit([5, 1, 3, 2, 4, 0, 6], 3, async (n) => {
    running++; most = Math.max(most, running);
    await new Promise((r) => setTimeout(r, n));
    running--;
    return n * 10;
  });
  assert.deepEqual(out, [50, 10, 30, 20, 40, 0, 60]);
  assert.ok(most <= 3);
  assert.deepEqual(await mapLimit([], 3, async (n: number) => n), []);
});

test('the CSV has a status per environment and the remove-by date', () => {
  const t = flagsCsv([row('a', { tags: ['x', 'y'], removeBy: '2027-01-31', envs: { dev: { enabled: true, entityLayers: 0, defaultVariation: 'on', defaultValue: true, rules: 0 } } })], ['dev', 'prod']);
  assert.deepEqual(t.header, ['key', 'name', 'tags', 'dev_status', 'prod_status', 'type', 'purpose', 'owner', 'remove_by', 'last_version', 'changed_at']);
  assert.deepEqual(t.rows[0].slice(0, 5), ['a', null, 'x y', 'on', 'off']);
  assert.equal(t.rows[0][8], '2027-01-31');
});

test('overdue: past the remove-by date, not on it', () => {
  assert.equal(isOverdue('2026-11-19', '2026-11-20'), true);
  assert.equal(isOverdue('2026-11-20', '2026-11-20'), false);
  assert.equal(isOverdue(null, '2026-11-20'), false);
});

test('density: two looks, comfortable unless compact was chosen', () => {
  assert.equal(density('compact'), 'compact');
  assert.equal(density('nonsense'), 'comfortable');
  assert.notEqual(ROW_CLASS.compact, ROW_CLASS.comfortable);
});

test('a new flag starts on a named value, never the code default', () => {
  assert.equal(startDefault([{ key: 'on' }, { key: 'off' }], 'bool'), 'off');
  assert.equal(startDefault([{ key: 'default' }], 'string'), 'default');
  assert.equal(startDefault([{ key: '' }, { key: 'fast' }], 'json'), 'fast');
  assert.equal(startDefault([], 'string'), CODE_DEFAULT, 'only with no value at all');
});

test('the New flag dialog says where the flag starts on, and what everyone gets there', () => {
  const envs = [{ name: 'Development', reviewed: false }, { name: 'Staging', reviewed: false }, { name: 'Production', reviewed: true }];
  assert.equal(startsLine(envs, 'off (false)'),
    'Starts on in Development and Staging: everyone gets off (false). Starts off in Production until it’s turned on there, so apps use the default in their code.');
  assert.equal(startsLine(envs.slice(0, 1), ''), 'Starts on in Development: apps use the default in their code.');
  assert.equal(startsLine(envs.slice(2), 'on'), 'Starts off in Production until it’s turned on there, so apps use the default in their code.');
});

test('an environment’s versions are in History', () => {
  assert.equal(versionsHref('prod'), '#/history?view=versions&env=prod');
  assert.equal(versionsHref('a&b'), '#/history?view=versions&env=a%26b');
});
