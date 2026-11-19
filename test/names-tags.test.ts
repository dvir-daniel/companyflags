// Flags have a readable name next to their key, and tags to group them by team or area.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.ts';
import { cleanTags, keyFromName } from '../server/checks.ts';

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.stop(); });

const base = { enabled: false, defaultVariation: 'off', rules: [] };
const newFlag = (over: Record<string, unknown>) => ({
  key: 'search_ranking', valueType: 'bool', kind: 'ops', variations: [{ key: 'on', value: true }, { key: 'off', value: false }],
  delivery: {}, base, ...over,
});

test('a flag is created with a name and tags, cleaned up', async () => {
  const r = await t.as('alice').post('/flags', newFlag({ name: '  New search ranking ', tags: ['Search', 'web_app', 'search'] }));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const f = (await t.as('alice').get('/flags/search_ranking')).json;
  assert.equal(f.name, 'New search ranking');
  assert.deepEqual(f.tags, ['search', 'web-app']);                         // lowercase, dashes, no repeats
});

test('name and tags can be edited, and bad ones are refused', async () => {
  const r = await t.as('alice').put('/flags/search_ranking/meta', { name: 'Search ranking v2', tags: ['search'] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const f = (await t.as('alice').get('/flags/search_ranking')).json;
  assert.equal(f.name, 'Search ranking v2');
  assert.deepEqual(f.tags, ['search']);
  assert.equal((await t.as('alice').put('/flags/search_ranking/meta', { tags: ['no/slashes'] })).status, 422);
  assert.equal((await t.as('alice').put('/flags/search_ranking/meta', { name: 'x'.repeat(81) })).status, 422);
  assert.equal((await t.as('alice').put('/flags/search_ranking/meta', { name: '' })).status, 200);   // clearing the name is fine
  assert.equal((await t.as('alice').get('/flags/search_ranking')).json.name, null);
});

test('the list searches names and tags, filters by tag, and lists the tags in use', async () => {
  const byName = (await t.as('alice').get('/flags?environment=dev&page=0&q=checkout%20flow')).json;
  assert.deepEqual(byName.rows.map((f: any) => f.key), ['new_checkout']);
  const byTag = (await t.as('alice').get('/flags?environment=dev&page=0&tag=payments')).json;
  assert.ok(byTag.rows.length >= 2 && byTag.rows.every((f: any) => f.tags.includes('payments')));
  const all = (await t.as('alice').get('/flags?environment=dev&page=0&size=200')).json;
  assert.ok(all.tags.includes('payments') && all.tags.includes('search'));
  assert.equal(all.rows.find((f: any) => f.key === 'new_checkout').name, 'New checkout flow');
});

test('keys suggested from names follow the key rules', () => {
  assert.equal(keyFromName('New checkout flow'), 'new_checkout_flow');
  assert.equal(keyFromName('2024 Pricing / EU!'), 'pricing_eu');
  assert.match(keyFromName('Dark mode v2'), /^[a-z][a-z0-9_]*$/);
  assert.equal(cleanTags(['A', 'b c']).problem, null);
});
