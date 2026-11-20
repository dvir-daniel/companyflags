// What each page asks the server for first. The pages build their requests here, and navigation (main.tsx)
// and hovered links fetch the same paths ahead of time, so the page opens with its answer already there.

import { prefetch, type Meta } from './api.ts';
import { PAGE_SIZE, readPersistent } from './persist.ts';

export type FlagFilters = { env: string; q: string; status: string; kind: string; owner: string; tag: string; sort: string; dir: string };

// Every key and value is encoded: keys come from the address bar, so "#/flag/..%2Fapi-keys" must stay one key.
const seg = encodeURIComponent;
export const flagListPath = (f: FlagFilters, page: number) =>
  `/flags?environment=${seg(f.env)}&page=${page}&size=${PAGE_SIZE}&q=${seg(f.q)}&status=${seg(f.status)}&kind=${seg(f.kind)}`
  + `&owner=${seg(f.owner)}&tag=${seg(f.tag)}&sort=${seg(f.sort)}&dir=${seg(f.dir)}`;
export const flagPath = (key: string) => `/flags/${seg(key)}`;
/** One dimension's entities, a page of them (server/api.ts GET /dimensions/:dimension). */
export const dimensionListPath = (dimension: string, q: string, page: number) => `/dimensions/${seg(dimension)}?page=${page}&size=${PAGE_SIZE}&q=${seg(q)}`;
/** One dimension's entities under one parent ('' : those with no parent), all of them: one level of the tree. */
export const treeLevelPath = (dimension: string, parent: string) => `/dimensions/${seg(dimension)}?parent=${seg(parent)}`;
/** One entity's row for its page header (counts, added): a 404 when there's none in that dimension. */
export const entityPath = (dimension: string, key: string) => `/dimensions/${seg(dimension)}/${seg(key)}`;
export const entityFlagsPath = (dimension: string, key: string, env: string, own: boolean, q: string, page: number) =>
  `${entityPath(dimension, key)}/flags?environment=${seg(env)}&page=${page}&size=${PAGE_SIZE}&own=${own ? 1 : 0}&q=${seg(q)}`;
/** An entity and the entities right under it, side by side. */
export const childrenGridPath = (dimension: string, key: string, env: string, onlyDiff: boolean, q: string, page: number) =>
  `${entityPath(dimension, key)}/children?environment=${seg(env)}&page=${page}&size=${PAGE_SIZE}&diff=${onlyDiff ? 1 : 0}&q=${seg(q)}`;
/** The console's address of a dimension's page, or of one entity's (#/dimensions/<dimension>/<key>/<env>/<view>). */
export const dimensionHref = (dimension: string) => `#/dimensions/${seg(dimension)}`;
export const entityHref = (dimension: string, key: string, env?: string, view?: string) =>
  `#/dimensions/${seg(dimension)}/${seg(key)}${env ? `/${seg(env)}${view ? `/${seg(view)}` : ''}` : ''}`;
/** A service's app file for everyone in one environment (the app-files plugin, server/delivery.ts): the values with no
 *  entry's own settings, what an app reads before it knows who is signed in. Each entry's own link is on its page. */
export const everyoneFilePath = (env: string, service: string) => `/client/v1/flags/${seg(env)}/${seg(service)}`;
/** The History page's filters (server/history.ts). `when`: '' (any time), 'today', a number of days ('7', '30', '90',
 *  '365'), or 'custom' with `from`/`to` dates (YYYY-MM-DD, both days included). `entity`: one entity's history
 *  (`customer`, the name from before dimensions, means the same). */
export type HistoryFilters = { q?: string; entity?: string; customer?: string; env?: string; who?: string; change?: string; when?: string; from?: string; to?: string };
/** The persisted History filters, as the page keeps them (also what navigation prefetches). */
export const historyFilters = (): HistoryFilters => ({
  entity: readPersistent('history.entity', readPersistent('history.customer', '')), env: readPersistent('history.env', ''), who: readPersistent('history.who', ''),
  change: readPersistent('history.change', ''), when: readPersistent('history.when', ''), from: readPersistent('history.from', ''), to: readPersistent('history.to', ''),
});

/** A time filter as the server's `from` and `to`: whole days in this browser's time, so the same filter gives the same
 *  address all day (and a prefetched page is the one the page asks for). */
export function historyRange(when = '', from = '', to = '', now = new Date()): { from?: string; to?: string } {
  const day = (d: Date, add = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + add).toISOString();
  const date = (s: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null; };
  if (when === 'today') return { from: day(now) };
  if (/^\d+$/.test(when)) return { from: day(now, 1 - Number(when)) };       // the last N days, today included
  if (when === 'custom') {
    const f = date(from);
    const t = date(to);
    return { ...(f ? { from: day(f) } : {}), ...(t ? { to: day(t, 1) } : {}) };
  }
  return {};
}

