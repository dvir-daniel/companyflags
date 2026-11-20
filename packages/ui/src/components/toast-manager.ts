// Kept out of toast.tsx (which re-exports them) so the component hot-swaps when edited: Fast Refresh
// only swaps a file whose exports are all components.
import * as React from "react"
import { Toast as ToastPrimitive } from "@base-ui/react/toast"

/*
 * Bars pinned to the bottom (the bulk bar, a drawer's footer, an unpublished-changes bar) reserve their
 * height while they're on screen, so a toast never covers their buttons: the toast area sits above the
 * tallest one (--bottom-bar-h).
 */
const reserved = new Map<symbol, number>()
const applyReserve = () =>
  document.documentElement.style.setProperty("--bottom-bar-h", `${Math.max(0, ...reserved.values())}px`)

/** A callback ref for a bar pinned to the bottom: toasts stay above it while it's mounted. */
function useBottomReserve() {
  const id = React.useRef(Symbol("bottom-bar"))
  const ro = React.useRef<ResizeObserver | null>(null)
  return React.useCallback((el: HTMLElement | null) => {
    ro.current?.disconnect()
    ro.current = null
    if (!el) {
      reserved.delete(id.current)
      applyReserve()
      return
    }
    const set = () => {
      reserved.set(id.current, el.offsetHeight)
      applyReserve()
    }
    set()
    ro.current = new ResizeObserver(set)
    ro.current.observe(el)
  }, [])
}

/** The app's one toast manager: `Toaster` shows its toasts, `notify` adds them. */
const toast = ToastPrimitive.createToastManager()

interface NotifyAction {
  label: string
  onClick: () => void
}

/** At most this many toasts on screen, stacked, the newest at the bottom. */
const MAX_TOASTS = 3
/** How long a toast with Undo stays. Every toast also stays while the pointer or focus is on it. */
const UNDO_MS = 20000
/** The toasts on screen, oldest first, and whether each offers an action (Undo, Retry, View). */
const shown: { id: string; action: boolean }[] = []

/**
 * Show a toast. The one call the app uses. `tone: "error"` turns it red and announces it at once. Toasts stack: a new
 * one never replaces one that offers an action (Undo stays its full 20 seconds); when the stack is full, the oldest
 * plain notice goes first.
 */
function notify(message: string, action?: NotifyAction, opts: { timeout?: number; tone?: "error" } = {}) {
  while (shown.length >= MAX_TOASTS) {
    const plain = shown.findIndex((t) => !t.action)
    const [gone] = shown.splice(plain >= 0 ? plain : 0, 1)
    toast.close(gone.id)
  }
  const id = addToast(message, action, opts)
  shown.push({ id, action: !!action })
  return id
}

function addToast(message: string, action?: NotifyAction, opts: { timeout?: number; tone?: "error" } = {}) {
  const id: string = toast.add({
    title: message,
    type: opts.tone,
    priority: opts.tone === "error" ? "high" : "low",
    timeout: opts.timeout ?? (action?.label === "Undo" ? UNDO_MS : undefined),
    // gone from the screen (its time is up, or it was closed): no longer counted
    onRemove: () => {
      const i = shown.findIndex((t) => t.id === id)
      if (i >= 0) shown.splice(i, 1)
    },
    actionProps: action
      ? {
          children: action.label,
          onClick: () => {
            action.onClick()
          },
        }
      : undefined,
  })
  return id
}

export { notify, toast, useBottomReserve }
export type { NotifyAction }
