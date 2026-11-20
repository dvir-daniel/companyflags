// What each console page asks the server for first (web/src/paths.ts): the address read back into its parts, the
// first requests a page makes (with the filters remembered in this browser), and keys that must stay one segment.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Meta } from '../web/src/api.ts';

// this browser's storage, with a few remembered choices (persist.ts reads it once and keeps the answers)
const stored = new Map<string, string>([
  ['cf.env', JSON.stringify('prod')],
  ['cf.flags.status', JSON.stringify('on')],
  ['cf.entity.own', JSON.stringify('own')],
]);
const fakeStorage = {
  getItem: (k: string) => stored.get(k) ?? null,
  setItem: (k: string, v: string) => { stored.set(k, String(v)); },
  removeItem: (k: string) => { stored.delete(k); },
  clear: () => stored.clear(),
  key: (i: number) => [...stored.keys()][i] ?? null,
  get length() { return stored.size; },
};

let paths: typeof import('../web/src/paths.ts');
before(async () => {
  Object.defineProperty(globalThis, 'localStorage', { value: fakeStorage, configurable: true, writable: true });
  paths = await import('../web/src/paths.ts');
});

const meta = {
  environments: [{ key: 'dev', name: 'Development', minApprovals: 0, revision: 1 }, { key: 'prod', name: 'Production', minApprovals: 1, revision: 1 }],
  services: [], users: [], fields: [],
  dimensions: [{ key: 'company', singular: 'company', plural: 'companies', entities: 1, withParent: 0 }, { key: 'brand', singular: 'brand', plural: 'brands', entities: 1, withParent: 1 }],
  entities: [{ key: 'acme', name: 'Acme', dimension: 'company', createdAt: '' }, { key: 'velvet', name: 'Velvet', dimension: 'brand', parent: 'acme', createdAt: '' }],
} as unknown as Meta;

test('an address in parts, decoded', () => {
  assert.deepEqual(paths.routeParts('#/flag/new_checkout/prod'), ['flag', 'new_checkout', 'prod']);
  assert.deepEqual(paths.routeParts('#/flags'), ['flags']);
  assert.deepEqual(paths.routeParts(''), ['flags']);                              // no address: the flags list
  assert.deepEqual(paths.routeParts('#/'), ['flags']);
  assert.deepEqual(paths.routeParts('#/history?flag=x'), ['history']);            // the query isn't a part
  assert.deepEqual(paths.routeParts('#/flag/..%2Fapi-keys'), ['flag', '../api-keys']);
  assert.deepEqual(paths.routeParts('#/dimensions/store/caf%C3%A9'), ['dimensions', 'store', 'café']);
  assert.equal(paths.routeParts('#/flag/%E0%A4%A'), null);                       // a broken link: no page, no crash
});

test('a key from the address stays one segment of the request', () => {
  assert.equal(paths.flagPath('../api-keys'), '/flags/..%2Fapi-keys');
  assert.equal(paths.entityPath('a/b', 'a/b?c=d#e'), '/dimensions/a%2Fb/a%2Fb%3Fc%3Dd%23e');
  assert.equal(paths.entityHref('store', 'x/y', 'prod', 'children'), '#/dimensions/store/x%2Fy/prod/children');
  // the same through the page's first request
  assert.deepEqual(paths.firstPaths('#/flag/..%2Fapi-keys', meta), ['/flags/..%2Fapi-keys']);
  assert.ok(paths.flagListPath({ env: 'a&b', q: 'x y&z', status: '', kind: '', owner: '', tag: '', sort: 'key', dir: 'asc' }, 0)
    .startsWith('/flags?environment=a%26b&page=0&size=50&q=x%20y%26z&'));
  assert.ok(paths.flagListPath({ env: 'dev', q: '', status: '', kind: '', owner: '', tag: '', sort: 'key', dir: 'asc', stale: 'overdue' }, 2, 200)
    .startsWith('/flags?environment=dev&page=2&size=200&'));
});

test('the first requests of each page, with what this browser remembers', () => {
  // the flags list opens in the last environment used, with its remembered filter
  assert.deepEqual(paths.firstPaths('#/flags', meta), [
    '/flags?environment=prod&page=0&size=50&q=&status=on&kind=&owner=&tag=&sort=key&dir=asc&stale=',
  ]);
  // a view in the address is the whole view: what it leaves out is the default, not what this browser remembers
  assert.deepEqual(paths.firstPaths('#/flags/dev?owner=payments-team&q=Checkout', meta), [
    '/flags?environment=dev&page=0&size=50&q=Checkout&status=&kind=&owner=payments-team&tag=&sort=key&dir=asc&stale=',
  ]);
  // an environment in the address wins
  assert.match(paths.firstPaths('#/flags/dev', meta)[0], /^\/flags\?environment=dev&/);
  assert.deepEqual(paths.firstPaths('#/flag/f', meta), ['/flags/f']);
  assert.deepEqual(paths.firstPaths('#/flag', meta), []);
  assert.deepEqual(paths.firstPaths('#/releases', meta), ['/releases?environment=prod&page=0&size=50&show=&owner=&q=']);
  assert.match(paths.firstPaths('#/releases/dev', meta)[0], /^\/releases\?environment=dev&/);
  assert.deepEqual(paths.firstPaths('#/release/a%2Fb/prod', meta), ['/flags/a%2Fb', '/change-sets?flag=a%2Fb']);
  assert.deepEqual(paths.firstPaths('#/release', meta), []);
  assert.deepEqual(paths.firstPaths('#/dimensions/company', meta), ['/dimensions/company?page=0&size=50&q=']);
  assert.deepEqual(paths.firstPaths('#/dimensions', meta), []);
  assert.deepEqual(paths.firstPaths('#/dimensions/company/acme/dev', meta), [
    '/dimensions/company/acme/flags?environment=dev&page=0&size=50&own=1&q=', '/dimensions/company/acme',
  ]);
  assert.deepEqual(paths.firstPaths('#/dimensions/company/acme/dev/children', meta), [
    '/dimensions/company/acme/children?environment=dev&page=0&size=50&diff=0&q=', '/dimensions/company/acme',
  ]);
  // an entity page with no environment in the address opens in the last one used
  assert.deepEqual(paths.firstPaths('#/dimensions/brand/velvet', meta)[1], '/dimensions/brand/velvet');
  assert.deepEqual(paths.firstPaths('#/history', meta), ['/history?']);
  assert.deepEqual(paths.firstPaths('#/keys', meta), ['/api-keys']);
  assert.deepEqual(paths.firstPaths('#/approvals', meta), ['/change-sets']);
  assert.deepEqual(paths.firstPaths('#/settings', meta), []);   // Environments, drawn from /meta
  assert.deepEqual(paths.firstPaths('#/settings/people', meta), []);   // People is drawn from /meta
  assert.deepEqual(paths.firstPaths('#/settings/sso', meta), ['/sso']);   // Single sign-on loads its connections
  assert.deepEqual(paths.firstPaths('#/flag/%E0%A4%A', meta), []);
});

