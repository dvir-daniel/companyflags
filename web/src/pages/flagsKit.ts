// What the Flags list (Flags.tsx) works out apart from drawing: its rows, a selection that stays across pages, every flag
// a filter matches (Export, Select all), the bulk switch as one publish, the CSV, and what a new flag serves at first.
// Apart from Flags.tsx so that an edit to its components swaps in place in `pnpm dev` (React Fast Refresh), and so the
// Node tests can check it.
import { useEffect, useState } from 'react';
import { api, CODE_DEFAULT, type FlagDetail, type FlagSummary, type Layer } from '../api.ts';
import { FLAG_VIEW_DEFAULTS, flagListPath, flagViewFrom, hashQuery, type FlagFilters, type FlagView } from '../paths.ts';
import { writePersistent } from '../persist.ts';
import type { SwitchPath } from '../../../server/policy.ts';
import { MAX_PAGE_SIZE } from '../../../server/listing.ts';

export type EnvState = { enabled: boolean; entityLayers: number; defaultVariation: string; defaultValue: unknown; rules: number };
export type Row = Omit<FlagSummary, 'envs'> & { envs: Record<string, EnvState>; changedAt?: string | null; changedBy?: string | null; lastVersion?: number | null };
export type FlagPage = { rows: Row[]; matched: number; all: number; page: number; size: number; owners?: string[]; tags?: string[] };

/** Comfortable: two lines a row (the name, then the key and tags). Compact: one line, to see more at once. */
export type Density = 'comfortable' | 'compact';
export const ROW_CLASS: Record<Density, string> = { comfortable: 'min-h-[76px] py-3.5', compact: 'min-h-[40px] py-1.5' };
export const density = (v: unknown): Density => (v === 'compact' ? 'compact' : 'comfortable');

// the browser window (typed loosely: the Node tests load this module, and Node has no window)
type Win = { location: { hash: string }; addEventListener(type: 'hashchange', fn: () => void): void; removeEventListener(type: 'hashchange', fn: () => void): void };
const win = () => globalThis as unknown as Win;

/**
 * The list's view, kept in the address (paths.ts flagViewFrom): it opens from the address, follows Back and pasted
 * links, and each change is also remembered in this browser for the next plain #/flags (except the search). The page
 * writes the address back (history.replaceState: no new entry per keystroke).
 */
export function useFlagView(): [FlagView, (v: FlagView) => void] {
  const [view, setState] = useState<FlagView>(() => flagViewFrom(hashQuery(win().location.hash)));
  useEffect(() => {
    const w = win();
    const on = () => { if (/^#\/?flags(\/|\?|$)/.test(w.location.hash)) setState(flagViewFrom(hashQuery(w.location.hash))); };
    w.addEventListener('hashchange', on);
    return () => w.removeEventListener('hashchange', on);
  }, []);
  const set = (v: FlagView) => {
    setState(v);
    for (const k of Object.keys(FLAG_VIEW_DEFAULTS) as (keyof FlagView)[]) if (k !== 'q') writePersistent(`flags.${k}`, v[k]);
  };
  return [view, set];
}

/** History's list of an environment's versions: the one home for what changed (the Flags list's old Versions tab). */
export const versionsHref = (env: string) => `#/history?view=versions&env=${encodeURIComponent(env)}`;

/** Past its remove-by date (YYYY-MM-DD) on `today` (YYYY-MM-DD), as the server's ?stale=overdue and the Releases list. */
export const isOverdue = (removeBy: string | null | undefined, today: string) => !!removeBy && removeBy < today;
export const today = (now = new Date()) => now.toISOString().slice(0, 10);

/**
 * The flags you picked, by key, with the row each was picked from: kept while you page, so a bulk action can act on
 * flags from several pages. A new search, filter or environment (`resetKey`) starts over, as what matches changed.
 */
export function useKeptSelection(resetKey: string) {
  const [picked, setPicked] = useState<Map<string, Row>>(() => new Map());
  const [at, setAt] = useState(resetKey);
  if (at !== resetKey) { setAt(resetKey); if (picked.size) setPicked(new Map()); }
  const isSelected = (key: string) => picked.has(key);
  const toggle = (row: Row) => setPicked((m) => { const n = new Map(m); if (n.has(row.key)) n.delete(row.key); else n.set(row.key, row); return n; });
  /** the page's checkbox: all of this page in, or (when they all are) all of it out */
  const togglePage = (rows: Row[]) => setPicked((m) => {
    const n = new Map(m);
    if (rows.length && rows.every((r) => n.has(r.key))) for (const r of rows) n.delete(r.key);
    else for (const r of rows) n.set(r.key, r);
    return n;
  });
  const choose = (rows: Row[]) => setPicked(new Map(rows.map((r) => [r.key, r])));
  const clear = () => setPicked(new Map());
  return {
    isSelected, toggle, togglePage, choose, clear, count: picked.size, rows: [...picked.values()],
    pageAll: (rows: Row[]) => rows.length > 0 && rows.every((r) => picked.has(r.key)),
    pageSome: (rows: Row[]) => rows.some((r) => picked.has(r.key)) && !rows.every((r) => picked.has(r.key)),
  };
}

/** Every flag these filters match, in their sort, a page of the largest size at a time (Export, Select all matching). */
export async function allMatching(f: FlagFilters, get: (path: string) => Promise<FlagPage> = (p) => api<FlagPage>('GET', p)): Promise<Row[]> {
  const out: Row[] = [];
  for (let page = 0; ; page++) {
    const r = await get(flagListPath(f, page, MAX_PAGE_SIZE));
    out.push(...r.rows);
    if (r.rows.length === 0 || out.length >= r.matched) return out;
  }
}

/** Runs `fn` on each, at most `n` at a time, in order of the answers' places (reads several flags at once). */
export async function mapLimit<T, R>(xs: readonly T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(xs.length);
  let next = 0;
  const worker = async () => { while (next < xs.length) { const i = next++; out[i] = await fn(xs[i]); } };
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, worker));
  return out;
}

