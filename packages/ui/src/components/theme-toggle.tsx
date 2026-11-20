import * as React from "react"
import { CircleHalfIcon, MoonIcon, SunIcon } from "@phosphor-icons/react"
import { cn } from "../lib/utils.ts"
import { autoIsDevice, nextThemeChoice, useTheme, type ThemeChoice } from "../lib/theme.ts"

const NAME: Record<ThemeChoice, string> = { auto: "Auto", light: "Light", dark: "Dark" }

/**
 * A title bar cell for the theme: it shows the choice in use (Light, Dark, or Auto: as the device or the server is
 * set) and moves to the next on click. Mono caps, like the bar's other cells. `compact` shows the icon only (it
 * always does in a phone-width window).
 */
function ThemeToggle({ compact, className, ...props }: React.ComponentProps<"button"> & { compact?: boolean }) {
  const { choice, theme, toggle } = useTheme()
  const auto = autoIsDevice() ? "as the device is set" : "as this server is set"
  const said = (c: ThemeChoice) => (c === "auto" ? `Auto (${auto})` : NAME[c])
  const next = nextThemeChoice()
  const Icon = choice === "auto" ? CircleHalfIcon : theme === "dark" ? MoonIcon : SunIcon
  return (
    <button
      type="button"
      data-slot="theme-toggle"
      onClick={toggle}
      title={`Theme: ${said(choice)}. Switch to ${said(next)}.`}
      aria-label={`Theme: ${said(choice)}. Switch to ${said(next)}.`}
      className={cn(
        "flex cursor-default items-center gap-2 border-0 border-l border-sep bg-transparent px-4 font-mono text-xs tracking-[0.6px] text-ink-nav uppercase outline-none hover:text-ink",
        "focus-visible:outline-1 focus-visible:-outline-offset-2 focus-visible:outline-ink",
        className
      )}
      {...props}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      {compact ? null : <span className="max-sm:hidden">{NAME[choice]}</span>}
    </button>
  )
}

export { ThemeToggle }
