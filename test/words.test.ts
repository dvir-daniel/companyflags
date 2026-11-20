// The console's vocabulary (server/words.ts): the three choices, what an entity gets with nothing of its own, which
// level decided and whose settings it was. An entity under another names it; one at the top says "everyone".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODE_DEFAULT, entityChain, type FlagDef, type Inherit, type Layer, type Section } from '../server/evaluator.ts';
import {
  CHOICE_NAME, CHOICES, choiceText, entityWords, getsWithoutOwn, LEVEL_OF, levelOf, ownerName, sameAs, sourceText, withoutOwn, type EntityWords,
} from '../server/words.ts';
import { entityWordsOf, type Entity } from '../web/src/api.ts';
import { entities } from './kit.ts';

const ACME: EntityWords = { key: 'acme', name: 'Acme', above: [] };
const VELVET: EntityWords = { key: 'velvet', name: 'Velvet', above: [{ key: 'tyrell', name: 'Tyrell' }] };
const STORE: EntityWords = { key: 'acme-12', name: 'Acme 12', above: [{ key: 'acme', name: 'Acme' }, { key: 'eu', name: 'EU' }] };

test('the three choices keep their identifiers; “Own settings only” is what “Customer only” was', () => {
  assert.deepEqual(CHOICES.map((c) => CHOICE_NAME[c]), ['Rules only', 'Rules + own default', 'Own settings only']);
  assert.deepEqual(CHOICES, ['base_rules_then_base_default', 'base_rules_then_customer_default', 'customer_only']);
});

test('what a choice does: it names those above the entity; at the top it says everyone; with none it covers both', () => {
  const said = (who?: EntityWords) => Object.fromEntries(CHOICES.map((c) => [c, choiceText(c, who)])) as Record<Inherit, string>;
  const brand = said(VELVET);
  assert.equal(brand.base_rules_then_base_default, 'Velvet’s rules come first. If none match, it gets what Tyrell gets.');
  assert.equal(brand.base_rules_then_customer_default, 'Velvet’s rules come first, then Tyrell’s rules and the rules for everyone, then Velvet’s own default.');
  assert.equal(brand.customer_only, 'Only Velvet’s rules and default count. Tyrell’s settings and the rules for everyone are skipped; overrides for everyone still apply.');
  const store = said(STORE);
  assert.equal(store.base_rules_then_customer_default, 'Acme 12’s rules come first, then Acme’s and EU’s rules and the rules for everyone, then Acme 12’s own default.');
  assert.equal(store.customer_only, 'Only Acme 12’s rules and default count. Acme’s and EU’s settings and the rules for everyone are skipped; overrides for everyone still apply.');
  const top = said(ACME);
  assert.equal(top.base_rules_then_base_default, 'Acme’s rules come first. If none match, it gets the same as everyone.');
  assert.equal(top.base_rules_then_customer_default, 'Acme’s rules come first, then the rules for everyone, then Acme’s own default.');
  assert.equal(top.customer_only, 'Only Acme’s rules and default count. The rules for everyone are skipped; overrides for everyone still apply.');
  for (const c of CHOICES) {
    assert.ok(!top[c].includes('Tyrell') && !/above/.test(top[c]), `at the top there is nothing above: ${top[c]}`);
    assert.match(choiceText(c), /above/, `the general text says what an entity under another does: ${choiceText(c)}`);
    assert.ok(!/customer|company|brand/i.test(choiceText(c)), `no fixed word: ${choiceText(c)}`);
  }
});

test('with nothing of its own: an entity gets what its parent gets, one at the top the same as everyone', () => {
  assert.equal(getsWithoutOwn(VELVET), 'gets what Tyrell gets');
  assert.equal(getsWithoutOwn(ACME), 'gets the same as everyone');
  assert.equal(getsWithoutOwn(null), 'gets the same as everyone');
  assert.deepEqual([withoutOwn(VELVET), withoutOwn(ACME)], ['what Tyrell gets', 'the same as everyone']);
  assert.deepEqual([sameAs(VELVET), sameAs(ACME), sameAs(STORE)], ['Same as Tyrell', 'Same as everyone', 'Same as Acme']);
});

