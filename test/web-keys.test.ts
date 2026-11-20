// The API keys page's words and snippets (web/src/pages/keysKit.ts): what a key may ask about in the installation's
// words (none before a dimension exists), and the ready-to-run code shown once a key is made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keySnippets, scopeAnyLabel, scopeHints, type SnippetFacts } from '../web/src/pages/keysKit.ts';

const store = { key: 'store', singular: 'store', plural: 'stores' };
const region = { key: 'region', singular: 'region', plural: 'regions' };
const facts = (o: Partial<SnippetFacts> = {}): SnippetFacts => ({
  origin: 'https://flags.example.com', key: 'ff_dev_web_secret', kind: 'client', plugins: ['ofrep', 'flagd', 'cdn-files'],
  flag: { key: 'new_checkout', valueType: 'bool' }, flagdPath: null, ...o,
});

test('what a key asks about, in the dimensions’ words, and never "entry" before there is one', () => {
  assert.equal(scopeAnyLabel([]), 'Any');
  assert.equal(scopeAnyLabel([region, store]), 'Any region or store');
  for (const text of Object.values(scopeHints([]))) assert.doesNotMatch(text, /\bentr(y|ies)\b/i);
  assert.match(scopeHints([store]).entity, /one store only/);
  assert.match(scopeHints([region, store]).all, /any region or store/);
});

test('a new app key comes with a curl and the web OFREP provider, filled in', () => {
  const s = keySnippets(facts());
  assert.deepEqual(s.map((x) => x.id), ['curl', 'web']);
  const [curl, web] = s;
  assert.match(curl.code, /^curl -X POST https:\/\/flags\.example\.com\/ofrep\/v1\/evaluate\/flags/);
  assert.match(curl.code, /Authorization: Bearer ff_dev_web_secret/);
  assert.match(web.code, /new OFREPWebProvider/);
  assert.match(web.code, /baseUrl: 'https:\/\/flags\.example\.com'/);
  assert.match(web.code, /\['Authorization', 'Bearer ff_dev_web_secret'\]/);
  assert.match(web.code, /getBooleanValue\('new_checkout', false\)/);
  // OpenFeature's own packages only: no client library of ours
  assert.doesNotMatch(s.map((x) => x.code).join('\n'), /companyflags/i);
});

test('a backend key comes with the Node OFREP provider, and flagd JSON when it names one entity', () => {
  const s = keySnippets(facts({ kind: 'server', flag: { key: 'max_upload_mb', valueType: 'number' }, flagdPath: '/sdk/v1/flagd/store/lumen' }));
  assert.deepEqual(s.map((x) => x.id), ['curl', 'node', 'flagd']);
  assert.match(s[1].code, /new OFREPProvider/);
  assert.match(s[1].code, /getNumberValue\('max_upload_mb', 0, \{ targetingKey: 'user-1' \}\)/);
  assert.match(s[2].code, /^curl https:\/\/flags\.example\.com\/sdk\/v1\/flagd\/store\/lumen/);
  // a key for any entity has no one address to download
  assert.deepEqual(keySnippets(facts({ kind: 'server' })).map((x) => x.id), ['curl', 'node']);
  // no flag yet: a placeholder key, still a working call
  assert.match(keySnippets(facts({ flag: null }))[1].code, /getBooleanValue\('my_flag', false\)/);
});

test('without OFREP there is no OFREP snippet', () => {
  assert.deepEqual(keySnippets(facts({ plugins: ['cdn-files'] })), []);
  assert.deepEqual(keySnippets(facts({ plugins: ['flagd'], kind: 'server', flagdPath: '/sdk/v1/flagd/store/lumen' })).map((x) => x.id), ['flagd']);
});
