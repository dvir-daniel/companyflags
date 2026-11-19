import * as React from "react"
import { MoonIcon, SunIcon } from "@phosphor-icons/react"
import { cn } from "../lib/utils.ts"
import { useTheme } from "../lib/theme.ts"

/**
 * A title bar cell that switches between light and dark: it shows the theme in use and flips it on click.
 * Mono caps, like the bar's other cells. `compact` shows the icon only (it always does in a phone-width window).
 */
function ThemeToggle({ compact, className, ...props }: React.ComponentProps<"button"> & { compact?: boolean }) {
  const { theme, toggle } = useTheme()
  const label = theme === "dark" ? "Dark" : "Light"
  const other = theme === "dark" ? "light" : "dark"
  const Icon = theme === "dark" ? MoonIcon : SunIcon
  return (
    <button
      type="button"
      data-slot="theme-toggle"
      onClick={toggle}
      title={`Switch to the ${other} theme`}
      aria-label={`${label} theme. Switch to the ${other} theme.`}
      className={cn(
        "flex cursor-default items-center gap-2 border-0 border-l border-sep bg-transparent px-4 font-mono text-xs tracking-[0.6px] text-ink/50 uppercase outline-none hover:text-ink",
        "focus-visible:outline-1 focus-visible:-outline-offset-2 focus-visible:outline-ink",
        className
      )}
      {...props}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      {compact ? null : <span className="max-sm:hidden">{label}</span>}
    </button>
  )
}

export { ThemeToggle }
