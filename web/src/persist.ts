// What the console remembers in this browser (filters, sort, the last environment), so a page opens the way you
// left it, and the page size every list asks for. No DOM or React here: navigation (paths.ts) and the Node tests
// load it. usePersistentState (ui.tsx) is the hook on top.

/** Rows per page in every server list (server/listing.ts may clamp it; trust its answer). */
export const PAGE_SIZE = 50;

// Reads are kept in memory (a sidebar hover asks for several at once); another tab's change clears them.
const remembered = new Map<string, unknown>();
type StorageListener = (e: { key: string | null }) => void;
// the browser window, when there is one (there isn't in Node tests)
(globalThis as { addEventListener?: (type: 'storage', fn: StorageListener) => void }).addEventListener?.('storage', (e) => {
  if (e.key === null) remembered.clear(); else remembered.delete(e.key);
});

/** A remembered choice (usePersistentState), read outside a component: to know what a page will ask for. */
export function readPersistent<T>(key: string, initial: T): T {
  const full = `cf.${key}`;
  if (remembered.has(full)) return (remembered.get(full) as T | undefined) ?? initial;
  let value: T | undefined;
  try {
    const raw = localStorage.getItem(full);
    value = raw === null ? undefined : (JSON.parse(raw) as T);
  } catch {
    value = undefined;
  }
  remembered.set(full, value);
  return value ?? initial;
}

/** Remembers a choice, in memory and in this browser's storage when there is storage. */
export function writePersistent<T>(key: string, value: T): void {
  const full = `cf.${key}`;
  remembered.set(full, value);
  try { localStorage.setItem(full, JSON.stringify(value)); } catch { /* storage off: this visit only */ }
}
