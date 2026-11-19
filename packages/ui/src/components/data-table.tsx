import * as React from "react"
import { ArrowDownIcon, ArrowUpIcon } from "@phosphor-icons/react"
import { cn } from "../lib/utils.ts"
import { Checkbox } from "./checkbox.tsx"
import { tableHeadClass, tableRowClass } from "./data-table-classes.ts"
import { useListKeys, useSelection } from "./data-table-hooks.ts"
import { BAR_CONTROLS, barTextButton } from "./page-bar-classes.ts"
import { useBottomReserve } from "./toast-manager.ts"
import { HelpTip } from "./tooltip.tsx"

/*
 * The dense console's tables: full width under the PageBar, a sticky mono header, 44px rows with a
 * checkbox column, sortable columns, a bulk-action bar while rows are selected, and keyboard use
 * (j/k or ↑/↓ to move, x to select, Enter to open, Esc to clear).
 *
 * Layout is the page's: give the head and the rows the same grid-cols, e.g.
 *   const cols = "grid grid-cols-[40px_minmax(0,2fr)_100px_…]"
 *   <div role="table"><div role="row" className={cn(cols, tableHeadClass)}>…</div>
 *     {rows.map((r, i) => <div role="row" className={cn(cols, tableRowClass)} data-active={i === active} aria-selected={…}>…)}</div>
 */

/** A column head that sorts: click to sort by it, again to flip the direction. `help` adds a "?" that explains the column. */
function SortHeader<K extends string>({
  label,
  sortKey,
  sort,
  dir,
  onSort,
  help,
  className,
}: {
  label: string
  sortKey: K
  sort: K
  dir: "asc" | "desc"
  onSort: (key: K, dir: "asc" | "desc") => void
  help?: React.ReactNode
  className?: string
}) {
  const on = sort === sortKey
  const button = (
    <button
      type="button"
      onClick={() => onSort(sortKey, on && dir === "asc" ? "desc" : "asc")}
      aria-sort={on ? (dir === "asc" ? "ascending" : "descending") : undefined}
      className={cn(
        "inline-flex cursor-default items-center gap-1 border-0 bg-transparent p-0 font-mono text-11 tracking-[0.55px] uppercase hover:text-ink",
        on ? "text-ink" : "text-ink-3",
        className
      )}
    >
      {label}
      {on ? dir === "asc" ? <ArrowUpIcon aria-hidden className="size-3" /> : <ArrowDownIcon aria-hidden className="size-3" /> : null}
    </button>
  )
  if (!help) return button
  return (
    <span className="inline-flex items-center gap-1">
      {button}
      <HelpTip>{help}</HelpTip>
    </span>
  )
}

/** A column head that doesn't sort, with an optional "?" that explains it. */
function ColumnHead({ label, help, className }: { label: string; help?: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {label}
      {help ? <HelpTip>{help}</HelpTip> : null}
    </span>
  )
}

/**
 * The first load: placeholder rows in the table's own grid, so nothing jumps when the data arrives.
 * `cells` gives each cell's extra classes (the same ones that hide columns on small screens).
 */
function TableSkeleton({ cols, cells, rows = 8 }: { cols: string; cells: string[]; rows?: number }) {
  const widths = ["w-4", "w-3/4", "w-10", "w-1/2", "w-2/3", "w-1/2", "w-3/5", "w-12"]
  return (
    <div aria-hidden data-slot="table-skeleton">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className={cn(cols, tableRowClass, "hover:bg-transparent")}>
          {cells.map((extra, c) => (
            <span
              key={c}
              style={{ animationDelay: `${r * 70}ms` }}
              className={cn("block h-2.5 animate-pulse bg-rule motion-reduce:animate-none", widths[c % widths.length], extra)}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

/** The checkbox in a row or in the header ("select all on this page"). */
function RowCheck({ checked, indeterminate, onChange, label }: { checked: boolean; indeterminate?: boolean; onChange: () => void; label: string }) {
  return (
    <span className="flex items-center" onClick={(e) => e.stopPropagation()}>
      <Checkbox checked={checked} indeterminate={indeterminate} onCheckedChange={() => onChange()} aria-label={label} />
    </span>
  )
}

/**
 * The bar that appears while rows are selected: the count, the actions for them, and Clear.
 * It sticks to the bottom of the pane.
 */
function BulkBar({ count, noun = "selected", onClear, children }: { count: number; noun?: string; onClear: () => void; children: React.ReactNode }) {
  const reserve = useBottomReserve()
  if (count === 0) return null
  return (
    <div
      ref={reserve}
      role="region"
      aria-label="Selected rows"
      data-slot="bulk-bar"
      className="sticky bottom-0 z-30 flex min-h-12 flex-wrap items-center gap-x-3 gap-y-2 border-t border-rule-2 bg-panel px-6 py-2 max-sm:px-4"
    >
      <span className="text-sm font-semibold text-ink">
        {count.toLocaleString()} {noun}
      </span>
      <span className={cn("flex flex-wrap items-center gap-2", BAR_CONTROLS)}>{children}</span>
      <span className="flex-1" />
      <button type="button" onClick={onClear} className={cn(barTextButton, "gap-1.5")}>
        Clear <kbd className="border border-rule-2 px-1 font-mono text-11 text-ink-3">Esc</kbd>
      </button>
    </div>
  )
}

type Hint = "move" | "select" | "open" | "search"

/** A short line under a table: the shortcuts. Leave out what the page doesn't have, e.g. `hide={["select"]}`. */
function KeyHints({ hide = [], className }: { hide?: Hint[]; className?: string }) {
  const k = "border border-rule-2 px-1 font-mono text-11 text-ink-2"
  const show = (h: Hint) => !hide.includes(h)
  return (
    <p className={cn("m-0 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-11 text-ink-3 uppercase", className)}>
      {show("move") && <span><kbd className={k}>J</kbd> <kbd className={k}>K</kbd> move</span>}
      {show("select") && <span><kbd className={k}>X</kbd> select</span>}
      {show("open") && <span><kbd className={k}>↵</kbd> open</span>}
      {show("search") && <span><kbd className={k}>/</kbd> search</span>}
    </p>
  )
}

export { BulkBar, ColumnHead, KeyHints, RowCheck, SortHeader, TableSkeleton, tableHeadClass, tableRowClass, useListKeys, useSelection }
