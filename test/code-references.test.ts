// Code references (server/codeReferences.ts, `flags unused`): the keys OpenFeature calls read, in each SDK's spelling,
// and this repository's own examples and docs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeReferences } from '../server/codeReferences.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
/** The keys read in `src`, in order (no key is a flag, so each read is "unknown"). */
const reads = (src: string) => codeReferences([], src).unknown.map((u) => u.key);

test('each SDK’s calls: JavaScript and its Details forms, React hooks, Java, Kotlin, Go, Python, Ruby, .NET, Rust', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-refs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files: Record<string, string> = {
    'app.ts': [
      `await client.getBooleanValue('js_bool', false);`,
      `client.getNumberDetails("js_number_details", 1); client.getObjectDetails(\`js_object_details\`, {});`,
      `client.getStringValueDetails('js_string_value_details', '');`,
    ].join('\n'),
    'App.tsx': `useBooleanFlagValue('react_bool', false); useStringFlagDetails('react_string', ''); useFlag('react_flag', 1); useSuspenseFlag('react_suspense', 0);`,
    'Main.java': `client.getIntegerValue("java_int", 1); client.getDoubleDetails("java_double", 0.5);`,
    'Main.kt': `client.getBooleanValue("kotlin_bool", false)`,
    'main.go': `client.BooleanValue(ctx, "go_bool", false, of.EvaluationContext{})\nclient.StringValueDetails(context.Background(), "go_string", "", ec)\nclient.IntValue(ctx, "go_int", 1, ec)`,
    'app.py': `client.get_boolean_value("py_bool", False)\nclient.get_integer_details(flag_key="py_int", default_value=1)`,
    'app.rb': `client.fetch_boolean_value(flag_key: "rb_bool", default_value: false)`,
    'Program.cs': `await client.GetBooleanValueAsync("cs_bool", false); await client.GetStringDetailsAsync("cs_string", "");`,
    'main.rs': `client.get_bool_value("rs_bool", None, None).await`,
    // not reads: a key in a variable, another method, a key that isn't a flag key's shape
    'not.ts': `client.getBooleanValue(key, false); client.getValue('nope'); getBooleanValue('Not_A_Key'); notgetBooleanValue('x_y')`,
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  // where the search doesn't look: builds, caches, vendored code, flagd JSON
  for (const d of ['.next', 'coverage', 'vendor', 'target']) { mkdirSync(join(dir, d)); writeFileSync(join(dir, d, 'x.ts'), `getBooleanValue('ghost', false)`); }
  writeFileSync(join(dir, 'flags.flagd.json'), JSON.stringify({ $schema: 'https://flagd.dev/schema/v0/flags.json', flags: { dead_flag: {} } }));

  assert.deepEqual(reads(dir).sort(), [
    'cs_bool', 'cs_string', 'go_bool', 'go_int', 'go_string', 'java_double', 'java_int',
    'js_bool', 'js_number_details', 'js_object_details', 'js_string_value_details', 'kotlin_bool',
    'py_bool', 'py_int', 'rb_bool', 'react_bool', 'react_flag', 'react_string', 'react_suspense', 'rs_bool',
  ]);
  assert.deepEqual(codeReferences(['dead_flag', 'js_bool'], dir).unused, ['dead_flag'], 'a flagd export doesn’t count as code');
  // in the order they are in the file, each with its line
  assert.deepEqual(codeReferences([], join(dir, 'app.ts')).unknown.map((u) => [u.key, u.line]),
    [['js_bool', 1], ['js_number_details', 2], ['js_object_details', 2], ['js_string_value_details', 3]]);
});

test('this repository’s examples and docs: every flag they read is found', () => {
  assert.deepEqual([...new Set(reads(join(repo, 'examples', 'node', 'src')))].sort(), ['max_upload_mb']);
  assert.deepEqual([...new Set(reads(join(repo, 'examples', 'react', 'src')))].sort(), ['new_checkout', 'welcome_message']);
  const docs = new Set(reads(join(repo, 'docs', 'content', 'docs')));
  for (const key of ['new_checkout', 'max_upload_mb', 'theme', 'assistant_config']) assert.ok(docs.has(key), `${key} in the docs: ${[...docs].join(', ')}`);
});
