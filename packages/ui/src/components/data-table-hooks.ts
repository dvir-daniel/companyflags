// Kept out of data-table.tsx (which re-exports them) so the component hot-swaps when edited: Fast Refresh
// only swaps a file whose exports are all components.
import * as React from "react"

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

/**
 * Keyboard for a list: j/k or ↑/↓ move the active row, x selects it, Enter opens it, Esc clears.
 * Keys typed into a field are ignored. Returns the active row's index.
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
  const setActive = React.useCallback((i: number) => {
    ref.current = i
    setActiveState(i)
  }, [])
  const handlers = React.useRef({ onOpen, onToggle, onClear, count })
  handlers.current = { onOpen, onToggle, onClear, count }
  React.useEffect(() => {
    if (ref.current >= count) setActive(count - 1)
  }, [count, setActive])
  React.useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target instanceof Element ? e.target : null
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (t && (t.closest("input, textarea, select, [contenteditable=true]") || t.closest('[role="dialog"]'))) return
      const h = handlers.current
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault()
        setActive(Math.min(h.count - 1, ref.current + 1))
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault()
        setActive(Math.max(0, ref.current - 1))
      } else if (e.key === "x" && ref.current >= 0) {
        e.preventDefault()
        h.onToggle?.(ref.current)
      } else if (e.key === "Enter" && ref.current >= 0 && !(t && t.closest("button, a"))) {
        e.preventDefault()
        h.onOpen?.(ref.current)
      } else if (e.key === "Escape") {
        h.onClear?.()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [enabled, setActive])
  React.useEffect(() => {
    if (active < 0) return
    document.querySelector(`[data-row-index="${active}"]`)?.scrollIntoView({ block: "nearest" })
  }, [active])
  return { active, setActive }
}

export { useListKeys, useSelection }
