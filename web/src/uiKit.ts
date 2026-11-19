// The UI kit's pieces that aren't components: class recipes, hooks and small helpers. They live apart from ui.tsx so
// that an edit to a component there swaps in place in `pnpm dev` (React Fast Refresh only does that for a file whose
// exports are all components); an edit here reloads the page.
import { useEffect, useRef, useState, type RefObject } from 'react';
import { api, errorCode, peek, type ErrorCode } from './api.ts';
import { PAGE_SIZE, readPersistent, writePersistent } from './persist.ts';

/* ---------------------------------------------------------------- class recipes for native controls */

/** A native <input> or the shared Input in a dense row (32px). */
export const denseField = 'h-8 min-w-0 rounded-none border border-rule-2 bg-background px-2.5 text-13 text-ink outline-none select-text placeholder:text-ink-4 hover:border-ink-3 focus:border-ink disabled:opacity-50 aria-invalid:border-live';
/** A native <textarea>. */
export const textareaField = 'min-h-16 w-full min-w-0 resize-y rounded-none border border-rule-2 bg-background px-3 py-2 text-sm text-ink outline-none select-text placeholder:text-ink-4 hover:border-ink-3 focus:border-ink aria-invalid:border-live';
/** Mono caps label above a field, or a column head. */
export const monoLabel = 'font-mono text-11 font-normal tracking-[0.55px] text-ink-3 uppercase';

/* ---------------------------------------------------------------- memory */

/**
 * State the console remembers in this browser (filters, sort, the last environment), so a page opens the
 * way you left it. Falls back to plain state when storage isn't available (persist.ts).
 */
export function usePersistentState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => readPersistent(key, initial));
  const set = (v: T) => {
    setValue(v);
    writePersistent(key, v);
  };
  return [value, set];
}

/* ---------------------------------------------------------------- text */

/**
 * Copies text and says so only when it really worked (a secret shown once must never get a false "Copied").
 * `what` names it in the toast: "Copied key acme", "Copied new_checkout".
 */
export async function copyText(text: string, what: string, toast: (m: string, kind?: 'ok' | 'err') => void): Promise<boolean> {
  try {
    if (!navigator.clipboard) throw new Error('no clipboard');
    await navigator.clipboard.writeText(text);
    toast(`Copied ${what}`);
    return true;
  } catch {
    toast(`Couldn’t copy ${what}. Select it and copy it yourself.`, 'err');
    return false;
  }
}

/** A date people read the same way everywhere: "Feb 28, 2027". */
export const fmtDate = (iso: string) => {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);   // a calendar day ("2027-02-28") is local, not UTC midnight
  const d = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

/* ---------------------------------------------------------------- keys */

/** "/" puts the cursor in this search box, unless you're typing somewhere or a dialog is open. */
export function useSlashFocus(ref: RefObject<HTMLInputElement | null>, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !(t && t.closest('input, textarea, select, [contenteditable], [role="dialog"]'))) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [ref, enabled]);
}

/* ---------------------------------------------------------------- data */

/** Runs one request at a time and keeps its error: the message, the server's details, and its code (api.ts ErrorCode)
 *  for a page that acts on it. */
export function useAsync() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; details?: string[]; code?: ErrorCode } | null>(null);
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e: any) {
      setError({ message: e.message, details: e.details ?? e.body?.errors, code: errorCode(e) });
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

// Paging for long lists, done on the server: only the current page (50 rows) is downloaded.
// Every list answers in one shape (server/listing.ts): { rows, matched, all, page, size }.
// `filterKey` sums up the filters: a change waits for typing to pause, then goes back to page 1.
// `refreshKey` reloads the same page (e.g. after a publish). Out-of-date responses are ignored.
export type Paged = { matched: number; all: number; page: number; size: number };
// One page of a server list. A GET (a path) opens with the last answer for the same request, if there is one
// (api.ts peek), and fetches a fresh one behind it; `loading` is only true while the rows shown are for another
// request (a new search or page), so a fresh copy of the same rows never dims or flashes the list.
// A list that has to POST passes { key, load } instead: it isn't kept.
type PageRequest<R> = string | { key: string; load: () => Promise<R> };
export function useServerPage<R extends Paged>(requestFor: (page: number) => PageRequest<R>, filterKey: string, refreshKey: unknown) {
  const keyOf = (r: PageRequest<R>) => (typeof r === 'string' ? r : r.key);
  const [page, setPage] = useState(0);
  const [applied, setApplied] = useState(filterKey);
  const [requested, setRequested] = useState(() => keyOf(requestFor(0)));
  const [shown, setShown] = useState<{ path: string; data: R } | null>(() => {
    const r = requestFor(0);
    const data = typeof r === 'string' ? peek<R>(r) : undefined;
    return data ? { path: r as string, data } : null;
  });
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (filterKey === applied) return;
    const t = setTimeout(() => { setApplied(filterKey); setPage(0); }, 250);
    return () => clearTimeout(t);
  }, [filterKey, applied]);
  useEffect(() => {
    let live = true;
    const r = requestFor(page);
    const path = keyOf(r);
    setRequested(path);
    const kept = typeof r === 'string' ? peek<R>(r) : undefined;
    if (kept) setShown({ path, data: kept });
    (typeof r === 'string' ? api<R>('GET', r) : r.load()).then((r) => { if (live) { setShown({ path, data: r }); setError(null); } })
      .catch((e) => { if (live) { setError(e.message); setShown((s) => (s ? { ...s, path } : s)); } });
    return () => { live = false; };
  }, [applied, page, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const data = shown?.data ?? null;
  const loading = shown?.path !== requested && !error;
  const size = data?.size ?? PAGE_SIZE;                     // the server may clamp the size; trust its answer
  const pages = Math.max(1, Math.ceil((data?.matched ?? 0) / size));
  // a refresh can leave the page past the end (rows went away): ask for the last page there is instead
  if (data && !loading && page > pages - 1) setPage(pages - 1);
  const go = (p: number) => { setPage(p); listRef.current?.scrollTo({ top: 0 }); };
  return { data, loading, error, page: Math.min(page, pages - 1), pages, size, go, listRef };
}
