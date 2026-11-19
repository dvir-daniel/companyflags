// The entity chain for 1 to 4 dimensions (docs/design/dimensions.md "The order a request is decided in"), with hand-built
// snapshots. Every combination of the four states per level (no settings, Rules only, Rules + own default, Own settings
// only: 4^4 at 4 levels) is checked against a small model of the documented order written here, not against
// entityChain(). Then the four ways of answering agree for every entity at every level and none: evaluate(), the entity
// page (forEntity + answerFor), the app file as the device reads it (readClientFile), and flagd JSON as flagd reads it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClientFile, readClientFile } from '../server/clientFile.ts';
import { buildFlagdDoc } from '../server/flagd.ts';
import {
  answerFor, CODE_DEFAULT, entityChain, evaluate, forEntity, type EntityInfo, type FlagDef, type Inherit, type Layer, type Rule,
} from '../server/evaluator.ts';
import { flagdEvaluate, nest, ours, same } from './flagdReference.ts';
import { entities, snapshotOf } from './kit.ts';

const MODES: (Inherit | null)[] = [null, 'base_rules_then_base_default', 'base_rules_then_customer_default', 'customer_only'];
const DIMS = ['d0', 'd1', 'd2', 'd3'];          // top to bottom
const KEYS = ['e0', 'e1', 'e2', 'e3'];          // e0 at the top, e1 under it, …

let n = 0;
const rule = (r: Partial<Rule>): Rule => ({ ruleKey: `r-${++n}`, name: null, locked: false, disabled: false, conditions: [], serveVariation: null, split: null, ...r });
const layerOf = (l: Partial<Layer>): Layer => ({ version: 1, enabled: null, variationWhenOff: null, defaultVariation: null, inherit: null, rules: [], ...l });
const hasOwnDefault = (m: Inherit | null) => m === 'base_rules_then_customer_default' || m === 'customer_only';

/** A chain of `depth` dimensions with one entity in each, each under the one above. */
function chainOf(depth: number) {
  const dims = DIMS.slice(0, depth);
  const ents = entities(dims.map((d, i) => [KEYS[i], `E${i}`, d, i ? KEYS[i - 1] : undefined]));
  return { dims, ents };
}

/** The flag: an override for TVs; for the entity at top position t, a rule "app version below (depth − t).0.0" serving
 *  r<t> and, with a default of its own, d<t>; for everyone, a rule for web serving `e`, and the default `a`. So the
 *  first level whose rule matches is the nearest one to the asker that the request's version reaches. */
function flagFor(depth: number, modes: (Inherit | null)[]): FlagDef {
  const variations: Record<string, unknown> = { a: 'A', o: 'O', e: 'E', [CODE_DEFAULT]: null };
  for (let t = 0; t < depth; t++) { variations[`r${t}`] = `R${t}`; variations[`d${t}`] = `D${t}`; }
  const own: Record<string, Layer> = {};
  modes.forEach((m, t) => {
    if (!m) return;
    own[KEYS[t]] = layerOf({ inherit: m, defaultVariation: hasOwnDefault(m) ? `d${t}` : null,
      rules: [rule({ conditions: [{ field: 'app.version', op: 'semver_lt', values: [`${depth - t}.0.0`] }], serveVariation: `r${t}` })] });
  });
  return {
    key: 'f', valueType: 'string', kind: 'config', delivery: ['web', 'ios', 'server-ds'], variations,
    base: layerOf({ enabled: true, variationWhenOff: CODE_DEFAULT, defaultVariation: 'a', rules: [
      rule({ locked: true, conditions: [{ field: 'device.platform', op: 'in', values: ['tv'] }], serveVariation: 'o' }),
      rule({ conditions: [{ field: 'device.platform', op: 'in', values: ['web'] }], serveVariation: 'e' }),
    ] }),
    entities: own,
  };
}

/** The documented order, for the entity at top position `at` (null: no entity): its chain is itself, its parent, … the top.
 *  A level is skipped when one below it (nearer the asker) uses "Own settings only"; the default is the most specific own
 *  default not skipped, else everyone's. */
function model(depth: number, modes: (Inherit | null)[], at: number | null, req: { platform: string; major: number | null }) {
  const path = at === null ? [] : Array.from({ length: at + 1 }, (_, k) => at - k);       // top positions, asker first
  const stop = path.findIndex((t) => modes[t] === 'customer_only');                        // index in path, -1: none
  const skipped = (k: number) => stop >= 0 && k > stop;
  const levels = [
    { owner: null as string | null, set: req && true, skippedBy: null as string | null },
    ...path.map((t, k) => ({ owner: KEYS[t], set: !!modes[t], skippedBy: skipped(k) ? KEYS[path[stop]] : null })),
    { owner: null as string | null, set: true, skippedBy: stop >= 0 ? KEYS[path[stop]] : null },
  ];
  const defaultAt = path.findIndex((t, k) => !skipped(k) && hasOwnDefault(modes[t]));
  const def = defaultAt >= 0 ? { owner: KEYS[path[defaultAt]], variant: `d${path[defaultAt]}` } : { owner: null, variant: 'a' };
  // what it serves
  let served: { variant: string; section: string; owner: string | null };
  if (req.platform === 'tv') served = { variant: 'o', section: 'override', owner: null };
  else {
    const k = path.findIndex((t, i) => !skipped(i) && !!modes[t] && req.major !== null && req.major < depth - t);
    if (k >= 0) served = { variant: `r${path[k]}`, section: 'entity_rule', owner: KEYS[path[k]] };
    else if (stop < 0 && req.platform === 'web') served = { variant: 'e', section: 'everyone_rule', owner: null };
    else served = { variant: def.variant, section: def.owner ? 'entity_default' : 'default', owner: def.owner };
  }
  return { levels, default: def, served };
}

