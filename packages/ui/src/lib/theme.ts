import { useSyncExternalStore } from "react"

/*
 * Light, dark, or auto. Auto (until a person chooses, and again when they go back to it) is the way the installation
 * set it (<html data-mode="light|dark">, put in by the server) or else the way the device is set, and it follows the
 * device when that changes. A person's own light or dark is kept in localStorage. The theme in use is written to
 * <html data-theme="light|dark">, which styles.css reads.
 *
 * Call `initTheme()` once at startup, and put `themeBootScript` in index.html's <head> so the
 * first paint already has the right colors:
 *   <script>/* the string in themeBootScript *\/</script>
 */

export type Theme = "light" | "dark"
/** What a person picked: a theme, or "auto" (the installation's default, else the device). */
export type ThemeChoice = Theme | "auto"

export const THEME_STORAGE_KEY = "companyflags-theme"

let fallback: Theme | null = null
const media = () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null)
const deviceTheme = (): Theme => (media() && !media()!.matches ? "light" : "dark")
/** The installation's default (setDefaultTheme, or <html data-mode>), else the device's. */
function defaultTheme(): Theme {
  if (fallback) return fallback
  const m = typeof document !== "undefined" ? document.documentElement.dataset.mode : undefined
  return m === "light" || m === "dark" ? m : deviceTheme()
}
/** Whether auto follows the device (no installation default). */
export function autoIsDevice(): boolean {
  if (fallback) return false
  const m = typeof document !== "undefined" ? document.documentElement.dataset.mode : undefined
  return m !== "light" && m !== "dark"
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
let choice: ThemeChoice | null = null
/** The theme in use: the person's own, or the installation's default, or the device's. */
export function readTheme(): Theme {
  return (current ??= saved() ?? defaultTheme())
}
/** What the person picked: light, dark or auto. */
export function readThemeChoice(): ThemeChoice {
  return (choice ??= saved() ?? "auto")
}

function apply(theme: Theme) {
  current = theme
  if (typeof document !== "undefined") document.documentElement.dataset.theme = theme
  listeners.forEach((l) => l())
}

/** The person's choice: kept in this browser. "auto" forgets it, and the theme follows the default again. */
export function setTheme(theme: ThemeChoice) {
  choice = theme
  try {
    if (theme === "auto") localStorage.removeItem(THEME_STORAGE_KEY)
    else localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    /* private mode: the choice lasts until reload */
  }
  apply(theme === "auto" ? defaultTheme() : theme)
}

/** The installation's default ("device": none). Changes the look now for someone who hasn't chosen. */
export function setDefaultTheme(mode: Theme | "device") {
  fallback = mode === "device" ? null : mode
  if (typeof document !== "undefined") {
    if (fallback) document.documentElement.dataset.mode = fallback
    else delete document.documentElement.dataset.mode
  }
  if (readThemeChoice() === "auto") apply(defaultTheme())
}

/** The next choice, from the one in use: auto → the other look → this look → auto, so each click changes something. */
export function nextThemeChoice(): ThemeChoice {
  const c = readThemeChoice()
  const d = defaultTheme()
  const other: Theme = d === "dark" ? "light" : "dark"
  return c === "auto" ? other : c === other ? d : "auto"
}

/** Auto → the other look → this look → auto. */
export const toggleTheme = () => setTheme(nextThemeChoice())

let watching = false
/** Applies the theme, and follows the device while the choice is auto. Safe to call twice. */
export function initTheme() {
  apply(readTheme())
  const m = media()
  if (watching || !m) return
  watching = true
  m.addEventListener?.("change", () => {
    if (readThemeChoice() === "auto") apply(defaultTheme())
  })
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** The current theme and choice, kept up to date, and a way to change them. */
export function useTheme(): { theme: Theme; choice: ThemeChoice; setTheme: (t: ThemeChoice) => void; toggle: () => void } {
  const theme = useSyncExternalStore(subscribe, readTheme, () => "dark" as Theme)
  const picked = useSyncExternalStore(subscribe, readThemeChoice, () => "auto" as ThemeChoice)
  return { theme, choice: picked, setTheme, toggle: toggleTheme }
}

/** Inline in index.html's <head>: sets data-theme before the first paint, so nothing flashes. */
export const themeBootScript = `try{var d=document.documentElement,c=localStorage.getItem("${THEME_STORAGE_KEY}"),m=d.dataset.mode;d.dataset.theme=c==="light"||c==="dark"?c:m==="light"||m==="dark"?m:matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}catch(e){document.documentElement.dataset.theme="dark"}`
