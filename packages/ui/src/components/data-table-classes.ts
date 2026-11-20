// Kept out of data-table.tsx (which re-exports them) so the component hot-swaps when edited: Fast Refresh
// only swaps a file whose exports are all components.

/** The sticky header row: sits right under the PageBar, however tall it has wrapped to. */
const tableHeadClass =
  "sticky top-[var(--page-bar-h,3.5rem)] z-20 h-9 items-center gap-x-4 border-b border-rule bg-panel px-6 font-mono text-11 font-normal tracking-[0.55px] text-ink-3 uppercase max-sm:px-4"

/** A data row: 44px, edge to edge, 8% lines; selected rows and the keyboard's row are washed. */
const tableRowClass =
  "min-h-11 scroll-mt-[calc(var(--page-bar-h,3.5rem)+2.25rem)] scroll-mb-14 items-center gap-x-4 border-b border-grid px-6 py-2 text-13 text-ink transition-colors duration-150 hover:bg-wash aria-selected:bg-wash data-[selected=true]:bg-wash data-[active=true]:shadow-[inset_2px_0_0_var(--underline)] max-sm:px-4"

export { tableHeadClass, tableRowClass }
