// How this installation's console looks (Settings → Appearance, server/appearance.ts): fetched once per visit from
// GET /api/appearance (open before the sign-in), remembered in this browser so the next visit draws the right name and
// logo at once, and applied to the page: the tab's title and icon, the accent color and the default light or dark.
// The server already puts the name, icon and colors into the page it sends; this keeps them right after a change and
// in `pnpm dev`, where Vite sends the page.
import { useSyncExternalStore } from 'react';
import { setDefaultTheme } from '@companyflags/ui/lib/theme';
import { accentCss, DEFAULT_NAME, EMPTY, type Appearance, type PublicAppearance } from '../../server/appearance.ts';
import { readPersistent, writePersistent } from './persist.ts';

export type Look = PublicAppearance;
const NONE: Look = { ...EMPTY, source: 'console' };

let look: Look = { ...NONE, ...readPersistent<Partial<Look>>('appearance', {}) };
const listeners = new Set<() => void>();
let shown: Pick<Appearance, 'accent' | 'accentColor' | 'mode'> & { icon: string | null; name: string | null } | null = null;

/** Puts these settings on the page: the accent's CSS, the default light or dark, the tab's icon. */
export function applyLook(a: Pick<Appearance, 'accent' | 'accentColor' | 'mode' | 'name'> & { icon: string | null }) {
  if (typeof document === 'undefined') return;
  if (shown && shown.accent === a.accent && shown.accentColor === a.accentColor && shown.mode === a.mode && shown.icon === a.icon && shown.name === a.name) return;
  shown = { accent: a.accent, accentColor: a.accentColor, mode: a.mode, icon: a.icon, name: a.name };
  let style = document.getElementById('appearance');
  const css = accentCss(a);
  if (css && !style) { style = document.createElement('style'); style.id = 'appearance'; document.head.append(style); }
  if (style) style.textContent = css;
  setDefaultTheme(a.mode);
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (link) {
    link.dataset.builtIn ??= link.href;
    link.href = a.icon ?? link.dataset.builtIn;
  }
}

function set(next: Look) {
  look = next;
  writePersistent('appearance', next);
  applyLook(next);
  listeners.forEach((l) => l());
}

let asked: Promise<Look> | null = null;
/** Asks the server once per visit (again with `fresh`, after an admin saved). */
export function loadLook(fresh = false): Promise<Look> {
  if (fresh) asked = null;
  asked ??= fetch('/api/appearance').then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((a: Look) => { set({ ...NONE, ...a }); return look; });
  asked.catch(() => { asked = null; });
  return asked;
}

/** The settings in use now. */
export const currentLook = () => look;
/** The console's name: the installation's, or CompanyFlags. */
export const lookName = (a: Look = look) => a.name ?? DEFAULT_NAME;

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
/** The settings, kept up to date. */
export const useLook = (): Look => useSyncExternalStore(subscribe, currentLook, currentLook);

/** Reads a picked file as a data URL. */
export const fileAsDataUrl = (file: File): Promise<string> => new Promise((done, fail) => {
  const r = new FileReader();
  r.onload = () => done(String(r.result));
  r.onerror = () => fail(r.error ?? new Error('couldn’t read the file'));
  r.readAsDataURL(file);
});