test('an environment that no longer exists, remembered or in the address, falls back to the first', () => {
  const gone = { ...meta, environments: [meta.environments[0]] } as Meta;
  assert.equal(paths.pageEnv(gone), 'dev');
  // a mistyped or old link opens a real environment, never an empty column named after one that isn't there
  assert.equal(paths.pageEnv(gone, 'staging'), 'dev');
  assert.equal(paths.pageEnv(meta, meta.environments[0].key), meta.environments[0].key);
});

test('the History filters ask for one entity’s history', () => {
  assert.equal(paths.historyQuery({ entity: 'acme' }), 'entity=acme');
});

test('the flags list’s view lives in the address: read back, written with only what differs', () => {
  const none = () => { throw new Error('a view in the address never reads what this browser remembers'); };
  const v = paths.flagViewFrom('owner=payments-team&tag=checkout&q=new%20checkout&sort=changed&dir=desc&show=all&stale=overdue', none);
  assert.deepEqual(v, { q: 'new checkout', status: '', kind: '', owner: 'payments-team', tag: 'checkout', stale: 'overdue', sort: 'changed', dir: 'desc', show: 'all' });
  // back to the same address, in a fixed order
  assert.equal(paths.flagViewQuery(v), 'q=new+checkout&owner=payments-team&tag=checkout&stale=overdue&sort=changed&dir=desc&show=all');
  assert.equal(paths.flagsHref('prod', v), `#/flags/prod?${paths.flagViewQuery(v)}`);
  assert.equal(paths.flagsHref('a/b', paths.FLAG_VIEW_DEFAULTS), '#/flags/a%2Fb');
  assert.deepEqual(paths.flagViewFrom(paths.flagViewQuery(v), none), v);
  // nonsense in the address falls back to what the list knows
  const odd = paths.flagViewFrom('dir=sideways&show=some&stale=soon&kind=ops', none);
  assert.equal(odd.dir, 'asc'); assert.equal(odd.show, ''); assert.equal(odd.stale, ''); assert.equal(odd.kind, 'ops');
  // no query: what this browser remembers, but never the search
  const remembered = paths.flagViewFrom('', (k, d) => (k === 'status' ? 'on' : k === 'q' ? 'remembered search' : d));
  assert.equal(remembered.status, 'on');
  assert.equal(remembered.q, '');
  assert.equal(paths.hashQuery('#/flags/prod?owner=x'), 'owner=x');
  assert.equal(paths.hashQuery('#/flags/prod'), '');
  assert.equal(paths.flagPageSize(100), 100);
  assert.equal(paths.flagPageSize(7), 50);
});

test('History keeps its view and filters in the address, so a link shows the same list', () => {
  assert.equal(paths.historyHref('changes'), '#/history');
  assert.equal(paths.historyHref('revisions', { env: 'prod' }), '#/history?view=revisions&env=prod');
  assert.equal(paths.historyHref('changes', { q: 'new_checkout', entity: 'acme', when: '7', who: '' }), '#/history?flag=new_checkout&entity=acme&when=7');
  const at = paths.readHistoryAddress('#/history?view=versions&env=prod');
  assert.deepEqual([at.view, at.env, at.filtered], ['revisions', 'prod', true], 'versions is the old name of revisions');
  assert.equal(paths.readHistoryAddress('#/history?view=revisions').view, 'revisions');
  const plain = paths.readHistoryAddress('#/history');
  assert.deepEqual([plain.view, plain.filtered], ['changes', false], 'no filters in the address: the remembered ones apply');
  assert.equal(paths.readHistoryAddress('#/history?view=nonsense').view, 'changes');
  // what each view asks for first
  assert.deepEqual(paths.firstPaths('#/history?view=versions&env=prod', meta), ['/environments/prod/versions?page=0&size=50']);
  assert.deepEqual(paths.firstPaths('#/history?view=requests', meta), ['/change-sets']);
  assert.deepEqual(paths.firstPaths('#/history?entity=acme', meta), ['/history?entity=acme']);
});

test('addresses that moved open where they went', () => {
  assert.equal(paths.movedAddress('#/flags/prod/versions'), '#/history?view=revisions&env=prod');
  assert.equal(paths.movedAddress('#/settings/services'), '#/services');
  assert.equal(paths.movedAddress('#/flags/prod'), null);
  assert.equal(paths.movedAddress('#/flags/prod/conditions'), null);
  assert.equal(paths.movedAddress('#/history?view=versions'), null);
});
