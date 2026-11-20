// A JSON flag's JSON Schema (server/jsonSchema.ts, migration 0016): the schema must be one we can check, and every
// value the flag can serve (its variants, and the values typed into its rules and defaults) must match it, when the
// flag is made, when a value changes and when the schema changes. Flags as code carries it too.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { schemaProblem, valueProblems, type JsonSchema } from '../server/jsonSchema.ts';
import { hiddenKey as k } from '../server/evaluator.ts';
import { OWNABLE, planFlags, pullFlags, pushFlags } from '../server/flagsAsCode.ts';
import { AI_CONFIG_SCHEMA, aiConfigTemplate, readSchemaText, schemaText } from '../web/src/pages/flagTemplates.ts';
import { boot } from './helpers.ts';

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.stop(); });

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    model: { type: 'string', minLength: 1 },
    temperature: { type: 'number', minimum: 0, maximum: 2 },
    prompt: { type: 'string' },
    tools: { type: 'array', items: { type: 'string' } },
  },
  required: ['model'],
  additionalProperties: false,
};
const FAST = { model: 'small-model', temperature: 0.2, prompt: 'Answer in one short paragraph.' };
const STRONG = { model: 'large-model', temperature: 0.7, prompt: 'Think it through, then answer.', tools: ['search'] };
const newFlag = (body: Record<string, unknown>) => t.as('alice').post('/flags', {
  key: 'support_bot_model', name: 'Support bot model', tags: [], owner: 'ai-team', description: '', kind: 'config', valueType: 'json',
  variations: [{ key: 'fast', value: FAST }, { key: 'strong', value: STRONG }], jsonSchema: SCHEMA,
  delivery: { dev: ['server-ds'], prod: ['server-ds'] }, base: { enabled: true, defaultVariation: 'fast', rules: [] }, ...body,
});

test('the checks: types, required, extra fields, items, enum, ranges and lengths, each with its path', () => {
  assert.deepEqual(valueProblems(SCHEMA, FAST), []);
  assert.deepEqual(valueProblems(SCHEMA, STRONG), []);
  assert.deepEqual(valueProblems(SCHEMA, { temperature: 0.2 }), ['model is required']);
  assert.deepEqual(valueProblems(SCHEMA, { model: 'm', temperature: 3 }), ['temperature must be at most 2']);
  assert.deepEqual(valueProblems(SCHEMA, { model: 'm', temperature: '1' }), ['temperature must be a number']);
  assert.deepEqual(valueProblems(SCHEMA, { model: 'm', tools: ['a', 2] }), ['tools[1] must be a string']);
  assert.deepEqual(valueProblems(SCHEMA, { model: 'm', extra: 1 }), ['extra isn’t in the schema']);
  assert.deepEqual(valueProblems(SCHEMA, { model: '' }), ['model must be at least 1 character long']);
  assert.deepEqual(valueProblems(SCHEMA, []), ['the value must be an object']);
  assert.deepEqual(valueProblems({ type: 'integer' }, 1.5), ['the value must be an integer']);
  assert.deepEqual(valueProblems({ type: 'number' }, 2), [], 'an integer is a number');
  assert.deepEqual(valueProblems({ enum: ['a', { b: 1 }] }, { b: 1 }), []);
  assert.deepEqual(valueProblems({ enum: ['a', 'b'] }, 'c'), ['the value must be one of "a", "b"']);
  assert.deepEqual(valueProblems({ type: ['string', 'null'], maxLength: 2 }, 'abc'), ['the value must be at most 2 characters long']);
  assert.deepEqual(valueProblems({ type: 'object', properties: { a: { type: 'object', required: ['b'] } } }, { a: {} }), ['a.b is required']);
  assert.deepEqual(valueProblems({ type: 'array', items: { type: 'boolean' } }, [true, 1]), ['item 2 must be true or false']);
});

