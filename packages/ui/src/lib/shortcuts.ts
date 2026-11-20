import { useSyncExternalStore } from "react"

/*
 * Single-key shortcuts (j, k, x, / and the arrow keys in a list) can be turned off, for people who use speech input
 * or who press keys by accident (WCAG 2.1.4). The choice is kept in this browser. On by default.
 */

export const SHORTCUTS_STORAGE_KEY = "companyflags-shortcuts"

const listeners = new Set<() => void>()
let current: boolean | null = null

function saved(): boolean {
  try {
    return localStorage.getItem(SHORTCUTS_STORAGE_KEY) !== "off"
  } catch {
    return true
  }
}

/** Whether single-key shortcuts are on. */
export function shortcutsOn(): boolean {
  return (current ??= saved())
}

/** Turns single-key shortcuts on or off, in this browser. */
export function setShortcutsOn(on: boolean) {
  current = on
  try {
    if (on) localStorage.removeItem(SHORTCUTS_STORAGE_KEY)
    else localStorage.setItem(SHORTCUTS_STORAGE_KEY, "off")
  } catch {
    /* private mode: the choice lasts until reload */
  }
  listeners.forEach((l) => l())
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** Whether single-key shortcuts are on, kept up to date. */
export function useShortcutsOn(): boolean {
  return useSyncExternalStore(subscribe, shortcutsOn, () => true)
}
