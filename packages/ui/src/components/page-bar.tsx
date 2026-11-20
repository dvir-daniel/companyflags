import * as React from "react"
import { CaretDownIcon, CheckIcon, XIcon } from "@phosphor-icons/react"
import { cn } from "../lib/utils.ts"
import { BAR_CONTROLS, barTextButton } from "./page-bar-classes.ts"
import { Popover, PopoverContent, PopoverTrigger } from "./popover.tsx"

/*
 * The dense console's page bar (Stripe / Linear): sticky at the top of a fluid MainPane, 56px tall.
 * Title and count on the left, search and filter chips in the middle, the page's actions on the right.
 *
 *   <PageBar title="Flags" count="5,009" crumbs={…} actions={<Button>+ New flag</Button>}>
 *     <SearchField … />
 *     <FilterSelect label="Status" value={status} onChange={setStatus} options={[["", "All"], ["on", "On"], ["off", "Off"]]} />
 *   </PageBar>
 */
function PageBar({
  title,
  count,
  crumbs,
  actions,
  children,
  className,
}: {
  /** leave it out for a toolbar under a page's own header (search and filters only) */
  title?: React.ReactNode
  count?: React.ReactNode
  crumbs?: React.ReactNode
  actions?: React.ReactNode
  children?: React.ReactNode
  className?: string
}) {
  // the bar wraps on narrow screens; tell the sticky table head below how tall it really is
  const ref = React.useRef<HTMLElement>(null)
  React.useLayoutEffect(() => {
    const el = ref.current
    const host = el?.parentElement
    if (!el || !host) return
    // on phones the bar scrolls away (it wraps to 3+ rows), so the table head sticks to the very top
    const set = () => host.style.setProperty("--page-bar-h", getComputedStyle(el).position === "sticky" ? `${el.offsetHeight}px` : "0px")
    set()
    const ro = new ResizeObserver(set)
    ro.observe(el)
    return () => {
      ro.disconnect()
      host.style.removeProperty("--page-bar-h")
    }
  }, [])
  return (
    <header
      ref={ref}
      data-slot="page-bar"
      className={cn(
        "sticky top-0 z-30 flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 border-b border-rule bg-background px-6 py-2.5 max-md:static max-sm:px-4",
        className
      )}
    >
      {title !== undefined || crumbs ? (
        <div className="flex min-w-0 items-baseline gap-2.5">
          {crumbs ? <span className="flex items-baseline gap-2 text-15 text-ink-3">{crumbs}<span aria-hidden>/</span></span> : null}
          {title !== undefined ? <h1 className="m-0 truncate text-15 leading-tight font-semibold tracking-normal text-ink">{title}</h1> : null}
          {count !== undefined ? <span className="font-mono text-13 text-ink-3">{count}</span> : null}
        </div>
      ) : null}
      {children ? <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 max-md:basis-full max-md:order-last">{children}</div> : <span className="flex-1" />}
      {actions ? <div className={cn("ml-auto flex shrink-0 items-center gap-2", BAR_CONTROLS)}>{actions}</div> : null}
    </header>
  )
}

/**
 * A filter as a chip around the browser's own select: "Status  All ▾". It turns white-edged when it
 * filters something (its value differs from the first option).
 */
function FilterSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  display,
  className,
}: {
  label: string
  value: T
  options: [T, string][]
  onChange: (value: T) => void
  /** what the chip shows, when it should be shorter than the option ("Development" for "Development · On") */
  display?: React.ReactNode
  className?: string
}) {
  const active = options.length > 0 && value !== options[0][0]
  return (
    <label
      data-slot="filter-select"
      className={cn(
        "relative inline-flex h-8 shrink-0 cursor-default items-center gap-1.5 border pr-7 pl-2.5 text-13 transition-colors duration-150 hover:border-ink-3 focus-within:border-ink",
        // the select is invisible, so its focus shows on the chip: a ring outside it, as on a Button (an active chip's
        // border is already dark, so the border alone wouldn't change)
        "has-[select:focus-visible]:outline-1 has-[select:focus-visible]:outline-offset-2 has-[select:focus-visible]:outline-ink",
        active ? "border-ink" : "border-rule-2",
        className
      )}
    >
      <span className="text-ink-3">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        aria-label={label}
        className="absolute inset-0 cursor-default appearance-none opacity-0"
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
      <span className={cn("pointer-events-none max-w-[160px] truncate font-medium", active ? "text-ink" : "text-ink-1")}>
        {display ?? options.find(([v]) => v === value)?.[1] ?? value}
      </span>
      <CaretDownIcon aria-hidden="true" className="pointer-events-none absolute top-1/2 right-2 size-3 -translate-y-1/2 text-ink-3" />
    </label>
  )
}

