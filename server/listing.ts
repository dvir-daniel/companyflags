// One contract for every paged list (flags, customers, a customer's flags, compare):
// ?page=0&size=50&q=text in, { rows, matched, all, page, size } out.
//   matched: rows that pass the search and filters (what the pager pages through)
//   all:     every row before searching (for "Search 5,009 flags")
// Pure, so the console's in-page lists search the same way.

export type ListQuery = { page: number; size: number; q: string };
export type Page<T> = { rows: T[]; matched: number; all: number; page: number; size: number };

export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

// Reads the paging parameters. Without `page`, null: the caller returns its full, unpaged list.
export function listQuery(get: (name: string) => unknown): ListQuery | null {
  const raw = get('page');
  if (raw === undefined || raw === null) return null;
  const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(get('size') ?? DEFAULT_PAGE_SIZE)) || DEFAULT_PAGE_SIZE));
  return { page: Math.max(0, Math.floor(Number(raw)) || 0), size, q: String(get('q') ?? '').trim().toLowerCase() };
}

// Case-insensitive "contains" over any of the texts (a key, a name, a description).
export function searchHit(q: string, ...texts: (string | null | undefined)[]): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return texts.some((t) => !!t && t.toLowerCase().includes(needle));
}

// SQL side of searchHit: a LIKE pattern where % and _ are literal characters.
export const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

// One page of an in-memory list. `keep` applies search and filters; `all` counts the list before them.
export function pageOf<T>(rows: T[], query: ListQuery, keep: (row: T) => boolean = () => true): Page<T> {
  const hit = rows.filter(keep);
  return { rows: hit.slice(query.page * query.size, (query.page + 1) * query.size), matched: hit.length, all: rows.length, page: query.page, size: query.size };
}
