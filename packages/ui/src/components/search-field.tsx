import * as React from "react"
import { cn } from "../lib/utils.ts"

/**
 * A search box with the magnifier, as on a settings page.
 * size "lg": the page's main search (50px, on a panel); "sm": a filter in a toolbar or panel header (32px, like NativeSelect sm).
 * The input fills the box; put a clear button or a count in `end`.
 */
function SearchField({
  size = "sm",
  end,
  className,
  inputClassName,
  ...props
}: Omit<React.ComponentProps<"input">, "size"> & { size?: "sm" | "lg"; end?: React.ReactNode; inputClassName?: string }) {
  return (
    <label
      data-slot="search-field"
      className={cn(
        "flex min-w-0 items-center gap-3 border border-control-edge focus-within:border-ink hover:border-ink-3",
        size === "lg" ? "bg-panel px-4" : "bg-background px-3",
        className
      )}
    >
      <svg viewBox="0 0 18 18" width={size === "lg" ? 16 : 14} height={size === "lg" ? 16 : 14} fill="none" stroke="currentColor" strokeWidth="1.25" className="shrink-0 text-ink-3" aria-hidden="true">
        <circle cx="8" cy="8" r="4.5" />
        <path d="m11.4 11.4 3.6 3.6" />
      </svg>
      <input
        type="search"
        data-slot="search-field-input"
        className={cn(
          "min-w-0 flex-1 border-0 bg-transparent p-0 text-ink outline-none select-text placeholder:text-ink-3 [&::-webkit-search-cancel-button]:hidden",
          size === "lg" ? "h-12 text-base" : "h-[30px] text-13",
          inputClassName
        )}
        {...props}
      />
      {end}
    </label>
  )
}

export { SearchField }
