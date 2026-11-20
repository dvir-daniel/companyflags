// No word left behind (docs/design/dimensions.md "Words"): nothing a console user or a rule author reads says
// "customer", "company" or "brand" unless the installation's own dimensions are called that.
//   - Every sentence the server and the console build, with dimensions called something else entirely, has none.
//   - The console's and the server's code has none in a string or in JSX text, except identifiers kept on purpose (the
//     old attribute and History names read as aliases, old addresses that still open the new pages, the presets).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Dimension } from '../server/dimensions.ts';
import { PRESETS } from '../server/dimensions.ts';
import { evaluate, type FlagDef, type Inherit, type Layer, type Rule, type Section } from '../server/evaluator.ts';
import { FIELDS, fieldInfo, groupLabel, FIELD_GROUPS } from '../server/fields.ts';
import {
  CHOICE_NAME, CHOICES, choiceText, conditionText, entityWords, getsWithoutOwn, sameAs, SECTION_LABEL, sourceText, STAGE_LABEL, withoutOwn,
} from '../server/words.ts';
import { KINDS } from '../server/journal.ts';
import { applyChange, changeText, releaseState, stepText } from '../server/release.ts';
import { checkLayer, entityKeyProblem, type FieldFacts } from '../server/checks.ts';
import { contextFor } from '../server/evaluator.ts';
import { entities, snapshotOf } from './kit.ts';

const WORD = /\b(customers?|compan(y|ies)|brands?)\b/i;
const clean = (what: string, text: string) => assert.ok(!WORD.test(text), `${what}: “${text}”`);

// Dimensions with words nobody uses for tenants, at 1, 2 and 3 levels
const ODD: Dimension[] = [
  { key: 'widget', singular: 'widget', plural: 'widgets' },
  { key: 'gadget', singular: 'gadget', plural: 'gadgets' },
  { key: 'gizmo', singular: 'gizmo', plural: 'gizmos' },
];
const CHAINS = [ODD.slice(0, 1), ODD.slice(0, 2), ODD];

const ents = entities([
  ['w1', 'Widget One', 'widget'], ['g1', 'Gadget One', 'gadget', 'w1'], ['z1', 'Gizmo One', 'gizmo', 'g1'], ['z2', 'Gizmo Two', 'gizmo', 'g1'],
]);
const lookup = (k: string) => ents[k];

test('sentences about entities, their choices and what decided an answer use the dimensions’ words only', () => {
  for (const dims of CHAINS) {
    for (const v of Object.values(CHOICE_NAME)) clean('choice name', v);
    for (const v of [...Object.values(SECTION_LABEL), ...Object.values(STAGE_LABEL)]) clean('label', v);
    for (const key of ['w1', 'g1', 'z1']) {
      const who = entityWords(key, lookup);
      for (const c of CHOICES) { clean('choice', choiceText(c, who)); clean('choice', choiceText(c)); }
      for (const t of [withoutOwn(who), getsWithoutOwn(who), sameAs(who), withoutOwn(), sameAs()]) clean('without own', t);
      const sections: Section[] = ['not_sent', 'off', 'override', 'entity_rule', 'entity_default', 'everyone_rule', 'default'];
      for (const section of sections) for (const owner of [null, 'w1', 'g1', key]) {
        clean('source', sourceText({ section, owner, ruleKey: null, ruleName: null, namesEntity: true }, { entity: who, project: 'web', byDevice: true }));
        clean('source', sourceText({ section, owner, ruleKey: null, ruleName: null, namesEntity: false }));
      }
    }
    const vocab = { dimensions: dims, nameOf: (k: string) => ents[k]?.name };
    for (const field of [...dims.map((d) => d.key), 'entity', 'customer.id', 'customer.company']) {
      for (const op of ['in', 'not_in', 'exists', 'missing']) clean('condition', conditionText({ field, op, values: ['w1', 'g1'] }, vocab));
    }
    for (const g of FIELD_GROUPS) clean('group', groupLabel(g, dims));
  }
});

test('every attribute the rule editor shows, the dimensions’ own included, is named without those words', () => {
  for (const dims of CHAINS) {
    const rows = [...FIELDS.map((f) => f.name), ...dims.map((d) => d.key), 'entity', 'customer.id', 'customer.company']
      .map((name) => fieldInfo({ name, valueType: 'string', comesFrom: 'token', canSplitBy: true, description: '' }, dims));
    for (const f of rows) clean(`label of ${f.name}`, f.label);
  }
  for (const f of FIELDS) clean(`description of ${f.name}`, f.description);
});

test('the trace explains every level in neutral words, at every depth', () => {
  const rule = (over: Partial<Rule>): Rule => ({ ruleKey: crypto.randomUUID(), name: null, locked: false, disabled: false, conditions: [], serveVariation: 'a', split: null, ...over });
  const layer = (inherit: Inherit | null, rules: Rule[] = [], defaultVariation: string | null = null): Layer => ({ version: 1, enabled: null, variationWhenOff: null, defaultVariation, inherit, rules });
  const flag = (own: Record<string, Layer>): FlagDef => ({
    key: 'f', valueType: 'string', kind: 'config', variations: { a: 'A', b: 'B', code_default: null }, delivery: ['web'],
    base: { version: 1, enabled: true, variationWhenOff: 'code_default', defaultVariation: 'b', inherit: null,
      rules: [rule({ locked: true, conditions: [{ field: 'gizmo', op: 'in', values: ['z9'] }] }), rule({ conditions: [{ field: 'widget', op: 'in', values: ['w2'] }] })] },
    entities: own,
  });
  const flags = [
    flag({}),
    flag({ g1: layer('customer_only', [rule({ conditions: [{ field: 'app.version', op: 'semver_lt', values: ['1.0.0'] }] })], 'a') }),
    flag({ z1: layer('base_rules_then_base_default'), w1: layer('base_rules_then_customer_default', [], 'a') }),
  ];
  for (const f of flags) {
    const snap = snapshotOf([f], ents, ODD.map((d) => d.key));
    for (const who of [null, 'w1', 'g1', 'z1', 'z2']) {
      const r = evaluate(snap, 'f', contextFor(snap, { project: 'web', entity: who }, { 'app.version': '0.5.0' }, { trust: 'console' }));
      for (const step of r.trace) {
        clean('trace', step.detail);
        for (const c of step.conditions ?? []) if (c.note) clean('trace note', c.note);
      }
    }
  }
});

