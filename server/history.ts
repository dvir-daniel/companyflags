// History, read: every change ever recorded (journal.ts writes it, and nothing is ever deleted), newest first.
//
//   historyFilter(get)       the filters a request asks for: flag, entity, environment, version, person, kind of
//                            change, a time range, and `before` (the id of the last entry already shown)
//   historyPage(q, filter)   one page of the newest matching entries older than `before`: going back a page costs the
//                            same however old the history is, so years of it stay one click away
//   historyBatches(q, filter) every matching entry, in pages, for an export of any size
//   historyCsv(row)          one entry as a CSV line, safe to open in a spreadsheet
//
// The indexes behind each filter are in migrations 0006 and 0008.

import { HttpError, type Queryable } from './db.ts';
import { likePattern } from './listing.ts';

export type HistoryRow = {
  id: number; environment: string | null; revision: number | null; changedAt: string | Date; changedBy: string; actorType: string;
  changeType: string; flag: string | null; entity: string | null; before: unknown; after: unknown; comment: string | null;
  changeSetId: number | null;
};

export type HistoryFilter = { where: string[]; params: unknown[]; before: number | null; limit: number };

/** A page of history: 200 entries unless asked for fewer or more, never more than 1000. */
export const HISTORY_PAGE = 200;
export const HISTORY_MAX = 1000;

// the same columns /history has always answered with (db.ts reads bigints as numbers on both databases)
const SELECT = `select h.id, e.key as environment, h.revision, h.changed_at as "changedAt",
  h.changed_by as "changedBy", h.actor_type as "actorType", h.change_type as "changeType", h.flag, h.entity, h.before, h.after,
  h.comment, h.change_set_id as "changeSetId"
  from change_history h left join environment e on e.id = h.environment_id`;

const whole = (name: string, v: string) => {
  if (!/^\d{1,15}$/.test(v)) throw new HttpError(422, `${name}: a whole number`);
  return Number(v);
};
const time = (name: string, v: string) => {
  const t = Date.parse(v);
  if (!/^\d{4}-\d{2}-\d{2}/.test(v) || Number.isNaN(t)) throw new HttpError(422, `${name}: a date and time, e.g. 2026-11-18 or 2026-11-18T09:30:00Z`);
  return new Date(t).toISOString();
};

/** The filters in a request's query string. Every one is optional; together they narrow the list.
 *  - flag, entity, environment (a key), revision (a version of that environment), by (who made the change)
 *  - q: part of a flag's key (the History page's search box)
 *  - type: kinds of change, comma-separated: a whole kind (`layer.update`) or every kind of a subject (`layer`, `person`, `sso`)
 *  - from, to: changes made at or after `from`, and before `to` (ISO dates or times)
 *  - before: only entries older than this one (its id): the next page after the last entry shown
 *  - limit: entries per page (default 200, at most 1000) */
export function historyFilter(get: (k: string) => string | undefined): HistoryFilter {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: (n: string) => string, v: unknown) => { params.push(v); where.push(sql(`$${params.length}`)); };
  for (const [k, col] of [['flag', 'h.flag'], ['entity', 'h.entity'], ['by', 'h.changed_by']] as const) {
    const v = get(k);
    if (v) add((n) => `${col} = ${n}`, v);
  }
  const search = get('q')?.trim().toLowerCase();
  if (search) add((n) => `h.flag like ${n}`, likePattern(search));
  const env = get('environment');
  if (env) add((n) => `h.environment_id = (select id from environment where key = ${n})`, env);
  const revision = get('revision');
  if (revision) add((n) => `h.revision = ${n}`, whole('revision', revision));
  const types = (get('type') ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  if (types.length) {
    if (types.some((t) => !/^[a-z_]+(\.[a-z_]+)?$/.test(t))) throw new HttpError(422, 'type: kinds of change, e.g. layer.update, or a subject, e.g. layer');
    const exact = types.filter((t) => t.includes('.'));
    const subjects = types.filter((t) => !t.includes('.'));
    const parts: string[] = [];
    // one subject alone matches the index on it (0008), so its newest entries come first without a sort
    if (subjects.length === 1) { params.push(subjects[0]); parts.push(`split_part(h.change_type, '.', 1) = $${params.length}`); }
    else if (subjects.length) { params.push(subjects); parts.push(`split_part(h.change_type, '.', 1) = any($${params.length}::text[])`); }
    if (exact.length) { params.push(exact); parts.push(`h.change_type = any($${params.length}::text[])`); }
    where.push(parts.length === 1 ? parts[0] : `(${parts.join(' or ')})`);
  }
  // changed_at is when the change's transaction began, so ids don't follow it exactly: the range is on the time itself
  const from = get('from');
  if (from) add((n) => `h.changed_at >= ${n}::timestamptz`, time('from', from));
  const to = get('to');
  if (to) add((n) => `h.changed_at < ${n}::timestamptz`, time('to', to));
  if (from && to && Date.parse(from) >= Date.parse(to)) throw new HttpError(422, 'from: before to');
  const b = get('before');
  const before = b ? whole('before', b) : null;
  const l = get('limit');
  const limit = l ? Math.min(Math.max(whole('limit', l), 1), HISTORY_MAX) : HISTORY_PAGE;
  return { where, params, before, limit };
}

/** The newest `limit` entries matching the filter, older than `before` when it is set. */
export async function historyPage(q: Queryable, f: HistoryFilter, before = f.before, limit = f.limit): Promise<HistoryRow[]> {
  const where = [...f.where];
  const params = [...f.params];
  if (before !== null) { params.push(before); where.push(`h.id < $${params.length}`); }
  params.push(limit);
  return (await q.query<HistoryRow>(`${SELECT} ${where.length ? `where ${where.join(' and ')}` : ''}
    order by h.id desc limit $${params.length}`, params)).rows;
}

/** Every entry matching the filter, newest first, a thousand at a time: for an export, however long. */
export async function* historyBatches(q: Queryable, f: HistoryFilter): AsyncGenerator<HistoryRow[]> {
  let before = f.before;
  for (;;) {
    const rows = await historyPage(q, f, before, HISTORY_MAX);
    if (!rows.length) return;
    yield rows;
    if (rows.length < HISTORY_MAX) return;
    before = rows[rows.length - 1].id;
  }
}

export const HISTORY_CSV_HEADER = ['id', 'when', 'environment', 'version', 'who', 'actor', 'change', 'flag', 'entity', 'comment',
  'request', 'before', 'after'];

/** One entry as a line of CSV. Text that a spreadsheet would run as a formula (=, +, -, @) is kept as text. */
export function historyCsv(r: HistoryRow): string {
  const at = r.changedAt instanceof Date ? r.changedAt.toISOString() : new Date(r.changedAt).toISOString();
  const json = (v: unknown) => (v === null || v === undefined ? '' : JSON.stringify(v));
  return [r.id, at, r.environment, r.revision, r.changedBy, r.actorType, r.changeType, r.flag, r.entity, r.comment,
    r.changeSetId, json(r.before), json(r.after)].map(csvCell).join(',');
}

export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