test('an entity’s words come with the names of those above it, on the server and in the console', () => {
  const E = entities([['eu', 'EU', 'region'], ['acme', 'Acme', 'chain', 'eu'], ['acme-12', 'Acme 12', 'store', 'acme']]);
  assert.deepEqual(entityWords('acme-12', (k) => E[k]), STORE);
  assert.deepEqual(entityWords('eu', (k) => E[k]), { key: 'eu', name: 'EU', above: [] });
  assert.equal(entityWords('nobody', (k) => E[k]), null);
  const list: Entity[] = [{ key: 'tyrell', name: 'Tyrell', dimension: 'company', createdAt: '' }, { key: 'velvet', name: 'Velvet', dimension: 'brand', parent: 'tyrell', createdAt: '' }];
  assert.deepEqual(entityWordsOf(list, 'velvet'), VELVET);
  assert.equal(entityWordsOf(list, null), null);
  assert.deepEqual([ownerName(STORE, 'acme-12'), ownerName(STORE, 'eu'), ownerName(STORE, 'nobody'), ownerName(null, 'eu')], ['Acme 12', 'EU', undefined, undefined]);
});

test('which level a section belongs to agrees with the entity chain', () => {
  const layer = (inherit: Inherit): Layer => ({ version: 1, enabled: null, variationWhenOff: null, defaultVariation: inherit === 'base_rules_then_base_default' ? null : 'a', inherit, rules: [] });
  const flag = (own: Record<string, Layer>): FlagDef => ({ key: 'f', valueType: 'string', kind: 'config', delivery: ['web'], variations: { a: 'A', [CODE_DEFAULT]: null },
    base: { version: 1, enabled: true, variationWhenOff: CODE_DEFAULT, defaultVariation: 'a', inherit: null, rules: [] }, entities: own });
  const velvet = entities([['tyrell', 'Tyrell', 'company'], ['velvet', 'Velvet', 'brand', 'tyrell']]).velvet;
  const chains = [
    entityChain(flag({}), velvet),
    entityChain(flag({ velvet: layer('base_rules_then_customer_default') }), velvet),
    entityChain(flag({ tyrell: layer('customer_only') }), velvet),
  ];
  for (const chain of chains) {
    for (const l of chain.levels) assert.equal(levelOf(l.section), l.level, l.section);
    assert.equal(levelOf(chain.default.section), chain.default.level, chain.default.section);
  }
  assert.deepEqual(chains.map((c) => [c.default.level, c.default.owner]), [['everyone', null], ['entity', 'velvet'], ['entity', 'tyrell']]);
  assert.deepEqual((['not_sent', 'off'] as Section[]).map(levelOf), [null, null], 'nothing in the chain decided');
  assert.equal(Object.keys(LEVEL_OF).length, 7, 'every section has a level');
});

test('whose settings decided: “Velvet’s rule”, and from above “Tyrell’s rule”', () => {
  const d = (section: Section, owner: string | null = null, namesEntity = false) => ({ section, owner, ruleKey: null, ruleName: null, namesEntity });
  assert.deepEqual(
    [d('entity_rule', 'velvet'), d('entity_default', 'velvet'), d('entity_rule', 'tyrell'), d('entity_default', 'tyrell')].map((x) => sourceText(x, { entity: VELVET })),
    ['Velvet’s rule', 'Velvet’s default', 'Tyrell’s rule', 'Tyrell’s default']);
  assert.equal(sourceText(d('entity_rule', 'eu'), { entity: VELVET, nameOf: (k) => (k === 'eu' ? 'Europe' : undefined) }), 'Europe’s rule', 'an owner the words don’t know is named by nameOf');
  assert.equal(sourceText(d('everyone_rule', null, true), { entity: VELVET }), 'Rule naming Velvet');
  assert.equal(sourceText(d('entity_rule')), 'Own rule', 'no entity given: the section’s own name');
  assert.equal(sourceText(d('entity_rule', 'acme'), { entity: ACME, byDevice: true }), 'Acme’s rule · % of devices');
});
