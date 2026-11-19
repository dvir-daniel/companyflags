// Kept out of app-frame.tsx (which re-exports them) so the component hot-swaps when edited: Fast Refresh
// only swaps a file whose exports are all components.
import { cn } from "../lib/utils.ts"

/**
 * Classes for a sidebar link. Put them on your router's link; the active one is the element
 * with aria-current="page".
 */
const sidebarItemClass = cn(
  "flex w-full cursor-default items-center gap-2.5 px-3 py-[5px] text-sm text-ink-nav hover:text-ink hover:no-underline",
  "aria-[current=page]:bg-wash aria-[current=page]:text-ink [&_svg]:shrink-0 [&_svg]:opacity-85"
)

/** Classes for a prototype-only control in the footer: dashed and labeled "Demo /". */
const demoControlClass =
  "shrink-0 cursor-default whitespace-nowrap border border-dashed border-rule-2 bg-transparent px-2 leading-[20px] text-ink-2 uppercase hover:border-ink-3 hover:text-ink"

export { demoControlClass, sidebarItemClass }
