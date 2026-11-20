// What each page asks the server for first. The pages build their requests here, and navigation (main.tsx)
// and hovered links fetch the same paths ahead of time, so the page opens with its answer already there.

import { prefetch, type Meta } from './api.ts';
import { PAGE_SIZE, readPersistent } from './persist.ts';

export type FlagFilters = { env: string; q: string; status: string; kind: string; owner: string; tag: string; sort: string; dir: string; stale?: string };

// Every key and value is encoded: keys come from the address bar, so "#/flag/..%2Fapi-keys" must stay one key.
const seg = encodeURIComponent;
/** One page of the flags list. `stale`: 'overdue' for flags past their remove-by date. */
export const flagListPath = (f: FlagFilters, page: number, size = PAGE_SIZE) =>
  `/flags?environment=${seg(f.env)}&page=${page}&size=${size}&q=${seg(f.q)}&status=${seg(f.status)}&kind=${seg(f.kind)}`
  + `&owner=${seg(f.owner)}&tag=${seg(f.tag)}&sort=${seg(f.sort)}&dir=${seg(f.dir)}&stale=${seg(f.stale ?? '')}`;

/** What the flags list shows besides its environment: the search, the filters, the sort, and which environments get a
 *  column (`show`: '' for the chosen one, 'all' for every one). It lives in the address (#/flags/prod?owner=payments),
 *  so a link opens the same list for anyone. */
export type FlagView = { q: string; status: string; kind: string; owner: string; tag: string; stale: string; sort: string; dir: string; show: string };
export const FLAG_VIEW_DEFAULTS: FlagView = { q: '', status: '', kind: '', owner: '', tag: '', stale: '', sort: 'key', dir: 'asc', show: '' };
const FLAG_VIEW_KEYS = Object.keys(FLAG_VIEW_DEFAULTS) as (keyof FlagView)[];
/** Page sizes to choose from (server/listing.ts MAX_PAGE_SIZE is the largest). */
export const FLAG_PAGE_SIZES = [50, 100, 200] as const;
export const flagPageSize = (n: unknown) => (FLAG_PAGE_SIZES as readonly unknown[]).includes(n) ? (n as number) : PAGE_SIZE;

/** The query part of an address: "owner=x" for "#/flags/prod?owner=x", '' for none. */
export const hashQuery = (hash: string) => { const i = hash.indexOf('?'); return i < 0 ? '' : hash.slice(i + 1); };

/**
 * The flags list's view from the address's query. A query that names anything is the whole view (what it leaves out is
 * the default), so a shared link opens exactly what was shared. With no query at all, the view this browser last used
 * (`remembered`), except the search, which starts empty.
 */
export function flagViewFrom(query: string, remembered: (key: keyof FlagView, initial: string) => string = (k, d) => readPersistent(`flags.${k}`, d)): FlagView {
  const p = new URLSearchParams(query);
  const given = FLAG_VIEW_KEYS.some((k) => p.has(k));
  const v = { ...FLAG_VIEW_DEFAULTS };
  for (const k of FLAG_VIEW_KEYS) v[k] = given ? p.get(k) ?? FLAG_VIEW_DEFAULTS[k] : k === 'q' ? '' : remembered(k, FLAG_VIEW_DEFAULTS[k]);
  if (v.dir !== 'desc') v.dir = 'asc';
  if (v.show !== 'all') v.show = '';
  if (v.stale !== 'overdue') v.stale = '';
  return v;
}

/** The view as an address's query: only what differs from the default, in a fixed order ('' for the plain list). */
export function flagViewQuery(v: FlagView): string {
  const p = new URLSearchParams();
  for (const k of FLAG_VIEW_KEYS) if (v[k] && v[k] !== FLAG_VIEW_DEFAULTS[k]) p.set(k, k === 'q' ? v[k].trim() : v[k]);
  return p.toString();
}

/** The console's address of the flags list in one environment with this view: "#/flags/prod?owner=payments". */
export const flagsHref = (env: string, v: FlagView) => { const q = flagViewQuery(v); return `#/flags/${seg(env)}${q ? `?${q}` : ''}`; };
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
/** A service's CDN file for everyone in one environment (the cdn-files plugin, server/delivery.ts): the values with no
 *  entry's own settings, what an app reads before it knows who is signed in. Each entry's own link is on its page. */
export const everyoneFilePath = (env: string, service: string) => `/cdn/v1/flags/${seg(env)}/${seg(service)}`;
/** The History page's filters (server/history.ts). `when`: '' (any time), 'today', a number of days ('7', '30', '90',
 *  '365'), or 'custom' with `from`/`to` dates (YYYY-MM-DD, both days included). `entity`: one entity's history. */
export type HistoryFilters = { q?: string; entity?: string; env?: string; who?: string; change?: string; when?: string; from?: string; to?: string };
/** The persisted History filters, as the page keeps them (also what navigation prefetches). */
export const historyFilters = (): HistoryFilters => ({
  entity: readPersistent('history.entity', ''), env: readPersistent('history.env', ''), who: readPersistent('history.who', ''),
  change: readPersistent('history.change', ''), when: readPersistent('history.when', ''), from: readPersistent('history.from', ''), to: readPersistent('history.to', ''),
});

/** History's views: what changed (every change), each environment's revisions (its numbered published states, to roll
 *  back), and requests. */