function* combos(depth: number): Generator<(Inherit | null)[]> {
  for (let i = 0; i < MODES.length ** depth; i++) yield Array.from({ length: depth }, (_, t) => MODES[Math.floor(i / MODES.length ** t) % MODES.length]);
}

const REQUESTS = ['tv', 'web', 'ios'].flatMap((platform) => [null, 0, 1, 2, 3].map((major) => ({ platform, major })));
const attrsOf = (r: { platform: string; major: number | null }) => ({ 'device.platform': r.platform, ...(r.major === null ? {} : { 'app.version': `${r.major}.5.0` }) });

test('1 to 4 dimensions, every combination of choices: the chain’s levels, skips and default are the documented ones', () => {
  let checked = 0;
  for (let depth = 1; depth <= 4; depth++) {
    const { dims, ents } = chainOf(depth);
    for (const modes of combos(depth)) {
      const f = flagFor(depth, modes);
      const snap = snapshotOf([f], ents, dims);
      for (const at of [null, ...Array.from({ length: depth }, (_, t) => t)]) {
        const entity = at === null ? null : ents[KEYS[at]];
        const chain = entityChain(f, entity);
        const want = model(depth, modes, at, { platform: 'ios', major: null });
        const where = `depth ${depth}, modes ${JSON.stringify(modes)}, asker ${entity?.key ?? 'none'}`;
        assert.deepEqual(chain.levels.map((l) => [l.owner, l.skippedBy]), want.levels.map((l) => [l.owner, l.skippedBy]), where);
        assert.deepEqual(chain.levels.slice(1, -1).map((l) => l.set), want.levels.slice(1, -1).map((l) => l.set), where);
        assert.deepEqual([chain.default.owner, chain.default.variant], [want.default.owner, want.default.variant], where);
        assert.deepEqual(chain.levels.slice(1, -1).map((l) => l.distance), (entity?.path ?? []).map((_, k) => k), where);
        for (const req of REQUESTS) {
          const r = evaluate(snap, 'f', { environment: 'dev', project: 'web', entity, attrs: attrsOf(req) }, false);
          const m = model(depth, modes, at, req).served;
          assert.deepEqual([r.variant, r.decidedBy.section, r.decidedBy.owner], [m.variant, m.section, m.owner], `${where}, ${JSON.stringify(req)}`);
          checked++;
        }
      }
    }
  }
  // (4 + 16 + 64 + 256 combinations) × (1 + depth askers) × the requests
  assert.equal(checked, [1, 2, 3, 4].reduce((s, d) => s + MODES.length ** d * (d + 1), 0) * REQUESTS.length);
});

/** Rules that depend on the request at every level of a chain, % of devices included, and checks on the dimensions, so
 *  every way of answering has exceptions, settled checks and splits to get right. */
function busyFlag(depth: number, modes: (Inherit | null)[], seed: number): FlagDef {
  const f = flagFor(depth, modes);
  const pct = (salt: string, v: string, by = 'device.id'): Rule['split'] => ({ by, fallbackBy: null, salt, hashVersion: 2, ranges: [{ variation: v, from: 0, to: 3000 + 1000 * (seed % 4) }] });
  for (const [k, l] of Object.entries(f.entities)) {
    l.rules.push(rule({ split: pct(`s-${k}`, 'e') }));
    l.rules.push(rule({ conditions: [{ field: DIMS[0], op: 'in', values: ['e0'] }, { field: 'app.build', op: 'gte', values: [100] }], serveVariation: 'o' }));
  }
  f.base.rules.push(
    rule({ conditions: [{ field: DIMS[depth - 1], op: 'in', values: [KEYS[depth - 1]] }, { field: 'device.platform', op: 'in', values: ['ios'] }], serveVariation: 'e' }),
    rule({ conditions: [{ field: 'entity', op: 'in', values: [KEYS[Math.max(0, depth - 2)]] }], split: pct('by-entity', 'a', DIMS[0]) }),
    rule({ conditions: [{ field: DIMS[depth - 1], op: 'missing' }], split: pct('everyone', `d0`) }),
  );
  return f;
}
const DEVICES = [{}, { 'device.platform': 'tv' }, { 'device.platform': 'ios', 'app.build': 120 },
  ...Array.from({ length: 16 }, (_, i) => ({ 'device.id': `dev-${i}`, 'device.platform': ['web', 'ios'][i % 2], 'app.version': `${i % 5}.5.0`, ...(i % 3 ? { 'app.build': 50 * i } : {}) }))];

