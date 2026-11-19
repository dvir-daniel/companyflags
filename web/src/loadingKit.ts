// Sizes the loading shapes (loading.tsx) share with the pages, so a placeholder takes the room of what replaces it.
// Apart from loading.tsx so that an edit to its components swaps in place in `pnpm dev` (React Fast Refresh).

/** The room a list's pager takes under the table (Pager in ui.tsx), kept while the list loads. */
export const pagerRow = 'min-h-12';

/** The tabs of a flag's page and of a release's page, as bones. */
export const FLAG_TABS = ['w-12', 'w-20', 'w-16', 'w-16', 'w-12'];
export const RELEASE_TABS = ['w-16', 'w-16'];
