// What an installation serves config per (server/dimensions.ts, docs/content/docs/guide/dimensions.mdx): the chain of dimensions,
// checked before it's saved, and saved as a whole by an admin. Words change any time; a dimension is added at the top or
// the bottom (in between only while the one below has no entity with a parent), removed only while it has no entities
// and no rule checks it, and keeps its key. In History as "dimensions.update"; nothing served changes.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chainOrder, checkDimensions, count, joined, PRESETS, suggestKey, title, type Dimension } from '../server/dimensions.ts';
import { boot } from './helpers.ts';

const d = (key: string, singular = key, plural = `${singular}s`): Dimension => ({ key, singular, plural });

test('a chain is checked before it is saved: keys, words, at most four', () => {
  for (const p of PRESETS) assert.deepEqual(checkDimensions(p.dimensions), [], p.name);
  assert.deepEqual(checkDimensions([]), [], 'none at all: only everyone’s file');
  assert.deepEqual(checkDimensions([d('staff', 'staff', 'staff'), d('shop', 'חנות', 'חנויות')]), [], 'singular and plural may be the same; any alphabet');
  const one = (dims: Dimension[]) => checkDimensions(dims).join(' | ');
  assert.match(one([d('a'), d('b'), d('c'), d('e'), d('f')]), /At most 4 dimensions/);
  assert.match(one([d('Store')]), /lowercase letters, digits and _/);
  assert.match(one([d('1st')]), /starts with a letter/);
  assert.match(one([d('x'.repeat(31))]), /at most 30 characters/);
  for (const k of ['entity', 'project', 'environment', 'app', 'device', 'session', 'geo', 'locale']) assert.match(one([d(k)]), /reserved word/, k);
  assert.match(one([d('store'), d('store', 'shop')]), /used twice/);
  assert.match(one([d('store'), d('shop', 'Store', 'shops')]), /called “Store” already/);
  assert.match(one([d('store'), d('shop', 'shop', 'stores')]), /plural is “stores” already/);
  assert.match(one([d('store', '')]), /singular has 1–30 letters/);
  assert.match(one([d('store', 'store', 'store 2')]), /plural has 1–30 letters/);
  assert.match(one([d('store', 'x'.repeat(31))]), /singular has 1–30/);
});

test('the words: plurals as typed, never an added “s”; titles; the names joined', () => {
  const store = d('store', 'store', 'stores');
  const staff = d('staff', 'staff', 'staff');
  assert.deepEqual([count(store, 1), count(store, 3), count(staff, 2), title(store), title(store, false)], ['1 store', '3 stores', '2 staff', 'Stores', 'Store']);
  assert.deepEqual([joined([]), joined([store]), joined([d('chain'), store]), joined([d('region'), d('chain'), store]), joined([d('region'), store], 'and')],
    ['', 'Store', 'Chain or store', 'Region, chain or store', 'Region and store']);
  assert.deepEqual([suggestKey('Sub-account'), suggestKey('  Store  '), suggestKey('3rd party'), suggestKey('חנות')], ['sub_account', 'store', 'd_3rd_party', '']);
  const rows = [{ key: 'store', parent: 'chain' }, { key: 'region', parent: null }, { key: 'chain', parent: 'region' }];
  assert.deepEqual(chainOrder(rows).map((r) => r.key), ['region', 'chain', 'store'], 'top to bottom, from the parents');
});

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.stop(); });
const save = (dims: Dimension[], as = 'dana') => t.as(as).put('/dimensions', { dimensions: dims });
const keys = async () => (await t.as('alice').get('/dimensions')).json.map((x: any) => x.key);
const COMPANY = d('company', 'company', 'companies');
const BRAND = d('brand', 'brand', 'brands');

test('only admins change the dimensions; a bad chain is refused with every problem', async () => {
  assert.deepEqual((await t.as('alice').get('/dimensions')).json, [
    { key: 'company', singular: 'company', plural: 'companies', entities: 9, withParent: 0 },
    { key: 'brand', singular: 'brand', plural: 'brands', entities: 0, withParent: 0 },
  ]);
  assert.equal((await save([COMPANY, BRAND], 'alice')).status, 403, 'an editor can’t: it’s a setting');
  assert.equal((await t.as('dana').put('/dimensions', { dimensions: 'company' })).status, 422);
  const bad = await save([COMPANY, d('brand', 'company', 'companies')]);
  assert.equal(bad.status, 422);
  assert.equal(bad.json.errors.length, 2, JSON.stringify(bad.json));
});

test('words change any time; History keeps before and after; the attributes read with the new words', async () => {
  const r = await save([d('company', 'account', 'accounts'), BRAND]);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const meta = (await t.as('alice').get('/meta')).json;
  assert.deepEqual([meta.dimensions[0].singular, meta.fields.find((f: any) => f.name === 'company').label, meta.fields.find((f: any) => f.name === 'entity').label],
    ['account', 'Account', 'Account or brand']);
  const h = (await t.as('alice').get('/history')).json.find((x: any) => x.changeType === 'dimensions.update');
  assert.deepEqual([h.changedBy, h.before[0].singular, h.after[0].singular, h.revision], ['dana', 'company', 'account', null], 'history only: no version');
  assert.equal((await save([COMPANY, BRAND])).status, 200);
});

