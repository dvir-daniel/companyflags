// Kept out of badge.tsx (which re-exports it) so the component hot-swaps when edited: Fast Refresh
// only swaps a file whose exports are all components.
import { cva } from "class-variance-authority"

/**
 * A label in a 1px box, in Geist Mono caps: kinds, states, environments. Not a pill
 * (rounded pills are only for announcements and phase tags, see `Pill`).
 * - default: grey label.
 * - live: red, for production, problems and recording.
 * - warn: amber, for things waiting on someone.
 * - ok: green, for things that are on or done.
 * - count: inverted white block with a number, as on a sidebar item.
 */
const badgeVariants = cva(
  "inline-flex shrink-0 items-center gap-1 whitespace-nowrap border px-1.5 font-mono text-11 leading-[18px] font-normal tracking-[0.55px] uppercase",
  {
    variants: {
      variant: {
        default: "border-rule-2 text-ink-2",
        live: "border-live/40 text-live",
        warn: "border-flag/35 text-flag",
        ok: "border-ok/35 text-ok",
        count: "min-w-[19px] justify-center border-0 bg-ink px-[5px] leading-[17px] font-medium tracking-normal text-background",
      },
    },
    defaultVariants: { variant: "default" },
  }
)

export { badgeVariants }
