import * as React from "react"
import { cn } from "../lib/utils.ts"
import { arrowTarget } from "./roving.ts"

export interface TabItem<T extends string> {
  value: T
  label: React.ReactNode
}

/**
 * Underlined tabs: mono caps labels in a 44px bar over a hairline, the active one with a 2px underline.
 * The keyboard as in any tab list: Tab reaches the open tab, ← and → (and Home, End) open the one beside it.
 * The panel is the page's: give it `id={panelId}` and role="tabpanel", and pass `panelId` here so each tab names it.
 */
function Tabs<T extends string>({
  value,
  items,
  onChange,
  label,
  panelId,
  className,
}: {
  value: T
  items: TabItem<T>[]
  onChange: (value: T) => void
  label: string
  /** the id of the element that shows the open tab's content */
  panelId?: string
  className?: string
}) {
  const refs = React.useRef<(HTMLButtonElement | null)[]>([])
  const open = Math.max(0, items.findIndex((t) => t.value === value))
  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    const next = arrowTarget(e.key, i, items.map(() => true))
    if (next === null) return
    e.preventDefault()
    refs.current[next]?.focus()
    onChange(items[next].value)
  }
  return (
    <div data-slot="tabs" role="tablist" aria-label={label} className={cn("flex border-b border-rule", className)}>
      {items.map((t, i) => {
        const on = t.value === value
        return (
          <button
            key={t.value}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="tab"
            data-slot="tab"
            aria-selected={on}
            aria-controls={on ? panelId : undefined}
            tabIndex={i === open ? 0 : -1}
            onClick={() => onChange(t.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "mr-6 h-11 cursor-default border-0 bg-transparent px-0.5 font-mono text-xs leading-none tracking-[0.6px] uppercase outline-none",
              "focus-visible:outline-1 focus-visible:-outline-offset-2 focus-visible:outline-ink",
              // the open tab: a 2px underline, and in forced colors (where shadows are dropped) a border
              on ? "text-ink shadow-[inset_0_-2px_0_var(--underline)] forced-colors:border-b-2 forced-colors:border-[Highlight]" : "text-ink-nav hover:text-ink"
            )}
          >
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

export { Tabs }
