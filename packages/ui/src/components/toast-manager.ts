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

/** One toast on screen: a new one closes the one before at once, so they never pile up over the page. */
const MAX_TOASTS = 1
const shown: string[] = []

/** Show a toast. The one call the app uses. Toasts with Undo stay a little longer; `tone: "error"` turns it red. */
function notify(message: string, action?: NotifyAction, opts: { timeout?: number; tone?: "error" } = {}) {
  while (shown.length >= MAX_TOASTS) toast.close(shown.shift()!)
  const id = addToast(message, action, opts)
  shown.push(id)
  return id
}

function addToast(message: string, action?: NotifyAction, opts: { timeout?: number; tone?: "error" } = {}) {
  return toast.add({
    title: message,
    type: opts.tone,
    timeout: opts.timeout ?? (action?.label === "Undo" ? 10000 : undefined),
    actionProps: action
      ? {
          children: action.label,
          onClick: () => {
            action.onClick()
          },
        }
      : undefined,
  })
}

export { notify, toast, useBottomReserve }
export type { NotifyAction }