test('only the supported keywords, each well formed', () => {
  assert.equal(schemaProblem(SCHEMA), null);
  assert.equal(schemaProblem({ title: 'AI config', description: 'notes', $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' }), null);
  assert.match(schemaProblem({ type: 'object', properties: { model: { type: 'string', format: 'uri' } } })!, /“format” isn’t supported \(at properties\.model\)/);
  assert.match(schemaProblem({ type: 'thing' })!, /type is one of/);
  assert.match(schemaProblem({ required: 'model' })!, /required is a list/);
  assert.match(schemaProblem({ additionalProperties: { type: 'string' } })!, /additionalProperties is true or false/);
  assert.match(schemaProblem({ minimum: 2, maximum: 1 })!, /minimum is above maximum/);
  assert.match(schemaProblem({ minLength: -1 })!, /minLength is a whole number/);
  assert.match(schemaProblem('object')!, /is an object/);
  assert.match(schemaProblem({ enum: [] })!, /enum is a list/);
});

test('a new flag: its variants must match the schema, and the schema must be valid', async () => {
  const bad = await newFlag({ variations: [{ key: 'fast', value: { temperature: 0.2 } }, { key: 'strong', value: STRONG }] });
  assert.equal(bad.status, 422);
  assert.equal(bad.json.error, 'fast: model is required');
  const invalid = await newFlag({ jsonSchema: { type: 'object', oneOf: [] } });
  assert.equal(invalid.status, 422);
  assert.match(invalid.json.error, /^JSON Schema: “oneOf” isn’t supported/);
  const notJson = await newFlag({ key: 'model_name', valueType: 'string', variations: [{ key: 'a', value: 'x' }], base: { enabled: true, defaultVariation: 'a', rules: [] } });
  assert.equal(notJson.status, 422);
  assert.match(notJson.json.error, /Only JSON flags/);

  const ok = await newFlag({});
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  await t.settle();
  assert.deepEqual((await t.as('alice').get('/flags/support_bot_model')).json.jsonSchema, SCHEMA, 'GET /api/flags/:key has it');
});

test('a changed or added variant must match', async () => {
  const r = await t.as('alice').put('/flags/support_bot_model/variations', { variations: [{ key: 'strong', value: { ...STRONG, temperature: 5 } }] });
  assert.equal(r.status, 422);
  assert.equal(r.json.error, 'strong: temperature must be at most 2');
  const added = await t.as('alice').put('/flags/support_bot_model/variations', { variations: [{ key: 'cheap', value: { model: 'tiny', tools: 'none' } }] });
  assert.equal(added.json.error, 'cheap: tools must be an array');
  assert.equal((await t.as('alice').put('/flags/support_bot_model/variations', { variations: [{ key: 'cheap', value: { model: 'tiny-model' } }] })).status, 200);
});

test('editing the schema checks every variant; a valid edit is saved, null removes it', async () => {
  const stricter = { ...SCHEMA, required: ['model', 'prompt'] };
  const r = await t.as('alice').put('/flags/support_bot_model/meta', { jsonSchema: stricter });
  assert.equal(r.status, 422);
  assert.equal(r.json.error, 'cheap: prompt is required');
  assert.equal((await t.as('alice').put('/flags/support_bot_model/meta', { jsonSchema: { type: 'object', items: 1 } })).status, 422, 'an invalid schema');
  const looser = { ...SCHEMA, properties: { ...SCHEMA.properties, maxTokens: { type: 'integer', minimum: 1 } } };
  assert.equal((await t.as('alice').put('/flags/support_bot_model/meta', { jsonSchema: looser })).status, 200);
  assert.deepEqual((await t.as('alice').get('/flags/support_bot_model')).json.jsonSchema, looser);
  // the other details don't touch it
  assert.equal((await t.as('alice').put('/flags/support_bot_model/meta', { description: 'The support bot’s model' })).status, 200);
  assert.deepEqual((await t.as('alice').get('/flags/support_bot_model')).json.jsonSchema, looser);
  assert.equal((await t.as('alice').put('/flags/support_bot_model/meta', { jsonSchema: null })).status, 200);
  assert.equal((await t.as('alice').get('/flags/support_bot_model')).json.jsonSchema, null);
  assert.equal((await t.as('alice').put('/flags/support_bot_model/meta', { jsonSchema: SCHEMA })).status, 200);
  assert.equal((await t.as('alice').put('/flags/max_upload_mb/meta', { jsonSchema: { type: 'number' } })).status, 422, 'only JSON flags');
});

test('free values: each value typed into a rule or default is checked, and so are those served when the schema changes', async () => {
  const value = { model: 'small-model', temperature: 0.1 };
  const made = await newFlag({ key: 'summary_model', freeValues: true, variations: [{ key: k(value), value }], base: { enabled: true, defaultVariation: k(value), rules: [] } });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const wrong = { model: 'large-model', temperature: 9 };
  const r = await t.as('alice').put('/flags/summary_model/variations', { variations: [{ key: k(wrong), value: wrong }] });
  assert.equal(r.status, 422);
  assert.equal(r.json.error, `the value ${JSON.stringify(wrong)}: temperature must be at most 2`);
  // a schema that the served value doesn't match is refused
  const r2 = await t.as('alice').put('/flags/summary_model/meta', { jsonSchema: { ...SCHEMA, required: ['model', 'prompt'] } });
  assert.equal(r2.status, 422);
  assert.match(r2.json.error, /^the value \{"model":"small-model","temperature":0.1\}: prompt is required$/);
});

test('flags as code: pull writes jsonSchema; plan and push change it, and a bad one is a problem in the file', async () => {
  await t.settle();
  const file = await pullFlags(t.db);
  assert.deepEqual(file.flags.support_bot_model.jsonSchema, SCHEMA);
  assert.equal(file.flags.max_upload_mb.jsonSchema, undefined, 'a flag without one has none in the file');

  const looser = { ...SCHEMA, required: [] };
  const plan = await planFlags(t.db, { ...file, flags: { ...file.flags, support_bot_model: { ...file.flags.support_bot_model, jsonSchema: looser } } });
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(plan.steps.map((s) => s.do === 'details' ? [s.flag, s.fields] : [s.flag, s.do]), [['support_bot_model', ['jsonSchema']]]);
  await pushFlags(t.db, plan, { name: 'alice', type: 'user' });
  assert.deepEqual((await t.as('alice').get('/flags/support_bot_model')).json.jsonSchema, looser);

  const bad = await planFlags(t.db, { flags: { support_bot_model: { ...file.flags.support_bot_model, jsonSchema: { type: 'object', anyOf: [] } },
    max_upload_mb: { ...file.flags.max_upload_mb, jsonSchema: { type: 'number' } } } });
  assert.ok(bad.problems.some((p) => /^support_bot_model: jsonSchema: “anyOf” isn’t supported/.test(p)), bad.problems.join('\n'));
  assert.ok(bad.problems.includes('max_upload_mb: only JSON flags have a jsonSchema'), bad.problems.join('\n'));

  // a new flag from the file: its variants are checked against its schema
  const create = await planFlags(t.db, { owns: [...OWNABLE], flags: { draft_model: { kind: 'config', type: 'json', jsonSchema: SCHEMA,
    variants: { fast: FAST, broken: { temperature: 1 } }, default: 'fast', services: { dev: ['server-ds'] } } } });
  await assert.rejects(pushFlags(t.db, create, { name: 'alice', type: 'user' }), /broken: model is required/);
  const ok = await planFlags(t.db, { owns: [...OWNABLE], flags: { draft_model: { kind: 'config', type: 'json', jsonSchema: SCHEMA,
    variants: { fast: FAST }, default: 'fast', services: { dev: ['server-ds'] } } } });
  await pushFlags(t.db, ok, { name: 'alice', type: 'user' });
  assert.deepEqual((await t.as('alice').get('/flags/draft_model')).json.jsonSchema, SCHEMA);
});

test('the console’s AI config template: a Config JSON flag whose variants match its own schema, and the server takes it', async () => {
  const tpl = aiConfigTemplate('Help center answers');
  assert.deepEqual([tpl.valueType, tpl.kind, tpl.defaultVariation], ['json', 'config', 'fast']);
  assert.deepEqual(tpl.variants.map((v) => v.key), ['fast', 'strong']);
  assert.equal(schemaProblem(AI_CONFIG_SCHEMA), null);
  for (const v of tpl.variants) assert.deepEqual(valueProblems(AI_CONFIG_SCHEMA, v.value), [], v.key);
  assert.match(tpl.description, /Help center answers/);
  assert.deepEqual(readSchemaText(schemaText(AI_CONFIG_SCHEMA)), { schema: AI_CONFIG_SCHEMA, error: null }, 'the textarea round trip');
  assert.deepEqual(readSchemaText('  '), { schema: null, error: null }, 'empty: no schema');
  assert.equal(readSchemaText('{ "type": ').error, 'Not valid JSON');
  assert.match(readSchemaText('{ "type": "object", "oneOf": [] }').error!, /“oneOf” isn’t supported/);
  assert.deepEqual(valueProblems(AI_CONFIG_SCHEMA, { model: 'm', temperature: 2.5 }), ['temperature must be at most 2']);
  const r = await t.as('alice').post('/flags', {
    key: 'help_center_answers', name: 'Help center answers', tags: [], kind: tpl.kind, valueType: tpl.valueType, description: tpl.description,
    variations: tpl.variants, jsonSchema: tpl.jsonSchema, delivery: { dev: [], prod: [] }, base: { enabled: true, defaultVariation: tpl.defaultVariation, rules: [] },
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
});
