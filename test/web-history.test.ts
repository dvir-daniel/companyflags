// The History page's filters as the server's query (web/src/paths.ts historyQuery, historyRange): whole days in the
// browser's own time, so a filter gives the same address all day and a prefetched page is the one the page asks for.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

let paths: typeof import('../web/src/paths.ts');
before(async () => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
    configurable: true, writable: true,
  });
  paths = await import('../web/src/paths.ts');
});

const local = (y: number, m: number, d: number) => new Date(y, m - 1, d).toISOString();

test('time filters are whole days in this browser’s time, today included', () => {
  const now = new Date(2026, 10, 18, 15, 42);                         // Nov 18 2026, 15:42 here
  assert.deepEqual(paths.historyRange('', '', '', now), {});
  assert.deepEqual(paths.historyRange('today', '', '', now), { from: local(2026, 11, 18) });
  assert.deepEqual(paths.historyRange('7', '', '', now), { from: local(2026, 11, 12) }, 'the last 7 days: Nov 12 to 18');
  assert.deepEqual(paths.historyRange('365', '', '', now), { from: local(2025, 11, 19) });
  assert.deepEqual(paths.historyRange('7', '', '', new Date(2026, 10, 18, 9, 0)), paths.historyRange('7', '', '', now), 'the same all day');
  assert.deepEqual(paths.historyRange('custom', '2026-01-01', '2026-01-31', now), { from: local(2026, 1, 1), to: local(2026, 2, 1) }, 'both days included');
  assert.deepEqual(paths.historyRange('custom', '2026-01-01', '', now), { from: local(2026, 1, 1) }, 'an open end');
  assert.deepEqual(paths.historyRange('custom', 'not-a-date', '', now), {});
});

test('the query has each filter once, and nothing for filters left empty', () => {
  const now = new Date(2026, 10, 18, 15, 42);
  assert.equal(paths.historyQuery({}, now), '');
  assert.equal(paths.historyPath({}), '/history?', 'the first page with no filters (as navigation prefetches it)');
  const q = new URLSearchParams(paths.historyQuery({ q: ' New_Check ', entity: 'acme', env: 'prod', who: 'ann@corp.example', change: 'layer', when: 'today' }, now));
  assert.deepEqual(Object.fromEntries(q), { q: 'new_check', entity: 'acme', environment: 'prod', by: 'ann@corp.example', type: 'layer', from: local(2026, 11, 18) });
});

test('navigation prefetches the History page with the filters this browser remembers', () => {
  localStorage.setItem('cf.history.env', JSON.stringify('prod'));
  localStorage.setItem('cf.history.who', JSON.stringify('ann@corp.example'));
  const f = paths.historyFilters();
  assert.equal(f.env, 'prod');
  assert.equal(f.who, 'ann@corp.example');
  assert.equal(paths.historyPath(f), '/history?environment=prod&by=ann%40corp.example');
});
