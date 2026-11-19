// Entities on the dimensions company › brand (test/fixtures.ts): a brand is an entity under a company. Like every entity
// it has its own settings, link and page, and follows its parent's settings on a flag until it has its own
// (server/evaluator.ts entityChain). Chains of 1–4 dimensions, by hand-built snapshots, are in chain.test.ts.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.ts';
import { buildClientFile, readClientFile } from '../server/clientFile.ts';
import { contextFor, evaluate, type Inherit } from '../server/evaluator.ts';
import type { FlagdDoc } from '../server/flagd.ts';
import { flagdEvaluate, nest, ours, same } from './flagdReference.ts';

let t: Awaited<ReturnType<typeof boot>>;
before(async () => {
  t = await boot();
  const dana = t.as('dana');
  assert.equal((await dana.post('/dimensions/company', { key: 'unilever', name: 'Unilever' })).status, 201);
  assert.equal((await dana.post('/dimensions/brand', { key: 'dove', name: 'Dove', parent: 'unilever' })).status, 201);
  assert.equal((await dana.post('/dimensions/brand', { key: 'axe', name: 'Axe', parent: 'unilever' })).status, 201);
  // a string flag whose values name what decided them; one language per kind of rule
  const rule = (lang: string, serve: string, locked = false) => ({ ruleKey: crypto.randomUUID(), name: null, locked, disabled: false,
    conditions: [{ field: 'locale.language', op: 'in', values: [lang] }], serveVariation: serve, split: null });
  const values = ['override', 'brand_rule', 'brand_default', 'company_rule', 'company_default', 'everyone_rule', 'base_default'];
  const r = await dana.post('/flags', {
    key: 'brand_matrix', valueType: 'string', kind: 'ops', delivery: { dev: ['web'], prod: ['web'] },
    variations: values.map((v) => ({ key: v, value: v })),
    base: { enabled: true, defaultVariation: 'base_default', rules: [rule('xx', 'override', true), rule('es', 'everyone_rule')] },
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  RULE.brand = rule('fr', 'brand_rule');
  RULE.company = rule('de', 'company_rule');
  await t.settle();
});
after(async () => { await t.stop(); });

const RULE: Record<'brand' | 'company', object> = { brand: {}, company: {} };
const MODES: (Inherit | null)[] = [null, 'base_rules_then_base_default', 'base_rules_then_customer_default', 'customer_only'];
const LANGS = ['xx', 'fr', 'de', 'es', 'en'];

/** The documented order (docs/design/dimensions.md), written out plainly for a brand and its company. */
function expected(lang: string, brand: Inherit | null, company: Inherit | null): string {
  if (lang === 'xx') return 'override';                                         // overrides for everyone always win
  const brandOwnDefault = brand === 'base_rules_then_customer_default' || brand === 'customer_only';
  if (brand) {
    if (lang === 'fr') return 'brand_rule';
    if (brand === 'customer_only') return 'brand_default';
  }
  if (company) {
    if (lang === 'de') return 'company_rule';
    if (company === 'customer_only') return brandOwnDefault ? 'brand_default' : 'company_default';
  }
  if (lang === 'es') return 'everyone_rule';
  if (brandOwnDefault) return 'brand_default';
  if (company === 'base_rules_then_customer_default') return 'company_default';
  return 'base_default';
}

/** The entity chain the brand's page shows: each level as [who, key, set, skipped by, its default wins]. */
function expectedLevels(brand: Inherit | null, company: Inherit | null) {
  const brandStops = brand === 'customer_only';
  const companyStops = !brandStops && company === 'customer_only';
  const ownDefault = (m: Inherit | null) => m === 'base_rules_then_customer_default' || m === 'customer_only';
  const wins = ownDefault(brand) ? 'dove' : !brandStops && ownDefault(company) ? 'unilever' : 'everyone';
  return [
    ['override', null, true, null, false],
    ['entity', 'dove', !!brand, null, wins === 'dove'],
    ['entity', 'unilever', !!company, brandStops ? 'dove' : null, wins === 'unilever'],
    ['everyone', null, true, brandStops ? 'dove' : companyStops ? 'unilever' : null, wins === 'everyone'],
  ];
}

async function setLayer(entity: string, mode: Inherit | null, kind: 'brand' | 'company') {
  const flag = (await t.as('dana').get('/flags/brand_matrix')).json;
  const existing = flag.layers.dev.entities.find((c: any) => c.entity === entity);
  if (!mode) {
    if (!existing) return;
    const r = await t.as('dana').del(`/flags/brand_matrix/layers/dev/${entity}`, { expectedVersion: existing.layer.version });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return;
  }
  const layer = { inherit: mode, defaultVariation: mode === 'base_rules_then_base_default' ? null : `${kind}_default`, rules: [RULE[kind]] };
  const r = await t.as('dana').put(`/flags/brand_matrix/layers/dev/${entity}`, { layer, expectedVersion: existing?.layer.version ?? null });
  assert.equal(r.status, 200, JSON.stringify(r.json));
}
const ctx = (snap: Parameters<typeof contextFor>[0], entity: string | null, lang: string) => contextFor(snap, { project: 'web', entity }, { 'locale.language': lang }, { trust: 'app' });

test('a brand follows its company, then the defaults; its own settings come first: every combination', async () => {
  let checked = 0;
  for (const company of MODES) {
    for (const brand of MODES) {
      await setLayer('unilever', company, 'company');
      await setLayer('dove', brand, 'brand');
      await t.settle();
      const snap = t.plane.get('dev');
      const file = buildClientFile(snap, 'web', snap.entities.dove);
      for (const lang of LANGS) {
        const where = `brand=${brand} company=${company} lang=${lang}`;
        const want = expected(lang, brand, company);
        const got = evaluate(snap, 'brand_matrix', ctx(snap, 'dove', lang));
        assert.equal(got.value, want, `evaluator: ${where}`);
        assert.equal(readClientFile(file, 'brand_matrix', { 'locale.language': lang }).value, want, `the brand’s app file: ${where}`);
        // the company itself and its other brand never see Dove's settings
        const axe = evaluate(snap, 'brand_matrix', ctx(snap, 'axe', lang));
        assert.equal(axe.value, expected(lang, null, company), `axe: ${where}`);
        const uni = evaluate(snap, 'brand_matrix', ctx(snap, 'unilever', lang));
        assert.equal(uni.value, lang === 'xx' ? 'override' : lang === 'de' && company ? 'company_rule' : company === 'customer_only' ? 'company_default'
          : lang === 'es' ? 'everyone_rule' : company === 'base_rules_then_customer_default' ? 'company_default' : 'base_default', `unilever: ${where}`);
        checked++;
      }
      // the brand's page reads the same chain: which levels are set, which are skipped and by whom, whose default wins
      const row = (await t.as('alice').get('/dimensions/brand/dove/flags?environment=dev&page=0&size=50&q=brand_matrix')).json.rows[0];
      assert.deepEqual(row.levels.map((l: any) => [l.who, l.key, l.set, l.skippedBy, l.defaultWins]), expectedLevels(brand, company),
        `Dove’s page: brand=${brand} company=${company}`);
      assert.deepEqual(row.levels.map((l: any) => [l.dimension, l.distance]), [[null, null], ['brand', 0], ['company', 1], [null, null]]);
      // the warning before changing the rules for everyone counts every entity that skips them, brands included
      // (Dove with nothing of its own, when Unilever uses "Own settings only")
      const impact = (await t.as('alice').get('/flags/brand_matrix/impact/dev')).json;
      const skip = company === 'customer_only' ? ['axe', 'dove', 'unilever'] : brand === 'customer_only' ? ['dove'] : [];
      assert.deepEqual(impact, { ownOnly: skip, entityLayers: (brand ? 1 : 0) + (company ? 1 : 0) }, `impact: brand=${brand} company=${company}`);
      // saving Unilever's settings changes what its brands get too, unless one uses only its own
      const following = (await t.as('alice').get('/flags/brand_matrix/impact/dev?entity=unilever')).json.following;
      assert.equal(following, brand === 'customer_only' ? 1 : 2, `following Unilever: brand=${brand} company=${company}`);
    }
  }
  assert.equal(checked, MODES.length * MODES.length * LANGS.length);
  assert.equal((await t.as('alice').get('/flags/brand_matrix/impact/nowhere')).status, 404);
});

test('what decided the answer names the company’s settings for a brand', async () => {
  await setLayer('unilever', 'customer_only', 'company');
  await setLayer('dove', null, 'brand');
  await t.settle();
  const snap = t.plane.get('dev');
  const r = evaluate(snap, 'brand_matrix', ctx(snap, 'dove', 'de'));
  assert.deepEqual([r.decidedBy.section, r.decidedBy.owner, r.metadata.layer, r.metadata.owner], ['entity_rule', 'unilever', 'entity', 'unilever']);
  const page = (await t.as('alice').get('/dimensions/brand/dove/flags?environment=dev&page=0&size=50&q=brand_matrix')).json;
  assert.deepEqual(page.above.map((e: any) => e.key), ['unilever']);
  assert.deepEqual([page.rows[0].answer.gets.section, page.rows[0].answer.gets.owner], ['entity_default', 'unilever'], 'the entity page shows what Dove gets, from Unilever');
  assert.deepEqual((await t.as('alice').get('/dimensions/company/unilever/flags?environment=dev&page=0&size=50&q=brand_matrix')).json.children.map((b: any) => b.key), ['axe', 'dove']);
  assert.equal((await t.as('alice').get('/dimensions/company/dove/flags?environment=dev')).status, 404, 'Dove is a brand, not a company');
});

test('“Company is Unilever” covers Unilever and all its brands; “Company or brand is Dove” only Dove', async () => {
  const flag = (await t.as('dana').get('/flags/brand_matrix')).json;
  const { version, updatedAt: _u, updatedBy: _b, ...base } = flag.layers.prod.base;
  const company = { ruleKey: crypto.randomUUID(), name: null, locked: false, disabled: false,
    conditions: [{ field: 'company', op: 'in', values: ['unilever'] }], serveVariation: 'company_rule', split: null };
  const dove = { ruleKey: crypto.randomUUID(), name: null, locked: false, disabled: false,
    conditions: [{ field: 'entity', op: 'in', values: ['dove'] }], serveVariation: 'brand_rule', split: null };
  const locked = base.rules.filter((r: any) => r.locked);
  assert.equal(base.enabled, false, 'a new flag starts off in production, which needs approval');
  // production needs approval: the change is a request, applied once approved (and it switches the flag on there)
  const r = await t.as('alice').put('/flags/brand_matrix/layers/prod/base', { layer: { ...base, enabled: true, rules: [...locked, dove, company] }, expectedVersion: version, reason: 'test' });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  assert.equal((await t.as('bob').post(`/change-sets/${r.json.changeSetId}/review`, { decision: 'approve' })).status, 200);
  assert.equal((await t.as('alice').post(`/change-sets/${r.json.changeSetId}/apply`)).status, 200);
  await t.settle();
  const snap = t.plane.get('prod');
  const get = (entity: string | null) => evaluate(snap, 'brand_matrix', ctx(snap, entity, 'en')).value;
  assert.deepEqual([get('dove'), get('axe'), get('unilever'), get('google'), get(null)], ['brand_rule', 'company_rule', 'company_rule', 'base_default', 'base_default']);
  const axeFile = buildClientFile(snap, 'web', snap.entities.axe);
  assert.equal(readClientFile(axeFile, 'brand_matrix', { 'locale.language': 'en' }).value, 'company_rule', 'settled on the server for the brand’s file');
  assert.ok(!JSON.stringify(axeFile).includes('"field":"company"'), 'no company list reaches the device');
});

test('a brand has its own app link and file, like any entity', async () => {
  const dove = await t.appFile('dev', 'web', 'dove', {});
  assert.equal(dove.status, 200);
  const axe = await t.link('dev', 'web', 'axe');
  assert.notEqual(axe, await t.link('dev', 'web', 'dove'));
  assert.ok(!JSON.stringify(dove.json).includes('axe') && !JSON.stringify(dove.json).includes('Unilever'), 'nothing about other entities');
});

test('a brand’s parent is a company: the dimension right above; moving one is admin-only where a change needs approval', async () => {
  const dana = t.as('dana');
  const brandOfBrand = await dana.post('/dimensions/brand', { key: 'dove-men', name: 'Dove Men', parent: 'dove' });
  assert.equal(brandOfBrand.status, 422);
  assert.match(brandOfBrand.json.error, /the parent must be one of the companies/);
  assert.equal((await dana.put('/dimensions/company/unilever', { name: 'Unilever', parent: 'google' })).status, 422, 'the top dimension has nothing above it');
  assert.equal((await dana.post('/dimensions/brand', { key: 'lynx', name: 'Lynx', parent: 'nobody' })).status, 422);
  assert.equal((await dana.put('/dimensions/brand/axe', { name: 'Axe', parent: 'axe' })).status, 422);
  assert.equal((await dana.post('/dimensions/brand', { key: 'google', name: 'Google again' })).status, 409, 'keys are unique across every dimension');
  assert.equal((await dana.post('/dimensions/nowhere', { key: 'x', name: 'X' })).status, 404);
  assert.equal((await dana.put('/dimensions/company/dove', { name: 'Dove' })).status, 404, 'Dove is in brand, not company');
  // moving a brand out from under its company, and back, is a normal change in History
  assert.equal((await dana.put('/dimensions/brand/axe', { name: 'Axe', parent: null })).json.parent, null);
  assert.equal((await dana.put('/dimensions/brand/axe', { name: 'Axe', parent: 'unilever' })).json.parent, 'unilever');
  const h = (await dana.get('/history?entity=axe')).json;
  assert.ok(h.some((x: any) => x.changeType === 'entity.update' && x.before?.parent === 'unilever' && x.after?.parent === null));
  // that changes what Axe gets in production, which needs approval: admins only
  const byEditor = await t.as('alice').put('/dimensions/brand/axe', { name: 'Axe', parent: null });
  assert.equal(byEditor.status, 403, JSON.stringify(byEditor.json));
  assert.match(byEditor.json.error, /only admins can move axe under another parent/);
  assert.equal((await t.as('alice').put('/dimensions/brand/axe', { name: 'Axe', parent: 'unilever' })).status, 200, 'the same parent is no change');
  assert.equal((await t.as('alice').put('/dimensions/brand/axe', { name: 'Axe Bodyspray' })).json.parent, 'unilever', 'a new name is fine');
});

test('a dimension’s list: its entities with their parent, searched by the parent too; ?parent= for the tree', async () => {
  const brands = (await t.as('alice').get('/dimensions/brand?page=0&size=200&q=')).json.rows;
  assert.deepEqual(brands.map((r: any) => [r.key, r.parent, r.parentName]), [['axe', 'unilever', 'Unilever'], ['dove', 'unilever', 'Unilever']]);
  const companies = (await t.as('alice').get('/dimensions/company?page=0&size=200&q=unilever')).json.rows;
  assert.deepEqual(companies.map((r: any) => [r.key, r.children]), [['unilever', 2]]);
  const found = (await t.as('alice').get('/dimensions/brand?page=0&size=50&q=unilever')).json.rows.map((r: any) => r.key);
  assert.deepEqual(found, ['axe', 'dove'], 'searching the company finds its brands');
  assert.deepEqual((await t.as('alice').get('/dimensions/brand?parent=unilever')).json.map((r: any) => r.key), ['axe', 'dove']);
  assert.deepEqual((await t.as('alice').get('/dimensions/brand?parent=')).json, [], 'no brand without a company');
  assert.ok((await t.as('alice').get('/dimensions/company?parent=')).json.some((r: any) => r.key === 'unilever'));
  assert.equal((await t.as('alice').get('/dimensions/nowhere')).status, 404);
  const one = (await t.as('alice').get('/dimensions/brand/dove')).json;
  assert.deepEqual([one.key, one.dimension, one.parent], ['dove', 'brand', 'unilever']);
});

test('Compare names whose settings decided: the company’s for a brand, the brand’s own, everyone’s', async () => {
  await setLayer('unilever', 'base_rules_then_base_default', 'company');
  await setLayer('dove', 'base_rules_then_customer_default', 'brand');
  await t.settle();
  const sources = async (lang: string) => {
    const r = await t.as('alice').post('/compare', { a: { environment: 'dev', project: 'web', entity: 'dove' }, b: { environment: 'dev', project: 'web', entity: 'axe' },
      attrs: { 'locale.language': lang } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const row = r.json.rows.find((x: any) => x.key === 'brand_matrix');
    return [row.a.source, row.b.source];
  };
  assert.deepEqual(await sources('de'), ['Unilever’s rule', 'Unilever’s rule']);
  assert.deepEqual(await sources('fr'), ['Dove’s rule', 'Default']);
  assert.deepEqual(await sources('en'), ['Dove’s default', 'Default']);
  assert.deepEqual(await sources('es'), ['Rule for everyone', 'Rule for everyone']);
});

test('a brand’s page knows the version of its own settings; the company page shows its brands side by side', async () => {
  await setLayer('unilever', 'base_rules_then_base_default', 'company');
  await setLayer('dove', 'base_rules_then_customer_default', 'brand');
  await t.settle();
  const row = (await t.as('alice').get('/dimensions/brand/dove/flags?environment=dev&page=0&size=50&q=brand_matrix')).json.rows[0];
  const flag = (await t.as('alice').get('/flags/brand_matrix')).json;
  assert.equal(row.ownVersion, flag.layers.dev.entities.find((c: any) => c.entity === 'dove').layer.version);

  const grid = (await t.as('alice').get('/dimensions/company/unilever/children?environment=dev&page=0&size=50&q=brand_matrix')).json;
  assert.deepEqual(grid.children.map((b: any) => b.key), ['axe', 'dove']);
  const r = grid.rows[0];
  assert.deepEqual([r.cells.unilever.variant, r.cells.axe.variant, r.cells.dove.variant], ['base_default', 'base_default', 'brand_default']);
  assert.deepEqual(r.differs, ['dove'], 'Axe follows Unilever exactly; Dove has its own default');
  assert.deepEqual([r.cells.dove.own, r.cells.axe.own], [true, false]);
  assert.ok(r.cells.unilever.cases > 0, 'answers that depend on the request are counted');
  const onlyDiff = (await t.as('alice').get('/dimensions/company/unilever/children?environment=dev&page=0&size=50&q=&diff=1')).json;
  assert.ok(onlyDiff.rows.length > 0 && onlyDiff.rows.every((x: any) => x.differs.length > 0));
  assert.equal(onlyDiff.differing, onlyDiff.matched);
  const none = (await t.as('alice').get('/dimensions/brand/dove/children?environment=dev&diff=1')).json;
  assert.deepEqual([none.children, none.differing], [[], 0], 'the bottom dimension has nothing under it');
});

test('“Use Unilever’s again” removes the brand’s own settings on that flag', async () => {
  await setLayer('unilever', 'base_rules_then_base_default', 'company');
  await setLayer('dove', 'base_rules_then_customer_default', 'brand');
  await t.settle();
  const before = (await t.as('alice').get('/dimensions/brand/dove/flags?environment=dev&page=0&size=50&q=brand_matrix')).json.rows[0];
  assert.equal(before.hasOwn, true);
  const r = await t.as('alice').del('/flags/brand_matrix/layers/dev/dove', { expectedVersion: before.ownVersion });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await t.settle();
  const after = (await t.as('alice').get('/dimensions/brand/dove/flags?environment=dev&page=0&size=50&q=brand_matrix')).json.rows[0];
  assert.deepEqual([after.hasOwn, after.ownVersion, after.answer.gets.variant], [false, null, 'base_default']);
  const grid = (await t.as('alice').get('/dimensions/company/unilever/children?environment=dev&page=0&size=50&q=brand_matrix')).json;
  assert.deepEqual(grid.rows[0].differs, [], 'no brand differs any more');
});

test('a backend asking for a brand gets its company’s settings too, and answers like the server', async () => {
  const dana = t.as('dana');
  assert.equal((await dana.put('/flags/brand_matrix/delivery', { environment: 'dev', projects: ['web', 'server-ds'] })).status, 200);
  await setLayer('unilever', 'base_rules_then_customer_default', 'company');
  await setLayer('dove', null, 'brand');
  await t.settle();
  const key = (await dana.post('/api-keys', { environment: 'dev', project: 'server-ds', scope: 'entity', entity: 'dove' })).json.key;
  const res = await t.call('GET', '/sdk/v1/flagd', undefined, { authorization: `Bearer ${key}` });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const doc = res.json as FlagdDoc;
  assert.equal(doc.metadata.flagSetId, 'dev/dove');
  const snap = t.plane.get('dev');
  for (const lang of LANGS) {
    const attrs = { 'locale.language': lang };
    assert.equal(same(flagdEvaluate(doc, 'brand_matrix', nest(attrs))), same(ours(snap, 'brand_matrix', 'server-ds', 'dove', attrs)), `flagd’s answer for Dove, lang=${lang}`);
  }
  assert.equal(flagdEvaluate(doc, 'brand_matrix', nest({ 'locale.language': 'de' })).value, 'company_rule', 'Unilever’s rule reaches Dove on the backend too');
  // a shared backend names the entity in the path, by its dimension
  const shared = (await dana.post('/api-keys', { environment: 'dev', project: 'server-ds', scope: 'all' })).json.key;
  const axe = (await t.call('GET', '/sdk/v1/flagd/brand/axe', undefined, { authorization: `Bearer ${shared}` })).json as FlagdDoc;
  assert.equal(axe.metadata.flagSetId, 'dev/axe');
  assert.equal(same(flagdEvaluate(axe, 'brand_matrix', nest({ 'locale.language': 'de' }))), same(ours(snap, 'brand_matrix', 'server-ds', 'axe', { 'locale.language': 'de' })));
});
