// Kept out of callout.tsx (which re-exports it) so the component hot-swaps when edited: Fast Refresh
// only swaps a file whose exports are all components.
import { cva } from "class-variance-authority"

/**
 * A note set off by a line on its left, as in an inbox.
 * - note: grey, for context ("This applies to every app").
 * - warn: amber on its tint, for something to watch ("Production: changes need a review").
 * - error: red on its tint, for what went wrong; give it role="alert" when it appears after an action.
 */
const calloutVariants = cva("border-l px-3 py-2 text-13", {
  variants: {
    tone: {
      note: "border-rule-2 text-ink-2",
      warn: "border-flag bg-flag-bg text-flag",
      error: "border-live bg-live/5 text-live",
    },
  },
  defaultVariants: { tone: "note" },
})

export { calloutVariants }