/** A change to one flag's defaults, as POST /environments/:env/publish takes it. */
export type PublishItem = { flag: string; entity: null; expectedVersion: number; layer: Omit<Layer, 'version' | 'updatedAt' | 'updatedBy'> };

/**
 * The bulk switch as publish items: each flag's defaults in `env` with On/off set, against the version it has now.
 * Flags already that way are left out. The server applies them together (one version) where nothing is reviewed, and
 * files them as one request where it is.
 */
export function switchItems(details: readonly FlagDetail[], env: string, on: boolean): PublishItem[] {
  return details.flatMap((d) => {
    const base = d.layers[env]?.base;
    if (!base || d.archivedAt || !!base.enabled === on) return [];
    const { version, updatedAt: _u, updatedBy: _b, ...layer } = base;
    return [{ flag: d.key, entity: null, expectedVersion: version, layer: { ...layer, enabled: on } }];
  });
}

/** The steps of a bulk switch by how they go through: together now, together as one request, and break-glass (the
 *  server takes break-glass one flag at a time). */
export function switchBatches(steps: readonly { key: string; path: SwitchPath }[]) {
  const of = (p: SwitchPath) => steps.filter((s) => s.path === p).map((s) => s.key);
  return { now: of('now'), review: of('review'), breakGlass: of('break-glass') };
}

/** The CSV of these flags: one status column per environment, the remove-by date, and when each last changed here. */
export function flagsCsv(rows: readonly Row[], envs: readonly string[]): { header: string[]; rows: unknown[][] } {
  return {
    header: ['key', 'name', 'tags', ...envs.map((e) => `${e}_status`), 'type', 'purpose', 'owner', 'remove_by', 'last_version', 'changed_at'],
    rows: rows.map((f) => [f.key, f.name, f.tags.join(' '), ...envs.map((e) => (f.envs[e]?.enabled ? 'on' : 'off')), f.valueType, f.kind, f.owner,
      f.removeBy, f.lastVersion, f.changedAt]),
  };
}

/** What a new flag's Default starts on: a named value, never the code default (a flag that sends nothing looks like a
 *  broken connection). On/off flags start on `off`; others on their first value. */
export const startDefault = (rows: readonly { key: string }[], type: string) =>
  (type === 'bool' && rows.some((r) => r.key === 'off') ? 'off' : rows.find((r) => r.key)?.key ?? CODE_DEFAULT);

/** "a, b and c" */
const and = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/**
 * What creating the flag does in each environment, for the New flag dialog: on at once where nothing is reviewed, off
 * where changes are reviewed until someone turns it on there. `served`: what everyone gets ('' for the code default).
 */
export function startsLine(envs: readonly { name: string; reviewed: boolean }[], served: string): string {
  const open = envs.filter((e) => !e.reviewed).map((e) => e.name);
  const shut = envs.filter((e) => e.reviewed).map((e) => e.name);
  const gets = served ? `everyone gets ${served}` : 'apps use the default in their code';
  return [
    open.length && `Starts on in ${and(open)}: ${gets}.`,
    shut.length && `Starts off in ${and(shut)} until it’s turned on there, so apps use the default in their code.`,
  ].filter(Boolean).join(' ');
}

/** The services a new flag is in at first: every one, apps and backends. A backend reads only the flags it is in (server/flagd.ts). */
export const newFlagServices = (services: readonly { key: string }[]) => services.map((p) => p.key);
/** The line under the New flag dialog's services. */
export const SERVICES_HINT = 'Every service gets it at first. These are its services in every environment, and an environment added later copies them.';