type SavedView<V> = { name: string; value: V }

/**
 * Saved views (memory beyond the last visit): name the current filters and sort, then get back to
 * them in one click. The chip shows the view whose settings match what's on screen.
 *
 *   const [views, setViews] = usePersistentState<SavedView<Filters>[]>("flags.views", [])
 *   <ViewMenu views={views} current={filters} onApply={setFilters} onChange={setViews} />
 */
function ViewMenu<V>({
  views,
  current,
  onApply,
  onChange,
  className,
}: {
  views: SavedView<V>[]
  current: V
  onApply: (value: V) => void
  onChange: (views: SavedView<V>[]) => void
  className?: string
}) {
  const [open, setOpen] = React.useState(false)
  const [name, setName] = React.useState("")
  const same = (a: V, b: V) => JSON.stringify(a) === JSON.stringify(b)
  const match = views.find((v) => same(v.value, current))
  const save = () => {
    const n = name.trim()
    if (!n) return
    onChange([...views.filter((v) => v.name.toLowerCase() !== n.toLowerCase()), { name: n, value: current }])
    setName("")
    setOpen(false)
  }
  const row = "flex w-full cursor-default items-center gap-2 border-0 bg-transparent px-2 py-1.5 text-left text-13 text-ink-1 hover:bg-wash hover:text-ink"
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        data-slot="view-menu"
        className={cn(
          "relative inline-flex h-8 shrink-0 cursor-default items-center gap-1.5 border bg-transparent pr-7 pl-2.5 text-13 transition-colors duration-150 hover:border-ink-3 focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-ink",
          match ? "border-ink" : "border-rule-2",
          className
        )}
      >
        {views.length ? (
          <>
            <span className="text-ink-3">View</span>
            <span className={cn("max-w-[160px] truncate font-medium", match ? "text-ink" : "text-ink-1")}>{match?.name ?? "None"}</span>
          </>
        ) : (
          <span className="font-medium text-ink-1">Save view</span>
        )}
        <CaretDownIcon aria-hidden="true" className="pointer-events-none absolute top-1/2 right-2 size-3 -translate-y-1/2 text-ink-3" />
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1.5">
        {views.length ? (
          <ul className="m-0 mb-1.5 list-none border-b border-grid p-0 pb-1.5">
            {views.map((v) => (
              <li key={v.name} className="group flex items-center">
                <button
                  type="button"
                  className={cn(row, "min-w-0 flex-1")}
                  aria-current={match?.name === v.name ? "true" : undefined}
                  onClick={() => {
                    onApply(v.value)
                    setOpen(false)
                  }}
                >
                  <CheckIcon aria-hidden className={cn("size-3.5 shrink-0", match?.name === v.name ? "text-ink" : "invisible")} />
                  <span className="truncate">{v.name}</span>
                </button>
                <button
                  type="button"
                  aria-label={`Delete view ${v.name}`}
                  onClick={() => onChange(views.filter((x) => x.name !== v.name))}
                  className="inline-grid size-7 shrink-0 cursor-default place-items-center border-0 bg-transparent text-ink-3 opacity-0 group-hover:opacity-100 hover:text-ink focus-visible:opacity-100"
                >
                  <XIcon aria-hidden className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 mb-1.5 px-2 pt-1 text-13 text-ink-2">Save these filters and sort as a view to get back to them in one click.</p>
        )}
        <form
          className="flex items-center gap-1.5 p-0.5"
          onSubmit={(e) => {
            e.preventDefault()
            save()
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={match ? `Rename "${match.name}"…` : "Name this view"}
            aria-label="View name"
            maxLength={40}
            className="h-8 min-w-0 flex-1 border border-rule-2 bg-background px-2 text-13 text-ink outline-none placeholder:text-ink-3 focus:border-ink"
          />
          <button
            type="submit"
            disabled={!name.trim()}
            className="h-8 shrink-0 cursor-default border-0 bg-tint px-3 text-13 font-medium text-tint-ink disabled:opacity-40"
          >
            Save
          </button>
        </form>
      </PopoverContent>
    </Popover>
  )
}

export { BAR_CONTROLS, barTextButton, FilterSelect, PageBar, ViewMenu }
export type { SavedView }
