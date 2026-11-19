import { createContext, use, type ReactNode } from 'react';
import { vocabOf, type Meta, type Vocab } from './api.ts';

/* What every page shares: the app's context and navigation. Kept out of main.tsx so a page can be
   hot-reloaded without re-running the app's startup. */

export type DialogAction = { id: string; label: string; tone?: 'primary' | 'danger' | 'default'; needsReason?: boolean };
export type DialogOpts = {
  title: string; body: ReactNode; actions: DialogAction[];
  reason?: { label: string; placeholder?: string; hint?: string };
};
export type AppCtx = {
  meta: Meta; reload: () => Promise<void>; user: string; revisionTick: number; pendingApprovals: number;
  /** One toast at a time. `action` adds one button to it, e.g. { label: 'Undo', onClick } for anything reversible.
   *  Given an error, it's an error toast, and its code (api.ts ErrorCode) decides the words and the Reload button. */
  toast: (m: string | Error, kind?: 'ok' | 'err', action?: { label: string; onClick: () => void }) => void;
  ask: (o: DialogOpts) => Promise<{ action: string | null; reason: string }>;
  setDirty: (key: string, dirty: boolean) => void;
};
export const AppContext = createContext<AppCtx | null>(null);
export function useApp(): AppCtx {
  const ctx = use(AppContext);
  if (!ctx) throw new Error('useApp() is used outside the app (no <AppContext> above it)');
  return ctx;
}
export const go = (path: string) => { location.hash = `#/${path}`; };
/** The words of this installation's dimensions, and entity names by key, for words.ts sentences ("Store is Acme 12"). */
export function useVocab(): Vocab {
  return vocabOf(useApp().meta);
}
