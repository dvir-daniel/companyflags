// Kept out of hero.tsx (which re-exports it) so the component hot-swaps when edited: Fast Refresh
// only swaps a file whose exports are all components.

/** Classes for the inverted action at the end of the bar, for a button an app draws itself. */
const heroActionClass =
  "flex h-12 min-h-0 shrink-0 cursor-default items-center gap-2 rounded-none border-0 bg-ink px-6 font-mono text-xs font-normal tracking-[0.6px] whitespace-nowrap text-background uppercase no-underline outline-none hover:bg-primary-hover hover:no-underline focus-visible:outline-1 focus-visible:-outline-offset-4 focus-visible:outline-background disabled:opacity-40 max-sm:w-full max-sm:justify-center"

export { heroActionClass }