test('History, a release’s steps and a layer’s problems say it without those words', () => {
  const n = (k: string) => ents[k]?.name ?? k;
  const said = [
    { flag: 'f', entity: 'z1', before: null, after: { key: 'z1', name: 'Gizmo One', dimension: 'gizmo', parent: 'g1' } },
    { flag: null, entity: 'z1', before: { key: 'z1', name: 'Gizmo One', parent: 'g1' }, after: { key: 'z1', name: 'Gizmo One', parent: null } },
    { flag: null, entity: 'z1', before: { key: 'z1', name: 'Gizmo One', parent: null }, after: { key: 'z1', name: 'Gizmo One', parent: 'g1' } },
    // an entry from before dimensions, its parent called `company`
    { flag: null, entity: 'z1', before: { key: 'z1', name: 'Gizmo One', company: 'g1' }, after: { key: 'z1', name: 'Gizmo One', company: 'w1' } },
  ];
  for (const [kind, k] of Object.entries(KINDS) as [string, { says?: (e: unknown, n: (k: string) => string) => string }][]) {
    if (!/^(entity|customer|layer)\./.test(kind)) continue;
    for (const e of said) if (k.says) clean(`History ${kind}`, k.says(e, n));
  }

  const variants = [{ key: 'on', value: true }, { key: 'off', value: false }];
  const base = { version: 1, enabled: true, variationWhenOff: 'code_default', defaultVariation: 'off', inherit: null, rules: [] as Rule[] };
  const before = releaseState(variants, base);
  const early = applyChange(variants, base, { kind: 'entities', entities: ['z1', 'g1'] });
  const after = releaseState(variants, { ...base, ...early });
  for (const t of [stepText(before), stepText(after), changeText(before, after) ?? '', ...early.rules.map((r) => r.name ?? '')]) clean('release', t);

  const fields: FieldFacts = { gizmo: { valueType: 'string', canSplitBy: true } };
  const flagFacts = { key: 'f', kind: 'config', variants: new Set(['a', 'b']) };
  const problems = [
    ...checkLayer(flagFacts, fields, false, { enabled: true, inherit: 'nope' as Inherit, defaultVariation: 'a', rules: [{ name: null, locked: true, conditions: [], serveVariation: 'a' }] }, null).errors,
    ...checkLayer(flagFacts, fields, false, { inherit: 'base_rules_then_base_default', defaultVariation: 'a', rules: [] }, null).errors,
    ...checkLayer(flagFacts, fields, true, { enabled: true, inherit: 'customer_only', defaultVariation: 'a', rules: [] }, null).errors,
    entityKeyProblem('Bad Key') ?? '', entityKeyProblem('base') ?? '',
  ];
  assert.ok(problems.length > 4);
  for (const p of problems) clean('layer problem', p);
});

// ---- the source ---------------------------------------------------------------------------------

/** Strings and JSX text in a file, comments left out (line numbers kept). */
function texts(file: string): { line: number; text: string }[] {
  let s = readFileSync(file, 'utf8');
  s = s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/.*$/gm, (m, p: string) => p + ' '.repeat(m.length - p.length));
  const out: { line: number; text: string }[] = [];
  const lineAt = (i: number) => s.slice(0, i).split('\n').length;
  for (const m of s.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)) out.push({ line: lineAt(m.index), text: m[0] });
  // JSX text: between a tag's end and the next tag, and not code (a comparison or an arrow between two generics)
  if (file.endsWith('.tsx')) for (const m of s.matchAll(/>([^<>{}]+)</g)) if (!/===|=>|\|\||&&|;/.test(m[1])) out.push({ line: lineAt(m.index), text: m[1] });
  return out;
}
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
});

// Identifiers kept on purpose: the old attribute names (fields.ts ALIASES), the old History kinds, old console
// addresses and saved drafts read in the new names, the backends' old header, the History filter that also finds old
// entries. Product and package names aren't the word either.
const KEPT = new Set(["'customer.id'", "'customer.company'", "'customer.create'", "'customer.update'", "'customer.link_replaced'",
  "'customers'", "'customer'", "'brands'", "'x-customer-id'", "'history.customer'", "'entity,customer'"]);
const PRODUCT = /companyflags|company-os/i;

test('no string or JSX text in the console or the server says those words', () => {
  const presets = new Set(PRESETS.flatMap((p) => [p.name, ...p.dimensions.flatMap((d) => [d.key, d.singular, d.plural])]).map((w) => `'${w}'`));
  const hits: string[] = [];
  for (const file of [...files('web/src'), ...files('server').filter((f) => !f.includes('migrations'))]) {
    for (const { line, text } of texts(file)) {
      if (!WORD.test(text.replace(PRODUCT, '')) || KEPT.has(text)) continue;
      if (file.endsWith('dimensions.ts') && presets.has(text)) continue;
      hits.push(`${file}:${line}: ${text.trim().slice(0, 120)}`);
    }
  }
  assert.deepEqual(hits, [], `a fixed domain word in what people read:\n${hits.join('\n')}`);
});
