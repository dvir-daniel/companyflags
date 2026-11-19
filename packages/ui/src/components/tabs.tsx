import * as React from "react"
import { cn } from "../lib/utils.ts"

export interface TabItem<T extends string> {
  value: T
  label: React.ReactNode
}

/**
 * Underlined tabs: mono caps labels in a 44px bar over a hairline, the active one with a
 * 2px underline at 60% white. The panels are up to the page.
 */
function Tabs<T extends string>({
  value,
  items,
  onChange,
  label,
  className,
}: {
  value: T
  items: TabItem<T>[]
  onChange: (value: T) => void
  label: string
  className?: string
}) {
  return (
    <div data-slot="tabs" role="tablist" aria-label={label} className={cn("flex border-b border-rule", className)}>
      {items.map((t) => {
        const on = t.value === value
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            data-slot="tab"
            aria-selected={on}
            onClick={() => onChange(t.value)}
            className={cn(
              "mr-6 h-11 cursor-default border-0 bg-transparent px-0.5 font-mono text-xs leading-none tracking-[0.6px] uppercase outline-none",
              "focus-visible:outline-1 focus-visible:-outline-offset-2 focus-visible:outline-ink",
              on ? "text-ink shadow-[inset_0_-2px_0_var(--underline)]" : "text-ink-nav hover:text-ink"
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
