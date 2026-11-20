// Kept out of data-table.tsx (which re-exports them) so the component hot-swaps when edited: Fast Refresh
// only swaps a file whose exports are all components.
import * as React from "react"
import { shortcutsOn } from "../lib/shortcuts.ts"

/** Which rows are selected, by id. Selection clears itself when the visible ids change. */
function useSelection(ids: string[]) {
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const key = ids.join("\u0000")
  React.useEffect(() => {
    setSelected((s) => (s.size ? new Set([...s].filter((id) => ids.includes(id))) : s))
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const all = ids.length > 0 && ids.every((id) => selected.has(id))
  const some = !all && ids.some((id) => selected.has(id))
  return {
    selected,
    isSelected: (id: string) => selected.has(id),
    toggle,
    toggleAll: () => setSelected(all ? new Set() : new Set(ids)),
    clear: () => setSelected(new Set()),
    all,
    some,
    count: selected.size,
  }
}

/** Where a list's keys apply: a table whose rows carry data-row-index. */
const TABLE = '[role="table"], [role="grid"], [role="treegrid"]'
/** Fields and widgets that use the arrow keys themselves: keys pressed there are theirs. */
const OWN_KEYS =
  'input, textarea, select, [contenteditable=true], [role="dialog"], [role="radiogroup"], [role="tablist"], [role="listbox"], [role="menu"], [role="combobox"]'

/**
 * Keyboard for a list, while focus is in its table (Tab into a row, or click one): ↑/↓ (or j/k) move to the next
 * row and put focus on it, x selects it, Enter opens it, Esc clears the selection. Nothing happens while focus is
 * anywhere else, so the arrow keys still scroll the page, and keys pressed in a field are the field's.
 * j, k and x are single-key shortcuts: they're off when the person turned shortcuts off (lib/shortcuts.ts, WCAG
 * 2.1.4). The arrow keys, Enter and Esc always work in the table. Returns the active row's index.
 */
function useListKeys({
  count,
  onOpen,
  onToggle,
  onClear,
  enabled = true,
}: {
  count: number
  onOpen?: (index: number) => void
  onToggle?: (index: number) => void
  onClear?: () => void
  enabled?: boolean
}) {
  const [active, setActiveState] = React.useState(-1)
  // the handler reads the row from a ref, so fast typing ("j x j x") never acts on a stale row
  const ref = React.useRef(-1)
  // the table the keys were last used in: its rows are looked up in it, not anywhere on the page
  const table = React.useRef<Element | null>(null)
  const setActive = React.useCallback((i: number) => {
    ref.current = i
    setActiveState(i)
  }, [])
  const handlers = React.useRef({ onOpen, onToggle, onClear, count })
  React.useEffect(() => {
    handlers.current = { onOpen, onToggle, onClear, count }
  })
  React.useEffect(() => {
    if (ref.current >= count) setActive(count - 1)
  }, [count, setActive])
  React.useEffect(() => {
    if (!enabled) return
    const tableOf = (t: Element | null) => {
      const el = t?.closest(TABLE) ?? null
      return el && el.querySelector("[data-row-index]") ? el : null
    }
    // focus put on a row (Tab, a click) makes it the active one
    const onFocus = (e: FocusEvent) => {
      const t = e.target instanceof Element ? e.target : null
      const row = t?.closest<HTMLElement>("[data-row-index]")
      const tb = tableOf(t)
      if (!row || !tb) return
      table.current = tb
      const i = Number(row.dataset.rowIndex)
      if (Number.isInteger(i) && i !== ref.current) setActive(i)
    }
    const focusRow = (i: number) => {
      const row = table.current?.querySelector<HTMLElement>(`[data-row-index="${i}"]`)
      if (!row) return
      // the row's own way in (its main button or link), else anything in it that takes focus
      const target =
        row.querySelector<HTMLElement>('button:not([role="checkbox"]), a[href]') ?? row.querySelector<HTMLElement>("button, [tabindex]")
      if (target) target.focus()
      else row.scrollIntoView({ block: "nearest" })
    }
    const onKey = (e: KeyboardEvent) => {
      const t = e.target instanceof Element ? e.target : null
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (!t || t.closest(OWN_KEYS)) return
      const h = handlers.current
      // Esc clears the selection, from the table or from the bar that acts on it
      if (e.key === "Escape") {
        if (tableOf(t) || t.closest('[data-slot="bulk-bar"]')) h.onClear?.()
        return
      }
      const tb = tableOf(t)
      if (!tb) return
      table.current = tb
      const letters = shortcutsOn()
      if (e.key === "ArrowDown" || (letters && e.key === "j")) {
        e.preventDefault()
        const next = Math.min(h.count - 1, ref.current + 1)
        setActive(next)
        focusRow(next)
      } else if (e.key === "ArrowUp" || (letters && e.key === "k")) {
        e.preventDefault()
        const next = Math.max(0, ref.current - 1)
        setActive(next)
        focusRow(next)
      } else if (letters && e.key === "x" && ref.current >= 0) {
        e.preventDefault()
        h.onToggle?.(ref.current)
      } else if (e.key === "Enter" && ref.current >= 0 && !t.closest('button, a, [role="checkbox"]')) {
        e.preventDefault()
        h.onOpen?.(ref.current)
      }
    }
    window.addEventListener("keydown", onKey)
    window.addEventListener("focusin", onFocus)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("focusin", onFocus)
    }
  }, [enabled, setActive])
  React.useEffect(() => {
    if (active < 0) return
    ;(table.current ?? document).querySelector(`[data-row-index="${active}"]`)?.scrollIntoView({ block: "nearest" })
  }, [active])
  return { active, setActive }
}

export { useListKeys, useSelection }
