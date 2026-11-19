import * as React from "react"
import { cn } from "../lib/utils.ts"

export interface SegmentedOption<T extends string> {
  value: T
  label: React.ReactNode
  disabled?: boolean
  title?: string
}

/**
 * Pick one of a few: mono caps cells divided by 1px lines, the chosen one inverted
 * (environments, value types, filters).
 */
function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: T
  options: SegmentedOption<T>[]
  onChange: (value: T) => void
  label: string
  className?: string
}) {
  return (
    <div data-slot="segmented" role="radiogroup" aria-label={label} className={cn("inline-flex border border-rule-2", className)}>
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            data-slot="segmented-item"
            aria-checked={on}
            disabled={o.disabled}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cn(
              "h-7 cursor-default border-0 px-3 font-mono text-xs leading-none tracking-[0.6px] uppercase whitespace-nowrap outline-none transition-colors [&+&]:border-l [&+&]:border-rule-2",
              "focus-visible:outline-1 focus-visible:-outline-offset-2 focus-visible:outline-ink disabled:opacity-40",
              on ? "bg-ink text-background" : "bg-transparent text-ink-nav hover:bg-wash hover:text-ink"
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export { Segmented }
