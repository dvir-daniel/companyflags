import * as React from "react"
import { cn } from "../lib/utils.ts"
import { arrowTarget } from "./roving.ts"

export interface SegmentedOption<T extends string> {
  value: T
  label: React.ReactNode
  disabled?: boolean
  title?: string
}

/**
 * Pick one of a few: mono caps cells divided by 1px lines, the chosen one inverted
 * (environments, value types, filters). A radio group for the keyboard: Tab reaches the chosen option, the arrow
 * keys (and Home, End) choose another.
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
  const refs = React.useRef<(HTMLButtonElement | null)[]>([])
  const enabled = options.map((o) => !o.disabled)
  const chosen = options.findIndex((o) => o.value === value)
  // the one Tab stop: the chosen option, or the first that can be chosen
  const stop = chosen >= 0 && enabled[chosen] ? chosen : enabled.indexOf(true)
  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    const next = arrowTarget(e.key, i, enabled, "both")
    if (next === null) return
    e.preventDefault()
    refs.current[next]?.focus()
    onChange(options[next].value)
  }
  return (
    <div data-slot="segmented" role="radiogroup" aria-label={label} className={cn("inline-flex border border-rule-2", className)}>
      {options.map((o, i) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            data-slot="segmented-item"
            aria-checked={on}
            tabIndex={i === stop ? 0 : -1}
            disabled={o.disabled}
            title={o.title}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "relative h-7 cursor-default border-0 px-3 font-mono text-xs leading-none tracking-[0.6px] uppercase whitespace-nowrap outline-none transition-colors [&+&]:border-l [&+&]:border-rule-2",
              // the ring sits outside the cell, so it shows on the inverted (chosen) one too
              "focus-visible:z-10 focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-40",
              on ? "bg-tint text-tint-ink" : "bg-transparent text-ink-nav hover:bg-wash hover:text-ink"
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