export const HISTORY_VIEWS = ['changes', 'revisions', 'requests'] as const;
export type HistoryView = (typeof HISTORY_VIEWS)[number];
/** Other names a link may use for a view: `versions` is what revisions were called before. */
const VIEW_ALIASES: Record<string, HistoryView> = { versions: 'revisions' };
/** What History's address says: its view, and the filters (#/history?view=revisions&env=prod, #/history?flag=x&when=7).
 *  `filtered`: the address names a filter, so the remembered ones don't apply. */
export type HistoryAddress = HistoryFilters & { view: HistoryView; status?: string; filtered: boolean };
const HISTORY_KEYS = { q: 'flag', entity: 'entity', env: 'env', who: 'who', change: 'change', when: 'when', from: 'from', to: 'to', status: 'status' } as const;

/** History's view and filters from its address. */
export function readHistoryAddress(hash: string): HistoryAddress {
  const p = new URLSearchParams(hash.split('?')[1] ?? '');
  const v = p.get('view') ?? '';
  const view = (HISTORY_VIEWS as readonly string[]).includes(v) ? v as HistoryView : VIEW_ALIASES[v] ?? 'changes';
  const out: HistoryAddress = { view, filtered: false };
  for (const [k, name] of Object.entries(HISTORY_KEYS) as [keyof typeof HISTORY_KEYS, string][]) {
    const val = p.get(name);
    if (val) { out[k] = val; out.filtered = true; }
  }
  return out;
}

/** History's address for a view and its filters; filters left empty aren't in it. */
export function historyHref(view: HistoryView, f: HistoryFilters & { status?: string } = {}): string {
  const p = new URLSearchParams();
  if (view !== 'changes') p.set('view', view);
  for (const [k, name] of Object.entries(HISTORY_KEYS) as [keyof typeof HISTORY_KEYS, string][]) {
    const val = f[k]?.trim();
    if (val) p.set(name, val);
  }
  const q = p.toString();
  return `#/history${q ? `?${q}` : ''}`;
}

/** Addresses that moved: each environment's revisions are in History, services are under Developers, and Migration is in Settings. Null: it didn't. */
export function movedAddress(hash: string): string | null {
  const parts = routeParts(hash);
  if (!parts) return null;
  if (parts[0] === 'flags' && (parts[2] === 'versions' || parts[2] === 'revisions')) return historyHref('revisions', { env: parts[1] });
  if (parts[0] === 'settings' && parts[1] === 'services') return '#/services';
  if (parts[0] === 'migration') return '#/settings/migration';
  if (parts[0] === 'settings' && !parts[1]) return '#/settings/environments';
  return null;
}

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
  if (f.entity) p.set('entity', f.entity);
  if (f.env) p.set('environment', f.env);
  if (f.who) p.set('by', f.who);
  if (f.change) p.set('type', f.change);
  const r = historyRange(f.when, f.from, f.to, now);
  if (r.from) p.set('from', r.from);
  if (r.to) p.set('to', r.to);
  return p.toString();
}
export const historyPath = (f: HistoryFilters) => `/history?${historyQuery(f)}`;
/** One environment's revisions, a page of them (History → Revisions). */
export const versionsPath = (env: string, page: number) => `/environments/${env}/versions?page=${page}&size=${PAGE_SIZE}`;
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
    case 'flags': {
      // the view in the address, or the one this browser last used; the page asks the same (Flags.tsx)
      const v = flagViewFrom(hashQuery(hash));
      return [flagListPath({ env: pageEnv(meta, a), ...v, q: v.q.trim() }, 0, flagPageSize(readPersistent('flags.size', PAGE_SIZE)))];
    }
    case 'flag': return a ? [flagPath(a)] : [];
    case 'releases': return [releaseListPath(pageEnv(meta, a), readPersistent('releases.show', ''), readPersistent('releases.owner', ''), '', 0)];
    case 'release': return a ? [flagPath(a), flagRequestsPath(a)] : [];
    case 'dimensions': {
      if (!a) return [];
      if (!b) return [dimensionListPath(a, '', 0)];
      const env = pageEnv(meta, c);
      // its tab of the entities under it (#/dimensions/<dimension>/<key>/<env>/children), or its flags
      const first = parts[4] === 'children' ? childrenGridPath(a, b, env, false, '', 0)
        : entityFlagsPath(a, b, env, readPersistent<string>('entity.own', 'all') === 'own', '', 0);
      return [first, entityPath(a, b)];
    }
    case 'history': {
      // the view and filters in the address, else the ones this browser remembers
      const at = readHistoryAddress(hash);
      if (at.view === 'revisions') return at.env ? [versionsPath(at.env, 0)] : [];
      if (at.view === 'requests') return [CHANGE_SETS_PATH];
      return [historyPath(at.filtered ? at : historyFilters())];
    }
    case 'keys': return [KEYS_PATH];
    case 'tokens': return [TOKENS_PATH];
    case 'approvals': return [CHANGE_SETS_PATH];
    case 'settings': return a === 'sso' ? [SSO_PATH] : [];   // Settings → Single sign-on; the other settings pages are drawn from /meta or load their own
    default: return [];
  }
}

/** Fetches what the page at this address needs first. Resolves when it's there (or failed: the page shows that). */
export const preload = (hash: string, meta: Meta) => Promise.all(firstPaths(hash, meta).map(prefetch)).then(() => {});