test('a dimension goes in between only while the one below has no entity with a parent', async () => {
  const division = d('division', 'division', 'divisions');
  assert.equal((await save([COMPANY, division, BRAND])).status, 200, 'no brand has a company yet');
  assert.deepEqual(await keys(), ['company', 'division', 'brand']);
  assert.equal((await save([COMPANY, BRAND])).status, 200, 'and out again: it was empty');
  assert.equal((await t.as('dana').post('/dimensions/brand', { key: 'sl-kids', name: 'Soylent Kids', parent: 'soylent' })).status, 201);
  const refused = await save([COMPANY, division, BRAND]);
  assert.equal(refused.status, 422);
  assert.match(refused.json.error, /Divisions can only go between company and brand while no brands have a parent/);
  assert.equal((await save([BRAND, COMPANY])).status, 422, 'the order stays');
  assert.match((await save([COMPANY])).json.error, /Brands can’t go while it has entries \(1 brand\)/);
  assert.match((await save([COMPANY, d('kind', 'brand', 'brands')])).json.error, /Brands can’t go/, 'a key can’t change: that removes one and adds another');
  assert.deepEqual(await keys(), ['company', 'brand']);
});

test('added at the bottom and the top; removed once empty and no rule checks it; at most four', async () => {
  const store = d('store', 'store', 'stores');
  const region = d('region', 'region', 'regions');
  assert.equal((await save([COMPANY, BRAND, store])).status, 200);
  assert.ok((await t.db.query(`select 1 from condition_field where name = 'store' and comes_from = 'token' and can_split_by`)).rows.length, 'its attribute');
  // a rule on Store keeps it, even with no store at all
  const rule = { ruleKey: crypto.randomUUID(), name: null, locked: false, disabled: false, conditions: [{ field: 'store', op: 'exists' }], serveVariation: 'huge', split: null };
  const added = await t.editBase('max_upload_mb', 'dev', (l) => ({ ...l, rules: [...l.rules, rule] }));
  assert.equal(added.status, 200, JSON.stringify(added.json));
  assert.match((await save([COMPANY, BRAND])).json.error, /Stores can’t go while rules check “Store”/);
  assert.equal((await t.editBase('max_upload_mb', 'dev', (l) => ({ ...l, rules: l.rules.filter((r: any) => r.ruleKey !== rule.ruleKey) }))).status, 200);
  const gone = await save([COMPANY, BRAND]);
  assert.equal(gone.status, 200, JSON.stringify(gone.json));
  assert.equal((await t.db.query(`select 1 from condition_field where name = 'store'`)).rows.length, 0, 'its attribute goes with it');
  assert.equal((await t.as('dana').post('/dimensions/store', { key: 'x', name: 'X' })).status, 404);
  // back at the bottom, with a store under a brand (not under a company: the dimension right above only)
  assert.equal((await save([COMPANY, BRAND, store])).status, 200);
  assert.equal((await t.as('dana').post('/dimensions/store', { key: 'sl-kids-1', name: 'Kids store', parent: 'sl-kids' })).status, 201);
  assert.equal((await t.as('dana').post('/dimensions/store', { key: 'nf-1', name: 'Store under a company', parent: 'soylent' })).status, 422);
  // at the top: the companies have no parent until moved under one
  assert.equal((await save([region, COMPANY, BRAND, store])).status, 200);
  assert.equal((await t.as('dana').post('/dimensions/region', { key: 'eu', name: 'Europe' })).status, 201);
  assert.equal((await t.as('dana').put('/dimensions/company/soylent', { name: 'Soylent', parent: 'eu' })).status, 200);
  await t.settle();
  assert.deepEqual(t.plane.get('dev').entities['sl-kids-1'].path, ['sl-kids-1', 'sl-kids', 'soylent', 'eu']);
  assert.deepEqual(t.plane.get('dev').entities['sl-kids-1'].at, { store: 'sl-kids-1', brand: 'sl-kids', company: 'soylent', region: 'eu' });
  assert.deepEqual(t.plane.get('dev').dimensions, ['region', 'company', 'brand', 'store']);
  assert.match((await save([region, COMPANY, BRAND, store, d('shelf')])).json.error, /At most 4/);
  // an archived store still belongs to Stores: it stays
  await t.db.query(`update entity set archived_at = now() where key = 'sl-kids-1'`);
  assert.match((await save([region, COMPANY, BRAND])).json.error, /Stores can’t go: it has archived entries/);
  assert.deepEqual(await keys(), ['region', 'company', 'brand', 'store']);
});
