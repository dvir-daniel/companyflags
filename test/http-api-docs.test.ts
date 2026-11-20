// The HTTP API's reference (docs/reference/http-api.md) against the server: every endpoint it names is one the
// server answers, and every endpoint of the stable API (/api/v1) is in it.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boot, builtIns } from './helpers.ts';
import { metrics } from '../server/plugins/metrics.ts';

const DOC = readFileSync(new URL('../docs/content/docs/reference/http-api.md', import.meta.url), 'utf8');

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot({ plugins: [...builtIns(), metrics()] }); });
after(async () => { await t.stop(); });

/** An address with its parameters as one shape: /api/v1/environments/<env>/flags and …/:env/flags are the same. */
const shape = (path: string) => path.split('?')[0].replace(/\/$/, '')
  .replace(/<[^>]+>/g, ':p').replace(/:\w+(\{[^}]*\})?/g, ':p');

/** The method and address of every endpoint the doc names, as `GET /path` in code or a block. */
function documented(): { method: string; path: string }[] {
  const out = new Map<string, { method: string; path: string }>();
  for (const m of DOC.matchAll(/(?:^|[`\s(])(GET|POST|PUT|PATCH|DELETE) (\/[A-Za-z0-9_./<>:{}-]+)/gm)) {
    const path = m[2].replace(/[.,]+$/, '');
    if (path.endsWith('/*') || path.includes('…') || path.includes('/nope')) continue;   // an example of an unknown address
    out.set(`${m[1]} ${shape(path)}`, { method: m[1], path });
  }
  return [...out.values()];
}

const served = () => new Set(t.app.routes.filter((r) => !r.path.endsWith('*')).map((r) => `${r.method} ${shape(r.path)}`));

test('every endpoint the HTTP API reference names is one the server answers', () => {
  const routes = served();
  const named = documented();
  assert.ok(named.length > 20, `found ${named.length}`);
  const missing = named.filter((e) => !routes.has(`${e.method} ${shape(e.path)}`)).map((e) => `${e.method} ${e.path}`);
  assert.deepEqual(missing, [], 'named in http-api.md, but not served');
});

test('every endpoint of the stable API is in the reference', () => {
  const named = new Set(documented().map((e) => `${e.method} ${shape(e.path)}`));
  const stable = [...served()].filter((r) => r.split(' ')[1].startsWith('/api/v1/'));
  assert.ok(stable.length >= 9);
  assert.deepEqual(stable.filter((r) => !named.has(r)), [], 'served under /api/v1, but not in http-api.md');
});