/** The query for these filters, without paging: the first page is `/history?<this>`, an export `/history/export?<this>`. */
export function historyQuery(f: HistoryFilters, now = new Date()): string {
  const p = new URLSearchParams();
  if (f.q?.trim()) p.set('q', f.q.trim().toLowerCase());
  if (f.entity || f.customer) p.set('entity', (f.entity || f.customer)!);
  if (f.env) p.set('environment', f.env);
  if (f.who) p.set('by', f.who);
  if (f.change) p.set('type', f.change);
  const r = historyRange(f.when, f.from, f.to, now);
  if (r.from) p.set('from', r.from);
  if (r.to) p.set('to', r.to);
  return p.toString();
}
export const historyPath = (f: HistoryFilters) => `/history?${historyQuery(f)}`;
/** The Releases list in one environment (server/api.ts GET /releases): `show` is '', rolling, not_started, done or overdue. */
export const releaseListPath = (env: string, show: string, owner: string, q: string, page: number) =>
  `/releases?environment=${seg(env)}&page=${page}&size=${PAGE_SIZE}&show=${seg(show)}&owner=${seg(owner)}&q=${seg(q)}`;
/** The requests that change one flag (a release page shows those still open). */
export const flagRequestsPath = (key: string) => `/change-sets?flag=${seg(key)}`;
export const KEYS_PATH = '/api-keys';
/** Your access tokens (server/tokens.ts); an admin adds ?all=1 for everyone's. */
export const TOKENS_PATH = '/tokens';
export const CHANGE_SETS_PATH = '/change-sets';
/** Settings → Single sign-on: the connections (pages/sso.tsx). */
export const SSO_PATH = '/sso';
/** Settings → CDN: the Cloudflare purge (pages/cdn.tsx). */
export const CDN_PATH = '/cdn';

/** The environment a page opens in: the one in the address, else the last one used, else the first. */
export const pageEnv = (meta: Meta, fromRoute?: string) => {
  // an environment named in the address, if there is one by that name (a mistyped or old link opens a real one)
  if (fromRoute && meta.environments.some((e) => e.key === fromRoute)) return fromRoute;
  const last = readPersistent('env', '');
  return meta.environments.some((e) => e.key === last) ? last : meta.environments[0]?.key ?? '';
};

/** The address an old link means (#/customers, #/customer/<key>/<env>/brands, from before dimensions): the same page
 *  under dimensions, found from the entity's dimension. null for any other address. */
export function newAddress(hash: string, meta: Pick<Meta, 'dimensions' | 'entities'>): string | null {
  const parts = routeParts(hash);
  if (!parts) return null;
  const [page, key, env, view] = parts;
  if (page !== 'customers' && page !== 'customer') return null;
  const top = meta.dimensions[0]?.key;
  const dimension = key && page === 'customer' ? meta.entities.find((e) => e.key === key)?.dimension : undefined;
  if (dimension && key) return entityHref(dimension, key, env, view === 'brands' ? 'children' : view);
  return top ? dimensionHref(top) : '#/settings/dimensions';
}

/** The parts of an address (#/flag/<key>/<env>…), decoded; null when the address can't be decoded (a broken link). */
export function routeParts(hash: string): string[] | null {
  try {
    return (hash.replace(/^#\/?/, '').split('?')[0] || 'flags').split('/').map(decodeURIComponent);
  } catch {
    return null;
  }
}

/** The paths the page at this address asks for first (as it opens: no search typed yet). */
export function firstPaths(hash: string, meta: Meta): string[] {
  const parts = routeParts(hash);
  if (!parts) return [];
  const [page, a, b, c] = parts;
  switch (page) {
    case 'flags': return [flagListPath({
      env: pageEnv(meta, a), q: '', status: readPersistent('flags.status', ''), kind: readPersistent('flags.kind', ''),
      owner: readPersistent('flags.owner', ''), tag: readPersistent('flags.tag', ''), sort: readPersistent('flags.sort', 'key'), dir: readPersistent('flags.dir', 'asc'),
    }, 0)];
    case 'flag': return a ? [flagPath(a)] : [];
    case 'releases': return [releaseListPath(pageEnv(meta, a), readPersistent('releases.show', ''), readPersistent('releases.owner', ''), '', 0)];
    case 'release': return a ? [flagPath(a), flagRequestsPath(a)] : [];
    case 'customers': case 'customer': {
      const next = newAddress(hash, meta);
      return next ? firstPaths(next, meta) : [];
    }
    case 'dimensions': {
      if (!a) return [];
      if (!b) return [dimensionListPath(a, '', 0)];
      const env = pageEnv(meta, c);
      // its tab of the entities under it (#/dimensions/<dimension>/<key>/<env>/children), or its flags
      const first = parts[4] === 'children' ? childrenGridPath(a, b, env, false, '', 0)
        : entityFlagsPath(a, b, env, readPersistent<string>('entity.own', 'all') === 'own', '', 0);
      return [first, entityPath(a, b)];
    }
    case 'history': return [historyPath(historyFilters())];
    case 'keys': return [KEYS_PATH];
    case 'tokens': return [TOKENS_PATH];
    case 'approvals': return [CHANGE_SETS_PATH];
    case 'settings': return a === 'sso' ? [SSO_PATH] : [];   // Settings → Single sign-on; the other settings pages are drawn from /meta or load their own
    default: return [];
  }
}

/** Fetches what the page at this address needs first. Resolves when it's there (or failed: the page shows that). */
export const preload = (hash: string, meta: Meta) => Promise.all(firstPaths(hash, meta).map(prefetch)).then(() => {});
