// Kept out of button.tsx (which re-exports it) so the component hot-swaps when edited: Fast Refresh
// only swaps a file whose exports are all components.
import { cva } from "class-variance-authority"

/**
 * Buttons in this style (DESIGN.md):
 * - default: white primary button, 14px medium.
 * - secondary: small uppercase ghost button for secondary actions.
 * - outline: the same ghost button with a stronger rule, for batch actions.
 * - demo: dashed, labeled "Demo /", for prototype-only controls.
 * - stop: red outline, for stopping a recording.
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 cursor-default items-center justify-center gap-1.5 rounded-none border border-transparent bg-clip-padding whitespace-nowrap transition-colors outline-none select-none focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "h-8 px-[18px] bg-primary text-primary-foreground text-sm font-medium hover:bg-primary-hover",
        secondary:
          "h-[27px] px-[9px] border-rule text-11 font-normal uppercase tracking-[0.55px] text-ink/60 hover:border-rule-2 hover:text-ink",
        outline:
          "h-[27px] px-[9px] border-rule-2 text-11 font-normal uppercase tracking-[0.55px] text-ink-1 hover:border-ink-3 hover:text-ink",
        ghost: "text-ink-2 hover:bg-wash hover:text-ink aria-expanded:bg-wash aria-expanded:text-ink",
        link: "h-auto p-0 text-13 font-normal text-ink underline decoration-ink-4 underline-offset-4 hover:decoration-ink",
        demo: "h-[27px] px-[10px] border-dashed border-rule-2 font-mono text-11 font-normal uppercase text-ink-2 before:mr-[7px] before:text-ink-4 before:content-['Demo_/'] hover:border-ink-3 hover:text-ink",
        stop: "h-8 px-[18px] border-live text-sm font-medium text-live hover:bg-live/10",
      },
      size: {
        default: "",
        icon: "size-8",
        "icon-sm": "size-7",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export { buttonVariants }
