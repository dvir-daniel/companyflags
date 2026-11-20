// The JSON Schema of flags.json (server/flagsAsCode.ts flagsFileSchema): it says what readFile takes, the docs site
// publishes the same file (docs/public/flags.schema.json), the server serves it, and `flags pull` names it.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boot } from './helpers.ts';
import { FLAG_KINDS, FLAGS_SCHEMA_URL, OWNABLE, VALUE_TYPES, flagsFileSchema, planFlags, pullFlags } from '../server/flagsAsCode.ts';

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.stop(); });

const schema = flagsFileSchema();
const flag = schema.$defs.flag;

test('the schema and the file’s reader agree: the same fields, kinds, types and owned fields', async () => {
  assert.deepEqual(flag.properties.kind.enum, [...FLAG_KINDS]);
  assert.deepEqual(flag.properties.type.enum, [...VALUE_TYPES]);
  assert.deepEqual(schema.properties.owns.items.enum, [...OWNABLE]);
  assert.deepEqual(Object.keys(flag.properties).sort(), ['kind', 'type', ...OWNABLE].sort());
  // a pulled file has only fields the schema knows, and plans with no problem
  const pulled = await pullFlags(t.db);
  assert.equal(pulled.$schema, FLAGS_SCHEMA_URL);
  for (const k of Object.keys(pulled)) assert.ok(k in schema.properties, k);
  for (const s of Object.values(pulled.flags)) for (const k of Object.keys(s)) assert.ok(k in flag.properties, k);
  assert.deepEqual((await planFlags(t.db, pulled)).problems, []);
  // and a field the schema doesn't have is a problem in the file too
  const extra = await planFlags(t.db, { ...pulled, flags: { new_checkout: { ...pulled.flags.new_checkout, rules: [] } } });
  assert.match(extra.problems.join('\n'), /new_checkout: "rules" isn’t a field of a flag/);
});

test('published: the docs site has the same file, and the server serves it at /flags.schema.json', async () => {
  const published = readFileSync(new URL('../docs/public/flags.schema.json', import.meta.url), 'utf8');
  assert.equal(published, `${JSON.stringify(schema, null, 2)}\n`, 'docs/public/flags.schema.json is out of date: write it from flagsFileSchema()');
  const res = await t.app.request('/flags.schema.json');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), schema);
});
