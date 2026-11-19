// Kept out of panel.tsx (which re-exports them) so the component hot-swaps when edited: Fast Refresh
// only swaps a file whose exports are all components.

/** A mono caps column head row for a table or list in a flush panel. */
const panelHeadClass = "border-b border-grid bg-panel px-5 py-2.5 font-mono text-11 font-normal tracking-[0.55px] text-ink-3 uppercase max-sm:px-4"
/** A row in a flush panel: edge to edge, divided by 8% lines. Rows that open something add `hover:bg-wash`; a row that is a link inside an <li> puts this on the <li>. */
const panelRowClass = "border-b border-grid px-5 py-3 last:border-b-0 max-sm:px-4"

export { panelHeadClass, panelRowClass }