test('1 to 4 dimensions: evaluate(), the entity page, the app file and flagd JSON agree for every entity and none', () => {
  let checked = 0;
  for (let depth = 1; depth <= 4; depth++) {
    const { dims, ents } = chainOf(depth);
    let seed = 0;
    for (const modes of combos(depth)) {
      const f = busyFlag(depth, modes, seed++);
      const snap = snapshotOf([f], ents, dims);
      for (const entity of [null, ...KEYS.slice(0, depth).map((k) => ents[k])] as (EntityInfo | null)[]) {
        const page = forEntity(f, snap, entity);
        const file = buildClientFile(snap, 'web', entity);
        const doc = buildFlagdDoc(snap, 'server-ds', entity);
        for (const attrs of DEVICES) {
          const where = `depth ${depth} ${JSON.stringify(modes)} ${entity?.key ?? 'none'} ${JSON.stringify(attrs)}`;
          const real = evaluate(snap, 'f', { environment: 'dev', project: 'web', entity, attrs }, false);
          const pick = answerFor(f, page, { environment: 'dev', project: 'web', entity, attrs });
          assert.deepEqual([pick.variant, pick.section, pick.owner], [real.variant, real.decidedBy.section, real.decidedBy.owner], `page: ${where}`);
          const device = readClientFile(file, 'f', attrs);
          assert.deepEqual(device.codeDefault ? 'code default' : device.value, real.codeDefault ? 'code default' : real.value, `app file: ${where}`);
          assert.equal(same(flagdEvaluate(doc, 'f', nest(attrs))), same(ours(snap, 'f', 'server-ds', entity?.key ?? null, attrs)), `flagd: ${where}`);
          checked++;
        }
        // nothing about entities reaches a device or a backend: every check on them is settled on the server
        assertNothingAbout([file, doc.flags], dims, where0(depth, modes, entity));
      }
    }
  }
  assert.equal(checked, [1, 2, 3, 4].reduce((sum, d) => sum + MODES.length ** d * (d + 1), 0) * DEVICES.length);
});
const where0 = (depth: number, modes: unknown, e: EntityInfo | null) => `depth ${depth} ${JSON.stringify(modes)} ${e?.key ?? 'none'}`;

/** No check on a dimension, `entity` or the old names, and no entity key, in an app file or flagd flags. */
function assertNothingAbout(files: unknown, dims: readonly string[], where: string) {
  const text = JSON.stringify(files);
  for (const field of ['entity', 'customer.id', 'customer.company', ...dims]) {
    for (const s of [`"field":"${field}"`, `"var":"${field}"`, `"missing":["${field}"]`, `"by":"${field}"`]) assert.ok(!text.includes(s), `no ${s}: ${where}`);
  }
  for (const key of KEYS) assert.ok(!text.includes(`"${key}"`), `no entity key ${key}: ${where}`);
}

test('an entity above a dimension, and no entity: checks on lower dimensions are settled, never written to a file', () => {
  const { dims, ents } = chainOf(3);
  const f: FlagDef = {
    key: 'f', valueType: 'string', kind: 'config', delivery: ['web', 'server-ds'], variations: { a: 'A', b: 'B', c: 'C' },
    base: layerOf({ enabled: true, variationWhenOff: CODE_DEFAULT, defaultVariation: 'a', rules: [
      rule({ locked: true, conditions: [{ field: 'd2', op: 'in', values: ['e2'] }], serveVariation: 'b' }),
      rule({ conditions: [{ field: 'd2', op: 'not_in', values: ['e2'] }, { field: 'app.version', op: 'semver_gte', values: ['2.0.0'] }], serveVariation: 'c' }),
    ] }),
    entities: {},
  };
  const snap = snapshotOf([f], ents, dims);
  for (const [entity, plain, newer] of [[ents.e2, 'B', 'B'], [ents.e1, 'A', 'C'], [ents.e0, 'A', 'C'], [null, 'B', 'B']] as const) {
    const file = buildClientFile(snap, 'web', entity);
    const doc = buildFlagdDoc(snap, 'server-ds', entity);
    assertNothingAbout([file, doc.flags], dims, entity?.key ?? 'none');
    for (const [attrs, want] of [[{}, plain], [{ 'app.version': '2.1.0' }, newer]] as const) {
      assert.equal(readClientFile(file, 'f', attrs).value, want, `${entity?.key ?? 'none'} ${JSON.stringify(attrs)}`);
      assert.equal(flagdEvaluate(doc, 'f', nest(attrs)).value, want, `flagd: ${entity?.key ?? 'none'} ${JSON.stringify(attrs)}`);
    }
  }
});
