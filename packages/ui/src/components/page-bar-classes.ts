// Kept out of page-bar.tsx (which re-exports them) so the component hot-swaps when edited: Fast Refresh
// only swaps a file whose exports are all components.

/**
 * Harmony (similarity): every button in a bar looks alike whatever its variant: 32px tall, 13px sans,
 * medium, sentence case. Only colour says which one is primary or dangerous. Used by the page bar, the
 * bulk bar and the drawer footer.
 */
const BAR_CONTROLS =
  "[&_[data-slot=button]]:h-8 [&_[data-slot=button]]:px-3 [&_[data-slot=button]]:font-sans [&_[data-slot=button]]:text-13 [&_[data-slot=button]]:font-medium [&_[data-slot=button]]:normal-case [&_[data-slot=button]]:tracking-normal"

/** A quiet text action in a bar ("Reset", "Clear"): 32px tall like its neighbours, 13px sans, no box. */
const barTextButton =
  "inline-flex h-8 shrink-0 cursor-default items-center border-0 bg-transparent px-2 font-sans text-13 text-ink-3 outline-none transition-colors duration-150 hover:text-ink focus-visible:outline-1 focus-visible:outline-ink"

/** A link in the page bar's crumbs, to the page above this one: "Releases / new_checkout". The one way back. */
const crumbLink = "text-ink-3 no-underline hover:text-ink hover:no-underline"

export { BAR_CONTROLS, barTextButton, crumbLink }
