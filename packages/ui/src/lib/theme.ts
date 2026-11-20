import { useSyncExternalStore } from "react"

/*
 * Light or dark: two choices, nothing else. Until a person chooses, the app starts the way the installation set it
 * (<html data-mode="light|dark">, put in by the server) or else the way the device is set; once they choose, their
 * choice is kept in localStorage. The theme is written to <html data-theme="light|dark">, which styles.css reads.
 *
 * Call `initTheme()` once at startup, and put `themeBootScript` in index.html's <head> so the
 * first paint already has the right colors:
 *   <script>/* the string in themeBootScript *\/</script>
 */

export type Theme = "light" | "dark"

export const THEME_STORAGE_KEY = "companyflags-theme"

let fallback: Theme | null = null
const deviceTheme = (): Theme =>
  typeof window !== "undefined" && window.matchMedia && !window.matchMedia("(prefers-color-scheme: dark)").matches ? "light" : "dark"
/** The installation's default (setDefaultTheme, or <html data-mode>), else the device's. */
function defaultTheme(): Theme {
  if (fallback) return fallback
  const m = typeof document !== "undefined" ? document.documentElement.dataset.mode : undefined
  return m === "light" || m === "dark" ? m : deviceTheme()
}

function saved(): Theme | null {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY)
    return v === "light" || v === "dark" ? v : null
  } catch {
    return null
  }
}

const listeners = new Set<() => void>()
let current: Theme | null = null
/** The theme in use: the person's own, or the installation's default, or the device's. */
export function readTheme(): Theme {
  return (current ??= saved() ?? defaultTheme())
}

function apply(theme: Theme) {
  current = theme
  if (typeof document !== "undefined") document.documentElement.dataset.theme = theme
  listeners.forEach((l) => l())
}

/** The person's choice: kept in this browser. */
export function setTheme(theme: Theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    /* private mode: the choice lasts until reload */
  }
  apply(theme)
}

/** The installation's default ("device": none). Changes the look now for someone who hasn't chosen. */
export function setDefaultTheme(mode: Theme | "device") {
  fallback = mode === "device" ? null : mode
  if (typeof document !== "undefined") {
    if (fallback) document.documentElement.dataset.mode = fallback
    else delete document.documentElement.dataset.mode
  }
  if (!saved()) apply(defaultTheme())
}

/** Light ↔ dark. */
export const toggleTheme = () => setTheme(readTheme() === "dark" ? "light" : "dark")

/** Applies the theme. Safe to call twice. */
export function initTheme() {
  apply(readTheme())
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
export const themeBootScript = `try{var d=document.documentElement,c=localStorage.getItem("${THEME_STORAGE_KEY}"),m=d.dataset.mode;d.dataset.theme=c==="light"||c==="dark"?c:m==="light"||m==="dark"?m:matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}catch(e){document.documentElement.dataset.theme="dark"}`
