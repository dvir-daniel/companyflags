import { useSyncExternalStore } from "react"

/*
 * Light or dark: two choices, nothing else. On a first visit the app starts the way the device is set
 * (light or dark) and remembers that; from then on the person's own choice is kept in localStorage. The
 * theme is written to <html data-theme="light|dark">, which styles.css reads.
 *
 * Call `initTheme()` once at startup, and put `themeBootScript` in index.html's <head> so the
 * first paint already has the right colors:
 *   <script>/* the string in themeBootScript *\/</script>
 */

export type Theme = "light" | "dark"

export const THEME_STORAGE_KEY = "companyflags-theme"

const deviceTheme = (): Theme =>
  typeof window !== "undefined" && window.matchMedia && !window.matchMedia("(prefers-color-scheme: dark)").matches ? "light" : "dark"

function saved(): Theme | null {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY)
    return v === "light" || v === "dark" ? v : null
  } catch {
    return null
  }
}

let current: Theme | null = null
/** The theme in use: the saved one, or (first visit) the device's. */
export function readTheme(): Theme {
  return (current ??= saved() ?? deviceTheme())
}

const listeners = new Set<() => void>()

export function setTheme(theme: Theme) {
  current = theme
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    /* private mode: the choice lasts until reload */
  }
  if (typeof document !== "undefined") document.documentElement.dataset.theme = theme
  listeners.forEach((l) => l())
}

/** Light ↔ dark. */
export const toggleTheme = () => setTheme(readTheme() === "dark" ? "light" : "dark")

/** Applies the theme and, on a first visit, remembers the device's setting as the person's choice. Safe to call twice. */
export function initTheme() {
  setTheme(readTheme())
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** The current theme, kept up to date, and a way to change it. */
export function useTheme(): { theme: Theme; setTheme: (t: Theme) => void; toggle: () => void } {
  const theme = useSyncExternalStore(subscribe, readTheme, () => "dark" as Theme)
  return { theme, setTheme, toggle: toggleTheme }
}

/** Inline in index.html's <head>: sets data-theme before the first paint, so nothing flashes. */
export const themeBootScript = `try{var c=localStorage.getItem("${THEME_STORAGE_KEY}");document.documentElement.dataset.theme=c==="light"||c==="dark"?c:matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}catch(e){document.documentElement.dataset.theme="dark"}`
