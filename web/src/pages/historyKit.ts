// What the History page keeps in its address (#/history?view=…&env=…), apart from History.tsx so that an edit to its
// components swaps in place in `pnpm dev` (React Fast Refresh); an edit here reloads the page.
import { useEffect, useState } from 'react';
import { historyHref, readHistoryAddress, routeParts, type HistoryAddress, type HistoryView } from '../paths.ts';
import { readPersistent, writePersistent } from '../persist.ts';

/**
 * History's address, kept up to date: a link to another view or other filters (the sidebar, the Published list, a
 * shared link) opens them. `n` counts those, so a view can start over from the new address.
 */
export function useHistoryAddress(): { at: HistoryAddress; n: number } {
  const [nav, setNav] = useState(() => ({ at: readHistoryAddress(location.hash), n: 0 }));
  useEffect(() => {
    const on = () => {
      if (routeParts(location.hash)?.[0] !== 'history') return;
      setNav((x) => ({ at: readHistoryAddress(location.hash), n: x.n + 1 }));
    };
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return nav;
}

/** Puts the filters in the address without a new entry in the browser's history (typing a search doesn't add one per
 *  key), so the address can be shared and reloaded as it is. */
export function showInAddress(view: HistoryView, f: Parameters<typeof historyHref>[1]) {
  const next = historyHref(view, f);
  if (location.hash !== next) history.replaceState(history.state, '', next);
}

/**
 * One History filter: from the address when it names any filter, else as this browser last left it. Setting it also
 * remembers it, as the default for the next visit with no filters in the address.
 */
export function useHistoryFilter(key: string, at: HistoryAddress, fromAddress: string | undefined): [string, (v: string) => void] {
  const [value, setValue] = useState<string>(() => (at.filtered ? fromAddress ?? '' : readPersistent(key, '')));
  const set = (v: string) => {
    setValue(v);
    writePersistent(key, v);
  };
  return [value, set];
}
