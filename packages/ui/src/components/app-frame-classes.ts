// Kept out of app-frame.tsx (which re-exports them) so the component hot-swaps when edited: Fast Refresh
// only swaps a file whose exports are all components.
import { cn } from "../lib/utils.ts"

/**
 * Classes for a sidebar link. Put them on your router's link; the active one is the element
 * with aria-current="page".
 */
const sidebarItemClass = cn(
  "flex w-full cursor-default items-center gap-2.5 px-3 py-[5px] text-sm text-ink-nav hover:text-ink hover:no-underline",
  "aria-[current=page]:bg-wash aria-[current=page]:text-ink aria-[current=page]:shadow-[inset_2px_0_0_var(--tint-mark)] aria-[current=page]:[&_svg]:text-tint [&_svg]:shrink-0 [&_svg]:opacity-85"
)


export { sidebarItemClass }
