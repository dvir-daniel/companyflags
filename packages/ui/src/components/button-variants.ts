// Kept out of button.tsx (which re-exports it) so the component hot-swaps when edited: Fast Refresh
// only swaps a file whose exports are all components.
import { cva } from "class-variance-authority"

/**
 * Buttons in this style (DESIGN.md). Every variant is 32px tall, 13px sans, medium, sentence case, wherever it sits
 * (a bar, a drawer, a form, a table row): only color says which one is primary or dangerous.
 * - default: the primary action, filled with the accent (ink unless the installation picked one).
 * - secondary: a quiet outlined button for the other actions.
 * - outline: the same with a stronger edge, for actions on selected rows.
 * - stop: red outline, for destructive actions (turn off, delete, roll back).
 * - ghost: no edge, for icon buttons and menus. link: underlined text.
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 cursor-default items-center justify-center gap-1.5 rounded-none border border-transparent bg-clip-padding font-sans whitespace-nowrap normal-case tracking-normal transition-colors outline-none select-none focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:pointer-events-none data-disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "h-8 px-3 bg-primary text-13 font-medium text-primary-foreground hover:bg-primary-hover",
        secondary: "h-8 px-3 border-rule-2 text-13 font-medium text-ink-1 hover:border-ink-3 hover:text-ink",
        outline: "h-8 px-3 border-ink-4 text-13 font-medium text-ink hover:border-ink-3",
        ghost: "text-ink-2 hover:bg-wash hover:text-ink aria-expanded:bg-wash aria-expanded:text-ink",
        link: "h-auto p-0 text-13 font-normal text-ink underline decoration-ink-4 underline-offset-4 hover:decoration-ink",
        stop: "h-8 px-3 border-live text-13 font-medium text-live hover:bg-live/10",
      },
      size: {
        default: "",
        icon: "size-8 px-0",
        "icon-sm": "size-7 px-0",
        "icon-xs": "size-6 px-0 [&_svg:not([class*='size-'])]:size-3",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export { buttonVariants }
