import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowSquareOutIcon, CheckIcon, LockSimpleIcon } from '@phosphor-icons/react';
import { Badge as UIBadge } from '@companyflags/ui/components/badge';
import { Button } from '@companyflags/ui/components/button';
import { Callout } from '@companyflags/ui/components/callout';
import { BulkBar, ColumnHead, KeyHints, RowCheck, SortHeader, tableHeadClass, tableRowClass, useListKeys, useSelection } from '@companyflags/ui/components/data-table';
import { Drawer, DrawerRow, DrawerSection } from '@companyflags/ui/components/drawer';
import { Input } from '@companyflags/ui/components/input';
import { barTextButton, FilterSelect, PageBar, ViewMenu, type SavedView } from '@companyflags/ui/components/page-bar';
import { HelpTip } from '@companyflags/ui/components/tooltip';
import { SearchField } from '@companyflags/ui/components/search-field';
import { cn } from '@companyflags/ui/lib/utils';
import { api, CHOICE_NAME, entityLabel, entityWordsOf, getsWithoutOwn, peek, type Layer, type Rule } from '../api.ts';
import { Bone, CountSlot, SkeletonRows } from '../loading.tsx';
import { CHANGE_SETS_PATH } from '../paths.ts';
import { go, useApp } from '../app.ts';
import { downloadCsv } from '../csv.ts';
import { plural } from '../text.ts';
import { Badge, Collapsible, Empty, RuleSummary, When } from '../ui.tsx';
import { denseField, monoLabel, usePersistentState, useSlashFocus } from '../uiKit.ts';
import { useEnvs } from './envs.ts';
import { approvalsLeft, approvalsNeeded, approvalsOf, mayApprove, mayReview, maySchedule, openForReview, roleInfo } from '../../../server/policy.ts';

/*
 * Approvals: the dense console queue. A sticky page bar (search, status / environment / author filters),
 * a sortable full-width table with checkboxes, bulk approve and CSV export for the selected rows, and a
 * drawer for one request. A request also opens on its own page, #/approvals/<id>.
 * Keyboard: / search, j/k move, x select, Enter open, Esc clear.
 */

// A change is to a layer (the defaults, or one entity's own settings) or to a flag's delivery: which apps get it.
// A delivery change has no entity, and its before / proposed are the app lists. No `kind` (an older server): a layer.
type ItemKind = 'layer' | 'delivery';
type Delivery = { projects: string[] };
type CsSummary = {
  id: number; environment: string; status: string; author: string; reason: string | null; createdAt: string;
  scheduledAt: string | null; appliedRevision: number | null; lastError: string | null;
  items: { flag: string; entity: string | null; kind?: ItemKind }[]; reviews: { reviewer: string; decision: string; current: boolean }[] | null;
};
type CsItem = {
  seq: number; flag: string; entity: string | null; kind?: ItemKind; expectedLayerVersion: number | null; expectedBaseVersion: number | null;
  before: Layer | Delivery | null; proposed: Layer | Delivery | null;
};
type CsDetail = Omit<CsSummary, 'items' | 'reviews'> & {
  minApprovals: number; contentHash: string;
  items: CsItem[];
  reviews: { reviewer: string; decision: string; comment: string | null; current: boolean; createdAt: string }[];
};
const isDelivery = (i: { kind?: ItemKind }) => i.kind === 'delivery';

type Sort = 'id' | 'status' | 'author' | 'when';
type Dir = 'asc' | 'desc';
/** What a saved view keeps: the filters and the sort (not the search text). */
type Filters = { status: string; env: string; author: string; sort: { by: Sort; dir: Dir } };

const STATUSES = ['in_review', 'approved', 'scheduled', 'applied', 'conflict', 'rejected', 'all'];
const STATUS_LABEL: Record<string, string> = { in_review: 'Waiting', approved: 'Approved', scheduled: 'Scheduled', applied: 'Applied', conflict: 'Conflict', rejected: 'Rejected', all: 'All' };
/** Why a status shows nothing. */
const NONE_LABEL: Record<string, string> = {
  in_review: 'Nothing is waiting for review: every request has been decided.',
  approved: 'Nothing is approved and waiting to go out: approved requests have been applied or scheduled.',
  scheduled: 'Nothing is scheduled to go out.',
  applied: 'No request has been applied yet.',
  conflict: 'No requests are in conflict: nothing changed under a request.',
  rejected: 'No requests were rejected.',
};
/** Status order when sorting: where a request is in its life. */
const RANK: Record<string, number> = { in_review: 0, approved: 1, scheduled: 2, conflict: 3, failed: 4, applied: 5, rejected: 6, cancelled: 7 };
const SORTS: Sort[] = ['id', 'status', 'author', 'when'];
const WITHDRAWABLE = ['in_review', 'approved', 'scheduled'];
/** Requests that are over: they show how they ended instead of their approvals. */
const FINAL = ['applied', 'rejected', 'cancelled'];

/* ---------------------------------------------------------------- recipes (packages/ui/DESIGN.md) */

/** checkbox, request, status, approvals, changes, environment, requested by, why, when */
const COLS = 'grid grid-cols-[28px_72px_96px_120px_minmax(0,1.3fr)_104px_112px_minmax(0,1.7fr)_84px] max-xl:grid-cols-[28px_72px_96px_120px_minmax(0,1fr)_112px_84px] max-md:grid-cols-[28px_minmax(0,1fr)_auto]';
const XL = 'max-xl:hidden';
const MD = 'max-md:hidden';
/** Each column's hide-on-small classes, for the first-load skeleton. */
const CELLS = ['', '', '', MD, MD, XL, MD, XL, MD];
/** A word in a 1px box. */
const tag = 'inline-block min-w-0 max-w-full truncate border border-rule-2 px-[7px] font-mono text-11 leading-[18px] text-ink-2';
/** Time or kind at the end of a line. */
const when = 'text-13 text-ink-2';
/** A title that opens something: underlined on hover. */
const titleLink = 'min-w-0 truncate text-ink no-underline decoration-ink-4 underline-offset-4 hover:underline';
/** A section head on the request page: the table head's mono caps, not sticky. */
const sectionHead = 'm-0 flex h-9 items-center gap-2 border-b border-grid bg-panel px-6 font-mono text-11 font-normal tracking-[0.55px] text-ink-3 uppercase max-sm:px-4';
/** A ghost button beside 32px controls (outside the bars, which size their own): the same 32px. */
const rowBtn = 'h-8 px-3';
/** A full-width note under the page bar. */
const strip = 'flex items-start gap-2 border-b border-grid px-6 py-2 text-13 [overflow-wrap:anywhere] max-sm:px-4';
/** A selected row is washed (data-selected: aria-selected doesn't belong in a table). */
const selectedRow = 'data-[selected=true]:bg-wash';
/** The cell a row opens from: a real button, so keyboard and screen-reader users can open it too. */
const cellButton = 'block max-w-full cursor-default truncate border-0 bg-transparent p-0 text-left text-ink outline-none decoration-ink-4 underline-offset-4 hover:underline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-ink';

const HELP = {
  status: 'Where the request is: waiting for an approval, approved and ready to go out, or finished. Conflict means the flag changed after the request, so it can’t go out as it is.',
  approvals: 'Approvals so far, out of the number this environment needs. Nobody can approve their own request.',
  expects: 'It goes out only if these settings are still at this version. If someone changed them since, the request becomes a conflict.',
};

const statusText = (s: string) => (s === 'in_review' ? 'waiting' : s.replace('_', ' '));
const StatusBadge = ({ status }: { status: string }) => <Badge kind={`status-${status}`}>{statusText(status)}</Badge>;
const changeTag = (i: { flag: string; entity: string | null; kind?: ItemKind }) => (isDelivery(i) ? `${i.flag} (services)` : i.entity ? `${i.flag}/${i.entity}` : i.flag);
const firstLine = (s: string | null) => s?.split('\n').find((l) => l.trim()) ?? null;
/** What a request changes, for a toast: "new_checkout" or "4 flags". */
const flagsOf = (items: { flag: string }[]) => { const f = [...new Set(items.map((i) => i.flag))]; return f.length === 1 ? f[0] : plural(f.length, 'flag'); };
/** Where requests are, for a toast: " in production" or " in production and development". */
const inEnvs = (list: { environment: string }[], envName: (e: string) => string) => {
  const e = [...new Set(list.map((c) => envName(c.environment).toLowerCase()))];
  return e.length ? ` in ${e.join(' and ')}` : '';
};
/** Runs `fn` on every item, at most `limit` at a time; each result in the items' order, fulfilled or rejected. */
async function settleAll<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      [results[i]] = await Promise.allSettled([fn(items[i])]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
/** The last value that wasn't null, so a drawer keeps showing its request while it slides away. It's kept in state
 *  and set while rendering only when the value changes (no effect, and no ref written during render). */
function useLast<T>(value: T | null): T | null {
  const [last, setLast] = useState(value);
  if (value !== null && value !== last) setLast(value);
  return value ?? last;
}

/**
 * Progress toward approval (goal gradient): one segment per approval the environment needs, filled when
 * given, and "1 of 2". A finished request shows how it ended instead.
 */
function ApprovalProgress({ status, approvals, needed, rejectedBy, revision, long }: {
  status: string; approvals: number; needed: number; rejectedBy?: string | null; revision?: number | null; long?: boolean;
}) {
  if (status === 'applied') return <span className="text-13 text-ink-2">Applied{revision ? <> as <span className="font-mono">r{revision}</span></> : null}</span>;
  if (status === 'rejected') return <span className="block truncate text-13 text-ink-2">Rejected{rejectedBy ? ` by ${rejectedBy}` : ''}</span>;
  if (status === 'cancelled') return <span className="text-13 text-ink-3">Withdrawn</span>;
  const done = Math.min(approvals, needed);
  return (
    <span className="inline-flex items-center gap-2 text-13 whitespace-nowrap" aria-label={`${done} of ${plural(needed, 'approval')}`}>
      <span aria-hidden className="flex gap-0.5">
        {Array.from({ length: needed }, (_, i) => <span key={i} className={cn('h-1.5 w-3', i < done ? 'bg-ok' : 'bg-rule-2')} />)}
      </span>
      <span aria-hidden className={done >= needed ? 'text-ok' : 'text-ink-1'}>{done} of {needed}{long && <span className="text-ink-2"> {needed === 1 ? 'approval' : 'approvals'}</span>}</span>
    </span>
  );
}

/** Approvals: the review queue, or one request on its own page. */
export function Approvals({ selected }: { selected?: number }) {
  // keyed: another request is another page, so a typed comment or a schedule time never carries over
  return selected ? <RequestPage key={selected} id={selected} /> : <Queue />;
}

/* ---------------------------------------------------------------- the queue */

function Queue() {
  const { meta, revisionTick, toast, ask, reload } = useApp();
  const { envName, envOf, isProtected } = useEnvs();
  const [q, setQ] = useState('');
  const [savedStatus, setStatus] = usePersistentState('approvals.status', 'in_review');
  const [env, setEnv] = usePersistentState('approvals.environment', '');
  const [author, setAuthor] = usePersistentState('approvals.author', '');
  const [savedSort, setSort] = usePersistentState<{ by: Sort; dir: Dir }>('approvals.sort', { by: 'when', dir: 'desc' });
  const [views, setViews] = usePersistentState<SavedView<Filters>[]>('approvals.views', []);
  const status = STATUSES.includes(savedStatus) ? savedStatus : 'in_review';
  const sort: Sort = SORTS.includes(savedSort?.by) ? savedSort.by : 'when';
  const dir: Dir = savedSort?.dir === 'asc' ? 'asc' : 'desc';
  const [all, setAll] = useState<CsSummary[] | null>(() => peek<CsSummary[]>(CHANGE_SETS_PATH) ?? null);   // the last answer, while a fresh one loads
  const [loading, setLoading] = useState(() => !peek(CHANGE_SETS_PATH));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);   // a bulk approve under way
  const search = useRef<HTMLInputElement>(null);

  // the endpoint returns the whole list (the latest 200): filter and sort here. A refresh replaces the list
  // quietly; only the first load shows as loading.
  const load = useCallback(function run(): Promise<void> {
    return api<CsSummary[]>('GET', CHANGE_SETS_PATH)
      .then((r) => { setAll(r); setLoadError(null); })
      .catch((e) => {
        setAll((a) => a ?? []); setLoadError(e.message);
        toast(`Couldn’t load the requests: ${e.message}`, 'err', { label: 'Try again', onClick: () => { run(); } });
      })
      .finally(() => setLoading(false));
  }, [toast]);
  useEffect(() => { load(); }, [load, revisionTick]);

  const needle = q.trim().toLowerCase();
  const matches = (c: CsSummary) => (!env || c.environment === env) && (!author || c.author === author) && (!needle
    || needle.replace(/^#/, '') === String(c.id)
    || c.author.toLowerCase().includes(needle)
    || (c.reason ?? '').toLowerCase().includes(needle)
    || c.items.some((i) => i.flag.toLowerCase().includes(needle)));
  const base = (all ?? []).filter(matches);
  const count = (f: string) => (f === 'all' ? base.length : base.filter((c) => c.status === f).length);
  const d = dir === 'asc' ? 1 : -1;
  const rows = base.filter((c) => status === 'all' || c.status === status).sort((a, b) => {
    const by = sort === 'id' ? a.id - b.id
      : sort === 'status' ? (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9)
      : sort === 'author' ? a.author.localeCompare(b.author)
      : Date.parse(a.createdAt) - Date.parse(b.createdAt);
    return by * d || b.id - a.id;
  });
  const authors = [...new Set([...(all ?? []).map((c) => c.author), ...(author ? [author] : [])])].sort();
  const neededIn = (envKey: string) => approvalsNeeded(envOf(envKey));

  const sel = useSelection(rows.map((r) => String(r.id)));
  const keys = useListKeys({
    count: rows.length,
    onOpen: (i) => setOpen(rows[i].id),
    onToggle: (i) => sel.toggle(String(rows[i].id)),
    onClear: () => { if (open === null) sel.clear(); },
    enabled: open === null,
  });
  // "/" puts the cursor in the search box (not while a request is open over the list)
  useSlashFocus(search, open === null);
  const openRow = (i: number, id: number) => { keys.setActive(i); setOpen(id); };

  const onSort = (by: Sort, dir: Dir) => setSort({ by, dir });
  const filters: Filters = { status, env, author, sort: { by: sort, dir } };
  const applyView = (f: Filters) => { setStatus(f.status); setEnv(f.env); setAuthor(f.author); setSort(f.sort); };
  const narrowed = !!(needle || env || author);
  const filtered = narrowed || status !== 'in_review';
  const reset = () => { setQ(''); setStatus('in_review'); setEnv(''); setAuthor(''); };
  const isApprover = roleInfo(meta.me.role).reviews;
  const chosen = rows.filter((r) => sel.isSelected(String(r.id)));
  // what this person may approve (policy.ts): open, someone else's, and not already approved by them
  const toApprove = chosen.filter((c) => mayApprove(meta.me, c));

  // ---- bulk actions: one call per request, four at a time; Retry re-runs only the ones that failed
  const runApprove = async (list: CsSummary[], comment: string, skipped: number) => {
    setProgress({ done: 0, total: list.length });
    const results = await settleAll(list, 4, (c) => api('POST', `/change-sets/${c.id}/review`, { decision: 'approve', comment })
      .finally(() => setProgress((p) => p && { ...p, done: p.done + 1 })));
    const approved = list.filter((_, i) => results[i].status === 'fulfilled');
    const failed = list.flatMap((cs, i) => { const r = results[i]; return r.status === 'rejected' ? [{ cs, message: (r.reason as Error).message }] : []; });
    setProgress(null); sel.clear(); load();
    reload().catch((e: Error) => toast(`The approvals went through, but the console couldn’t refresh: ${e.message}`, 'err'));
    // what, how many and where; a failure names each request and why (no strip under the bar), and Retry re-runs just those
    const one = approved.length === 1 ? approved[0] : null;
    const why = failed.length === 1 ? `Request #${failed[0].cs.id} not approved: ${failed[0].message}`
      : `${plural(failed.length, 'request')} not approved: ${failed.slice(0, 3).map((f) => `#${f.cs.id} ${f.message}`).join('; ')}${failed.length > 3 ? `; ${failed.length - 3} more` : ''}`;
    const msg = [approved.length && (one ? `Approved request #${one.id} for ${flagsOf(one.items)}${inEnvs(approved, envName)}` : `Approved ${plural(approved.length, 'request')}${inEnvs(approved, envName)}`),
      skipped && `${skipped} skipped`, failed.length && why].filter(Boolean).join(' · ');
    if (failed.length) toast(msg, 'err', { label: 'Retry', onClick: () => { runApprove(failed.map((f) => f.cs), comment, 0); } });
    else toast(msg, 'ok', { label: 'View', onClick: () => { setStatus('approved'); setQ(''); } });
  };
  const approveSelected = async () => {
    const list = toApprove;
    const skipped = chosen.length - list.length;
    const r = await ask({
      title: `Approve ${plural(list.length, 'request')}?`,
      body: <p>
        <span className="font-mono">{list.map((c) => `#${c.id}`).join(', ')}</span>
        {skipped > 0 && <> · {plural(skipped, 'other')} skipped: {skipped === 1 ? 'it is' : 'they are'} yours, already approved by you, or no longer open.</>}
      </p>,
      reason: { label: 'Comment (optional)', placeholder: 'The authors see it' },
      actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'go', label: `Approve ${list.length}`, tone: 'primary' }],
    });
    if (r.action === 'go') await runApprove(list, r.reason, skipped);
  };
  const exportCsv = () => {
    const list = chosen.length ? chosen : rows;
    const file = `approvals-${status}.csv`;
    downloadCsv(file, ['id', 'status', 'environment', 'approvals', 'requested_by', 'created_at', 'changes', 'reason'],
      list.map((c) => [c.id, c.status, c.environment, `${approvalsOf(c)}/${neededIn(c.environment)}`, c.author, c.createdAt, c.items.map(changeTag).join(' '), c.reason]));
    toast(`Exported ${plural(list.length, 'request')} to ${file}`);
  };

  // an empty list says why, and offers one way on
  const empty = !all ? null
    : loadError && all.length === 0 ? { why: 'The requests couldn’t be loaded.', action: <Button variant="secondary" onClick={() => { load(); }}>Try again</Button> }
    : all.length === 0 ? { why: 'No requests yet. Changes to a protected environment come here for an approval before they go out.', action: <Button variant="secondary" onClick={() => go('flags')}>Open flags</Button> }
    : narrowed ? { why: needle ? `No ${status === 'all' ? '' : `${STATUS_LABEL[status].toLowerCase()} `}requests match “${q.trim()}”${env || author ? ' with these filters' : ''}.` : 'No requests match these filters.', action: <Button variant="secondary" onClick={reset}>Clear filters</Button> }
    : { why: status === 'in_review' && isApprover ? 'Nothing is waiting for you: every request has been decided.' : NONE_LABEL[status] ?? 'No requests.', action: <Button variant="secondary" onClick={() => setStatus('all')}>Show all {plural(all.length, 'request')}</Button> };

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <PageBar title="Approvals" count={<CountSlot text={all ? (rows.length === all.length ? all.length.toLocaleString() : `${rows.length.toLocaleString()} of ${all.length.toLocaleString()}`) : undefined} />}>
        <SearchField ref={search} className="w-[240px] max-md:w-auto max-md:flex-1" placeholder="Search  /" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search requests by flag, author or reason" />
        <FilterSelect label="Status" value={status} onChange={setStatus}
          options={STATUSES.map((f) => [f, all ? `${STATUS_LABEL[f]} · ${count(f).toLocaleString()}` : STATUS_LABEL[f]] as [string, string])} />
        <FilterSelect label="Environment" value={env} onChange={setEnv} options={[['', 'All'], ...meta.environments.map((e) => [e.key, envName(e.key)] as [string, string])]} />
        <FilterSelect label="Requested by" value={author} onChange={setAuthor} options={[['', 'All'], ...authors.map((a) => [a, a] as [string, string])]} />
        <ViewMenu views={views} current={filters} onApply={applyView} onChange={setViews} />
        {filtered && <button type="button" onClick={reset} className={barTextButton}>Reset</button>}
      </PageBar>

      <div role="table" aria-label="Requests" aria-busy={loading} className={cn('flex-1', loading && all && 'opacity-70')}>
        <div role="row" className={cn(COLS, tableHeadClass)}>
          <RowCheck head checked={sel.all} indeterminate={sel.some} onChange={sel.toggleAll} label="Select all shown" />
          <SortHeader label="Request" sortKey="id" sort={sort} dir={dir} onSort={onSort} />
          <SortHeader label="Status" sortKey="status" sort={sort} dir={dir} onSort={onSort} help={HELP.status} />
          <ColumnHead className={MD} label="Approvals" help={HELP.approvals} />
          <span role="columnheader" className={MD}>Changes</span>
          <span role="columnheader" className={XL}>Environment</span>
          <SortHeader className={MD} label="Requested by" sortKey="author" sort={sort} dir={dir} onSort={onSort} />
          <span role="columnheader" className={XL}>Why</span>
          <SortHeader className={MD} label="When" sortKey="when" sort={sort} dir={dir} onSort={onSort} />
        </div>
        {!all ? <SkeletonRows cols={COLS} cells={CELLS} />
          : empty && rows.length === 0 ? (
            <div className="px-6 py-10 max-sm:px-4">
              <Empty action={empty.action}>{empty.why}</Empty>
            </div>
          ) : rows.map((cs, i) => {
            const shown = cs.items.slice(0, 2);
            const tags = <>
              {shown.map((it, k) => <span key={k} className={tag}>{it.flag}{isDelivery(it) ? <span className="text-ink-3"> · services</span> : it.entity && <span className="text-ink-3">/{it.entity}</span>}</span>)}
              {cs.items.length > shown.length && <span className="shrink-0 font-mono text-11 text-ink-3">+{(cs.items.length - shown.length).toLocaleString()}</span>}
            </>;
            const protectedEnv = isProtected(cs.environment);
            const progress = (long?: boolean) => (
              <ApprovalProgress status={cs.status} approvals={approvalsOf(cs)} needed={neededIn(cs.environment)} long={long}
                rejectedBy={cs.reviews?.find((r) => r.decision === 'reject')?.reviewer} revision={cs.appliedRevision} />
            );
            return (
              // a click anywhere on the row opens it; the request number is the button keyboard and screen-reader users open it with
              <div key={cs.id} role="row" data-row-index={i} data-active={keys.active === i} data-selected={sel.isSelected(String(cs.id))}
                onClick={() => openRow(i, cs.id)} className={cn(COLS, tableRowClass, selectedRow, 'cursor-default')}>
                <RowCheck checked={sel.isSelected(String(cs.id))} onChange={() => sel.toggle(String(cs.id))} label={`Select request #${cs.id}`} />
                <span role="cell" className="min-w-0">
                  <button type="button" aria-label={`Open request #${cs.id}`} onClick={(e) => { e.stopPropagation(); openRow(i, cs.id); }}
                    className={cn(cellButton, 'font-mono text-13 font-medium')}>#{cs.id}</button>
                  <span className={cn(when, 'block truncate xl:hidden')}>{envName(cs.environment)}<span className="md:hidden"> · {cs.author} · <When iso={cs.createdAt} /></span></span>
                  <span className="mt-1 flex min-w-0 items-center gap-1 overflow-hidden md:hidden">{tags}</span>
                </span>
                <span role="cell" className="max-md:flex max-md:flex-col max-md:items-end max-md:gap-1.5">
                  <StatusBadge status={cs.status} />
                  {!FINAL.includes(cs.status) && <span className="md:hidden">{progress()}</span>}
                </span>
                <span role="cell" className={cn(MD, 'min-w-0')}>{progress()}</span>
                <span role="cell" className={cn(MD, 'flex min-w-0 items-center gap-1 overflow-hidden')}>{tags}</span>
                <span role="cell" className={cn(XL, 'flex items-center gap-1.5 text-ink-2')}>
                  {envName(cs.environment)}{protectedEnv && <LockSimpleIcon aria-label="Protected" className="size-3.5 text-ink-3" />}
                </span>
                <span role="cell" className={cn(MD, 'truncate font-medium')}>{cs.author}</span>
                <span role="cell" className={cn(XL, 'truncate text-ink-2')}>{firstLine(cs.reason) ?? <span className="text-ink-3">No reason given</span>}</span>
                <span role="cell" className={MD}><When iso={cs.createdAt} className={when} /></span>
              </div>
            );
          })}
      </div>

      <div className="flex min-h-11 flex-wrap items-center gap-4 border-t border-rule px-6 py-2.5 max-sm:px-4">
        <KeyHints className="max-md:hidden" />
        <span className="flex-1" />
        {all && all.length >= 200 && <span className={when}>The latest 200 requests</span>}
      </div>

      <BulkBar count={sel.count} onClear={sel.clear}>
        {progress ? <span role="status" className="text-13 text-ink-2">Approving {progress.done} of {progress.total}…</span> : <>
          {isApprover && (toApprove.length > 0
            ? <Button variant="outline" onClick={approveSelected}>{toApprove.length === chosen.length ? 'Approve' : `Approve ${toApprove.length} of ${chosen.length}`}</Button>
            : <span className="text-13 text-ink-3">None of these are yours to approve</span>)}
          <Button variant="outline" onClick={exportCsv}>Export CSV</Button>
        </>}
      </BulkBar>

      <RequestDrawer id={open} onClose={() => setOpen(null)} onChanged={load} />
    </div>
  );
}

/* ---------------------------------------------------------------- one request: data, rights, actions */

/**
 * One request: its data, who may do what, and the actions. The drawer and the page share it. Everything it keeps is
 * tagged with the request it's about and shows only while that's the request asked for, so another request never
 * shows the last one's details, error or "what happens next". `active`: false while the drawer is closed (no refetch).
 */
function useRequest(id: number | null, onChanged?: () => void, active = true) {
  const { user, meta, toast, ask, reload, revisionTick } = useApp();
  const { envName, isProtected } = useEnvs();
  const [loaded, setLoaded] = useState<CsDetail | null>(null);
  const [failedLoad, setFailedLoad] = useState<{ id: number; message: string } | null>(null);
  const [note, setNote] = useState<{ id: number | null; outcome: string | null; failure: string | null }>({ id: null, outcome: null, failure: null });
  const [busyId, setBusyId] = useState<number | null>(null);
  const cs = loaded?.id === id ? loaded : null;
  const missing = failedLoad?.id === id ? failedLoad.message : null;
  const outcome = note.id === id ? note.outcome : null;
  const failure = note.id === id ? note.failure : null;
  const busy = busyId !== null && busyId === id;
  // the request asked for now, for answers that arrive later (written after each commit, read only in callbacks)
  const current = useRef(id);
  useLayoutEffect(() => { current.current = id; }, [id]);
  const load = useCallback((): Promise<CsDetail | null> => {
    if (id === null) return Promise.resolve(null);
    return api<CsDetail>('GET', `/change-sets/${id}`).then(
      (r) => { if (current.current === id) { setLoaded(r); setFailedLoad(null); } return r; },
      (e: Error) => { if (current.current === id) setFailedLoad({ id, message: e.message }); return null; });
  }, [id]);
  useEffect(() => { if (active) load(); }, [load, revisionTick, active]);
  /** "Try again" after a failed load: back to the placeholder while it loads. */
  const retry = () => { setFailedLoad(null); load(); };

  const isAuthor = !!cs && cs.author === user;
  // who may review and approve: policy.ts, the same answer the server gives
  const canReview = !!cs && mayReview(meta.me, cs);
  const canApprove = !!cs && mayApprove(meta.me, cs);
  const canApply = cs?.status === 'approved';
  // scheduling it for later: its author, or someone who reviews (policy.ts, the same answer the server gives)
  const canSchedule = !!cs && maySchedule(meta.me, cs);
  const canWithdraw = isAuthor && !!cs && WITHDRAWABLE.includes(cs.status);
  const needed = approvalsNeeded(cs);
  const env = cs ? envName(cs.environment).toLowerCase() : '';
  const protectedEnv = !!cs && isProtected(cs.environment);
  /** "new_checkout" or "4 flags", for toasts. */
  const what = cs ? flagsOf(cs.items) : '';
  /** A person's name for a sentence: "Alice", not "Alice (editor)". */
  const nameOf = (k: string) => meta.users.find((u) => u.key === k)?.name.replace(/\s*\([^)]*\)$/, '') || k;
  /** Final actions ask first and say what happens. */
  const confirm = async (title: string, body: string, label: string, tone: 'primary' | 'danger') =>
    (await ask({ title, body: <p>{body}</p>, actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'go', label, tone }] })).action === 'go';

  // run one action; on success say what happened (toast) and, on the request itself, what comes next.
  // A failure is a toast too, naming the request; while the request itself hasn't moved it offers Try again.
  const act = async (verb: string, fn: () => Promise<unknown>, said: string, next: (after: CsDetail | null) => string): Promise<boolean> => {
    const was = cs?.status;
    setNote({ id, outcome: null, failure: null }); setBusyId(id);
    let failed: string | null = null;
    try { await fn(); } catch (e) { failed = (e as Error).message; }
    const after = await load();
    setBusyId((b) => (b === id ? null : b));
    if (failed !== null) {
      const text = `Couldn’t ${verb} request #${id}: ${failed}`;
      const moved = !!after && after.status !== was;
      toast(text, 'err', moved ? undefined : { label: 'Try again', onClick: () => { if (current.current === id) act(verb, fn, said, next); } });
      setNote({ id, outcome: null, failure: text }); return false;
    }
    toast(said); setNote({ id, outcome: next(after), failure: null }); onChanged?.();
    reload().catch((e: Error) => toast(`${said}, but the console couldn’t refresh: ${e.message}`, 'err'));
    return true;
  };
  const review = async (decision: 'approve' | 'reject', comment: string) => {
    if (decision === 'reject' && !await confirm(`Reject request #${id}?`, `Nothing changes in ${env}. ${cs ? nameOf(cs.author) : 'The author'} has to send a new request.`, 'Reject', 'danger')) return false;
    return act(decision, () => api('POST', `/change-sets/${id}/review`, { decision, comment }),
      `${decision === 'approve' ? 'Approved' : 'Rejected'} request #${id} for ${what} in ${env}`,
      (after) => {
        if (decision === 'reject') return `Rejected. Nothing changes in ${env}; ${cs?.author} can submit a new request.`;
        if (after?.status === 'approved') return 'Approved. Apply it now or schedule it.';
        const left = after ? Math.max(1, approvalsLeft(after, after)) : 1;
        return `Approved. It needs ${plural(left, 'more approval')} before it can go out.`;
      });
  };
  const apply = async () => {
    if (protectedEnv && !await confirm(`Apply request #${id} to ${env} now?`, `The changes go live for every app in ${env}.`, 'Apply now', 'primary')) return false;
    return act('apply', () => api('POST', `/change-sets/${id}/apply`), `Applied request #${id} for ${what} to ${env}`,
      () => `Applied. It is live in ${env} now; nothing else to do.`);
  };
  const schedule = (at: string) => act('schedule', () => api('POST', `/change-sets/${id}/schedule`, { at: new Date(at).toISOString() }),
    `Scheduled request #${id} for ${what} to go out in ${env} at ${new Date(at).toLocaleString()}`,
    () => 'Scheduled. It goes out on its own at that time; nothing else to do.');
  const withdraw = async () => {
    const body = `Nothing changes in ${env}${cs?.status === 'scheduled' ? ' and it won’t go out as scheduled' : ''}. To make this change later, send a new request.`;
    if (!await confirm(`Withdraw request #${id}?`, body, 'Withdraw', 'danger')) return false;
    return act('withdraw', () => api('POST', `/change-sets/${id}/cancel`), `Withdrew request #${id} for ${what} in ${env}`,
      () => `Withdrawn. Nothing changes in ${env}.`);
  };

  return { cs, missing, retry, busy, outcome, failure, isAuthor, canReview, canApprove, canApply, canSchedule, canWithdraw, approvals: cs ? approvalsOf(cs) : 0, needed, review, apply, schedule, withdraw };
}

/* ---------------------------------------------------------------- one request: pieces */

function useEntityName() {
  const { meta } = useApp();
  return (k: string) => entityLabel(meta.entities, k);
}

/** "#34 · new_search · Defaults", "#35 · new_search · 3 changes", "#36 · 4 flags · 12 changes". */
function RequestTitle({ cs }: { cs: CsDetail }) {
  const entityName = useEntityName();
  const flags = [...new Set(cs.items.map((i) => i.flag))];
  const one = cs.items.length === 1 ? cs.items[0] : null;
  return (
    <>
      <span className="font-mono">#{cs.id}</span>
      <span className="text-ink-3"> · </span>
      {flags.length === 1 ? <span className="font-mono">{flags[0]}</span> : plural(flags.length, 'flag')}
      <span className="text-ink-3"> · {one ? (isDelivery(one) ? 'Services' : one.entity ? entityName(one.entity) : 'Defaults') : plural(cs.items.length, 'change')}</span>
    </>
  );
}

/** Environment, author, time and approvals (and the reason), as label / value rows. Release state is in the notes. */
function RequestFacts({ cs, approvals, needed, withReason }: { cs: CsDetail; approvals: number; needed: number; withReason?: boolean }) {
  const { envName, isProtected } = useEnvs();
  const protectedEnv = isProtected(cs.environment);
  return (
    <>
      <DrawerRow label="Environment">
        <span className="inline-flex items-center gap-1.5">{envName(cs.environment)}{protectedEnv && <LockSimpleIcon aria-label="Protected environment" className="size-3.5 text-ink-3" />}</span>
      </DrawerRow>
      <DrawerRow label="Requested by"><span className="font-medium">{cs.author}</span> <span className="text-ink-3">·</span> <When iso={cs.createdAt} className="text-ink-2" /></DrawerRow>
      <DrawerRow label="Approvals">
        <span className="inline-flex items-center gap-1.5">
          <ApprovalProgress status={cs.status} approvals={approvals} needed={needed} long revision={cs.appliedRevision}
            rejectedBy={cs.reviews.find((r) => r.decision === 'reject' && r.current)?.reviewer} />
          {!FINAL.includes(cs.status) && <HelpTip>{HELP.approvals}</HelpTip>}
        </span>
      </DrawerRow>
      {withReason && <DrawerRow label="Why">{cs.reason ? <span className="whitespace-pre-line">{cs.reason}</span> : <span className="text-ink-3">No reason given</span>}</DrawerRow>}
    </>
  );
}

/** What the request's state means: conflict, a failed apply, applied, scheduled. */
function requestNotes(cs: CsDetail, envName: (e: string) => string): { key: string; tone: 'error' | 'note'; node: ReactNode }[] {
  const notes: { key: string; tone: 'error' | 'note'; node: ReactNode }[] = [];
  const env = envName(cs.environment).toLowerCase();
  if (cs.status === 'conflict') notes.push({ key: 'conflict', tone: 'error', node: <>
    The flag changed after this request was made, so the approval no longer matches what would happen.{' '}
    <a href={`#/flag/${cs.items[0]?.flag}/${cs.environment}`} className="text-live underline decoration-live/40 underline-offset-4 hover:decoration-live">Open the flag</a> and submit a fresh change.
  </> });
  if (cs.lastError) notes.push({ key: 'error', tone: 'error', node: cs.lastError });
  if (cs.appliedRevision) notes.push({ key: 'applied', tone: 'note', node: <>Applied as {env} revision <span className="font-mono text-ink">r{cs.appliedRevision}</span>.</> });
  if (cs.scheduledAt && cs.status === 'scheduled') notes.push({ key: 'scheduled', tone: 'note', node: <>Scheduled to go out in {env} at <span className="font-mono text-ink">{new Date(cs.scheduledAt).toLocaleString()}</span>.</> });
  return notes;
}

/** Every change in the request: which layer, the version it expects, and the diff. Big requests stay folded. */
function ChangeList({ cs, rowClass }: { cs: CsDetail; rowClass: string }) {
  const entityName = useEntityName();
  const change = (it: CsItem) => {
    const delivery = isDelivery(it);
    const what = delivery ? 'Services' : it.entity ? entityName(it.entity) : 'Defaults';
    return (
      <section key={it.seq} aria-label={`${it.flag}, ${it.entity && !delivery ? what : what.toLowerCase()}`} className={cn('border-b border-grid last:border-b-0', rowClass)}>
        <div className="mb-2 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <a href={`#/flag/${it.flag}/${cs.environment}`} className={cn(titleLink, 'font-mono text-13 font-medium')}>{it.flag}</a>
          <span className="text-13 text-ink-2">{what}</span>
          {!delivery && (
            <span className={cn(when, 'ml-auto inline-flex items-center gap-1')}>
              {it.expectedLayerVersion != null ? `expects v${it.expectedLayerVersion}` : 'new'}
              {it.entity && <> · base v{it.expectedBaseVersion ?? '—'}</>}
              {it.expectedLayerVersion != null && <HelpTip>{HELP.expects}</HelpTip>}
            </span>
          )}
        </div>
        {delivery
          ? <DeliveryDiff flag={it.flag} before={it.before as Delivery | null} after={it.proposed as Delivery | null} />
          : <LayerDiff before={it.before as Layer | null} after={it.proposed as Layer | null} entity={it.entity} />}
      </section>
    );
  };
  if (cs.items.length <= 8) return <>{cs.items.map(change)}</>;
  return (
    <div className={rowClass}>
      <Collapsible title={`Show all ${plural(cs.items.length, 'change')}`}>
        <div className="border-t border-grid">{cs.items.slice(0, 200).map(change)}</div>
        {cs.items.length > 200 && <p className="m-0 mt-3 text-13 text-ink-3">…and {(cs.items.length - 200).toLocaleString()} more</p>}
      </Collapsible>
    </div>
  );
}

/** Who approved or rejected, and what still has to happen. */
function ReviewList({ cs, needed, rowClass }: { cs: CsDetail; needed: number; rowClass: string }) {
  const { user } = useApp();
  return (
    <>
      {cs.reviews.length === 0 ? <p className={cn('m-0 border-b border-grid text-13 text-ink-3', rowClass)}>No reviews yet.</p> : (
        <ul className="m-0 list-none p-0">
          {cs.reviews.map((r) => (
            <li key={r.reviewer} className={cn('border-b border-grid', rowClass, !r.current && 'opacity-50')}>
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-13">
                <UIBadge variant={r.decision === 'approve' ? 'ok' : 'live'}>{r.decision === 'approve' ? 'approved' : 'rejected'}</UIBadge>
                <span className="font-medium">{r.reviewer}</span>
                {!r.current && <span className="text-ink-3">for older content</span>}
                <When iso={r.createdAt} className={cn(when, 'ml-auto')} />
              </div>
              {r.comment && <p className="m-0 mt-1 text-13 whitespace-pre-line text-ink-1 [overflow-wrap:anywhere]">{r.comment}</p>}
            </li>
          ))}
        </ul>
      )}
      {openForReview(cs.status) && (
        <p className={cn('m-0 text-13 text-ink-3', rowClass)}>
          {cs.status === 'approved' ? 'Approved; anyone can apply it, and its author or a reviewer can schedule it.' : `Needs ${needed === 1 ? 'an approval' : `${needed} approvals`} from someone other than ${cs.author === user ? 'you' : cs.author}.`}
        </p>
      )}
    </>
  );
}

/** What just happened and what comes next, after an action. */
function Outcome({ text, className }: { text: string | null; className?: string }) {
  if (!text) return null;
  return <p role="status" className={cn('m-0 flex items-start gap-2 text-13 text-ink', className)}><CheckIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-ok" />{text}</p>;
}

/** Lines of text still loading, in a request's drawer or page: label and value rows as bones. */
function DetailBones({ lines = 4, rowClass = 'h-9' }: { lines?: number; rowClass?: string }) {
  return (
    <div aria-hidden className="grid">
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className={cn('flex items-center gap-4', rowClass)}><Bone className="w-20" /><Bone className={i % 2 ? 'w-1/3' : 'w-1/2'} /></span>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- one request, over the queue */

function RequestDrawer({ id, onClose, onChanged }: { id: number | null; onClose: () => void; onChanged: () => void }) {
  const { envName } = useEnvs();
  // keep showing the last request while the drawer slides away; a closed drawer doesn't refetch it
  const shown = useLast(id);
  const r = useRequest(shown, onChanged, id !== null);
  const { cs } = r;
  // a typed comment belongs to the request it was typed on
  const [typed, setTyped] = useState<{ id: number | null; text: string }>({ id: null, text: '' });
  const comment = typed.id === shown ? typed.text : '';
  const setComment = (text: string) => setTyped({ id: shown, text });
  const review = async (decision: 'approve' | 'reject') => { if (await r.review(decision, comment)) setComment(''); };
  const primary = r.canApply || r.canApprove;

  return (
    <Drawer open={id !== null} onClose={onClose} width={600}
      title={cs ? <RequestTitle cs={cs} /> : <span className="font-mono">#{shown}</span>}
      actions={cs ? <StatusBadge status={cs.status} /> : undefined}
      footer={cs && <>
        {r.outcome && <Outcome text={r.outcome} className="basis-full" />}
        {/* the drawer covers the toast's corner, so a failure is also said here */}
        {r.failure && <p role="alert" className="m-0 basis-full border-l border-live bg-live/5 px-3 py-2 text-13 text-live [overflow-wrap:anywhere]">{r.failure}</p>}
        {r.canReview && <Input className="h-8 basis-full text-13" placeholder="Comment (optional); the author sees it" aria-label="Review comment" value={comment} onChange={(e) => setComment(e.target.value)} />}
        <Button variant={primary || r.canReview || r.canWithdraw ? 'secondary' : 'default'} className={primary || r.canReview || r.canWithdraw ? rowBtn : undefined}
          onClick={() => { onClose(); go(`approvals/${cs.id}`); }}>Open request <ArrowSquareOutIcon aria-hidden className="size-3.5" /></Button>
        {r.canWithdraw && <Button variant="secondary" className={cn(rowBtn, 'text-live hover:text-live')} disabled={r.busy} onClick={r.withdraw}>Withdraw</Button>}
        {(r.canReview || r.canApply) && (
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {r.canReview && <Button variant="stop" disabled={r.busy} onClick={() => review('reject')}>Reject</Button>}
            {r.canApprove && <Button variant={r.canApply ? 'outline' : 'default'} className={r.canApply ? rowBtn : undefined} disabled={r.busy} onClick={() => review('approve')}>Approve</Button>}
            {r.canApply && <Button disabled={r.busy} onClick={r.apply}>Apply now</Button>}
          </div>
        )}
      </>}>
      {r.missing ? (
        <div className="grid justify-items-start gap-3">
          <Callout tone="error" role="alert">Request #{shown} couldn’t be opened: {r.missing}.</Callout>
          <Button variant="secondary" onClick={r.retry}>Try again</Button>
        </div>
      ) : !cs ? <>
          <DrawerSection title="Request"><DetailBones /></DrawerSection>
          <DrawerSection title="Changes"><DetailBones lines={2} /></DrawerSection>
        </> : <>
          {requestNotes(cs, envName).map((n) => <Callout key={n.key} tone={n.tone} className="mb-2 [overflow-wrap:anywhere]">{n.node}</Callout>)}
          <DrawerSection title="Request" className={requestNotes(cs, envName).length ? 'mt-4' : undefined}>
            <RequestFacts cs={cs} approvals={r.approvals} needed={r.needed} withReason />
          </DrawerSection>
          <DrawerSection title={`Changes · ${cs.items.length.toLocaleString()}`}>
            <ChangeList cs={cs} rowClass="py-3" />
          </DrawerSection>
          <DrawerSection title={`Reviews · ${Math.min(r.approvals, r.needed)} of ${r.needed}`}>
            <ReviewList cs={cs} needed={r.needed} rowClass="py-2.5" />
          </DrawerSection>
        </>}
    </Drawer>
  );
}

/* ---------------------------------------------------------------- one request, on its own page */

function Section({ title, count, children }: { title: string; count?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="border-b border-rule">
      <h2 className={sectionHead}>{title}{count !== undefined && <span className="text-ink-2">{count}</span>}</h2>
      {children}
    </section>
  );
}

function RequestPage({ id }: { id: number }) {
  const { envName } = useEnvs();
  const r = useRequest(id);
  const { cs } = r;
  const [comment, setComment] = useState('');
  const [at, setAt] = useState(() => new Date(Date.now() + 5 * 60000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16));
  const review = async (decision: 'approve' | 'reject') => { if (await r.review(decision, comment)) setComment(''); };
  const crumbs = <a href="#/approvals" className="text-ink-3 no-underline hover:text-ink hover:no-underline">Approvals</a>;
  const pad = 'px-6 max-sm:px-4';

  if (r.missing) return (
    <div className="flex min-h-full flex-1 flex-col">
      <PageBar crumbs={crumbs} title={<span className="font-mono">#{id}</span>} />
      <div className={cn('grid justify-items-start gap-3 py-6', pad)}>
        <Callout tone="error" role="alert">Request #{id} couldn’t be opened: {r.missing}.</Callout>
        <div className="flex flex-wrap items-center gap-4">
          <Button variant="secondary" onClick={r.retry}>Try again</Button>
          <a href="#/approvals" className={cn(titleLink, 'text-13')}>Back to all requests</a>
        </div>
      </div>
    </div>
  );
  // the page's shape while the request loads: its bar, its sections and its details, with bones for what they hold
  if (!cs) return (
    <div aria-busy className="flex min-h-full flex-1 flex-col">
      <PageBar crumbs={crumbs} title={<span className="font-mono">#{id}</span>} count={<Bone className="h-5 w-20" />} />
      <div className="grid flex-1 grid-cols-[minmax(0,1fr)_320px] max-lg:grid-cols-1">
        <div className="min-w-0 max-lg:order-2">
          {/* as tall as a request with one change and one review: the reason's line, the change, the review rows */}
          <Section title="Why"><p className={cn('m-0 flex h-11 items-center', pad)}><Bone className="w-1/2" /></p></Section>
          <Section title="Changes"><div className={cn('grid h-[77px] content-center gap-3', pad)}><Bone className="w-1/3" /><Bone className="w-1/2" /></div></Section>
          <Section title="Reviews"><DetailBones lines={2} rowClass={cn('h-10', pad)} /></Section>
        </div>
        <aside aria-label="Details" className="border-l border-rule max-lg:order-1 max-lg:border-b max-lg:border-l-0">
          <h2 className={sectionHead}>Details</h2>
          <div className={pad}><DetailBones rowClass="h-[39.5px]" /></div>
        </aside>
      </div>
    </div>
  );

  // the next step goes in the bar: apply an approved request, approve a waiting one, or withdraw your own
  const next = r.canApply ? <Button disabled={r.busy} onClick={r.apply}>Apply now</Button>
    : r.canApprove ? <Button disabled={r.busy} onClick={() => review('approve')}>Approve</Button>
    : r.canWithdraw ? <Button variant="stop" disabled={r.busy} onClick={r.withdraw}>Withdraw</Button> : null;
  const notes = requestNotes(cs, envName);
  // one strip under the bar, most important first: a failed action, then what just happened, then the request's
  // own state. The other notes sit in Details.
  const lead = r.failure || r.outcome ? null : notes[0] ?? null;
  const rest = notes.filter((n) => n !== lead);

  return (
    <article aria-label={`Request #${cs.id}`} className="flex min-h-full flex-1 flex-col">
      <PageBar crumbs={crumbs} title={<RequestTitle cs={cs} />} count={<StatusBadge status={cs.status} />}
        actions={(next || r.canWithdraw) && <>
          {r.canWithdraw && (r.canApply || r.canApprove) && <Button variant="secondary" className="text-live hover:text-live" disabled={r.busy} onClick={r.withdraw}>Withdraw</Button>}
          {next}
        </>} />

      {r.failure ? <p role="alert" className={cn(strip, 'm-0 bg-live/5 text-live')}>{r.failure}</p>
        : r.outcome ? <Outcome text={r.outcome} className={cn(strip, 'bg-ok/5')} />
        : lead && <div className={cn(strip, lead.tone === 'error' ? 'bg-live/5 text-live' : 'text-ink-2')}><span className="min-w-0">{lead.node}</span></div>}

      <div className="grid flex-1 grid-cols-[minmax(0,1fr)_320px] max-lg:grid-cols-1">
        <div className="min-w-0 max-lg:order-2">
          <Section title="Why">
            <p className={cn('m-0 py-3 text-13 whitespace-pre-line [overflow-wrap:anywhere]', pad, !cs.reason && 'text-ink-3')}>{cs.reason ?? 'No reason given.'}</p>
          </Section>
          <Section title="Changes" count={cs.items.length.toLocaleString()}>
            <ChangeList cs={cs} rowClass={cn('py-3', pad)} />
          </Section>
          <Section title="Reviews" count={`${Math.min(r.approvals, r.needed)} of ${r.needed}`}>
            <ReviewList cs={cs} needed={r.needed} rowClass={cn('py-2.5', pad)} />
          </Section>
          {r.canReview && (
            <Section title="Your review">
              <div className={cn('flex flex-wrap items-center gap-2 py-3', pad)}>
                <Input className="h-8 min-w-0 flex-1 basis-60 text-13" placeholder="Comment (optional); the author sees it" aria-label="Review comment" value={comment} onChange={(e) => setComment(e.target.value)} />
                <Button variant="stop" disabled={r.busy} onClick={() => review('reject')}>Reject</Button>
                {r.canApprove && <Button disabled={r.busy} onClick={() => review('approve')}>Approve</Button>}
              </div>
            </Section>
          )}
          {cs.status === 'approved' && (
            <Section title="Release">
              <div className={cn('flex flex-wrap items-center gap-2 py-3', pad)}>
                <Button disabled={r.busy} onClick={r.apply}>Apply now</Button>
                {r.canSchedule && <>
                  <span className="text-13 text-ink-3">or at</span>
                  <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} aria-label="Schedule time" className={cn(denseField, 'py-0 font-mono')} />
                  <Button variant="secondary" className={rowBtn} disabled={r.busy} onClick={() => r.schedule(at)}>Schedule</Button>
                </>}
              </div>
            </Section>
          )}
        </div>
        <aside aria-label="Details" className="border-l border-rule max-lg:order-1 max-lg:border-b max-lg:border-l-0">
          <div className="lg:sticky lg:top-[calc(var(--page-bar-h,3.5rem)+1rem)]">
            <h2 className={sectionHead}>Details</h2>
            <div className={pad}>
              <RequestFacts cs={cs} approvals={r.approvals} needed={r.needed} />
              {rest.map((n) => <p key={n.key} className={cn('m-0 border-b border-grid py-2.5 text-13 last:border-b-0 [overflow-wrap:anywhere]', n.tone === 'error' ? 'text-live' : 'text-ink-2')}>{n.node}</p>)}
            </div>
          </div>
        </aside>
      </div>
    </article>
  );
}

/* ---------------------------------------------------------------- diff of one layer */

function ruleSig(r: Rule) { return JSON.stringify({ ...r, ruleKey: undefined }); }

type Kind = 'add' | 'del' | 'mod' | 'same';
const SIGN: Record<Kind, { mark: string; tone: string; said: string }> = {
  add: { mark: '+', tone: 'text-ok', said: 'Added' },
  del: { mark: '−', tone: 'text-live', said: 'Removed' },
  mod: { mark: '~', tone: 'text-ink-2', said: 'Changed' },
  same: { mark: '', tone: '', said: 'Unchanged' },
};

function DiffLines({ lines, children }: { lines: { kind: Kind; node: ReactNode }[]; children?: ReactNode }) {
  return (
    <ul className="m-0 grid list-none gap-0.5 p-0 text-13" aria-label="What changes">
      {children}
      {lines.map((l, i) => (
        <li key={i} className={cn('grid grid-cols-[14px_minmax(0,1fr)] items-baseline gap-x-2 py-[3px]', l.kind === 'same' && 'opacity-50')}>
          <span className={cn('font-mono text-13 font-medium', SIGN[l.kind].tone)}><span aria-hidden>{SIGN[l.kind].mark}</span><span className="sr-only">{SIGN[l.kind].said}: </span></span>
          <div className="min-w-0">{l.node}</div>
        </li>
      ))}
    </ul>
  );
}

/** What a delivery change does: "new_checkout in services: android, ios", and each service added or removed. */
function DeliveryDiff({ flag, before, after }: { flag: string; before: Delivery | null; after: Delivery | null }) {
  const was = before?.projects ?? [];
  const now = after?.projects ?? [];
  const list = (apps: string[]) => (apps.length ? <span className="font-mono text-ink">{apps.join(', ')}</span> : <span className="text-ink-3">none</span>);
  const lines: { kind: Kind; node: ReactNode }[] = [
    ...now.filter((p) => !was.includes(p)).map((p) => ({ kind: 'add' as const, node: <>Put in <span className="font-mono">{p}</span></> })),
    ...was.filter((p) => !now.includes(p)).map((p) => ({ kind: 'del' as const, node: <>Taken out of <span className="font-mono">{p}</span></> })),
  ];
  return (
    <DiffLines lines={lines}>
      <li className="py-[3px] text-ink-2">
        {now.length ? <><span className="font-mono text-ink">{flag}</span> in services: {list(now)}</> : <><span className="font-mono text-ink">{flag}</span> in no service</>}
        {' '}<span className="text-ink-3">(was: </span>{list(was)}<span className="text-ink-3">)</span>
      </li>
      {lines.length === 0 && <li className="py-[3px] text-ink-3">No effective changes.</li>}
    </DiffLines>
  );
}

/** What a change does to one layer (the defaults or one entity's own settings): + added, − removed, ~ changed.
 *  `entity`: whose settings (null: the defaults), so a removal says what it gets now: what its parent gets, or
 *  everyone's at the top. */
export function LayerDiff({ before, after, entity }: { before: Layer | null; after: Layer | null; entity?: string | null }) {
  const { meta } = useApp();
  if (!after) {
    const who = entityWordsOf(meta.entities, entity);
    return <DiffLines lines={[{ kind: 'del', node: `Own settings removed. ${who ? who.name : 'It'} now ${getsWithoutOwn(who)}.` }]} />;
  }
  const lines: { kind: Kind; node: ReactNode }[] = [];
  const field = (label: string, a: unknown, b: unknown) => {
    if (a === b) return;
    lines.push({ kind: 'mod', node: <><span className="font-medium">{label}:</span> <span className="font-mono text-ink-2">{String(a ?? '—')}</span> <span className="text-ink-3">→</span> <span className="font-mono text-ink">{String(b ?? '—')}</span></> });
  };
  if (!before) lines.push({ kind: 'add', node: 'Added' });
  field('On', before?.enabled, after.enabled);
  field('Default', before?.defaultVariation, after.defaultVariation);
  if (before?.inherit !== after.inherit && after.inherit) field('Mode', before?.inherit ? CHOICE_NAME[before.inherit] : null, CHOICE_NAME[after.inherit]);
  const beforeRules = new Map((before?.rules ?? []).map((r) => [r.ruleKey, r]));
  const afterKeys = new Set(after.rules.map((r) => r.ruleKey));
  after.rules.forEach((r, i) => {
    const old = beforeRules.get(r.ruleKey);
    const kind: Kind = !old ? 'add' : ruleSig(old) !== ruleSig(r) ? 'mod' : 'same';
    lines.push({ kind, node: <><RuleSummary rule={r} index={i} />{kind === 'mod' && old && (
      <div className="mt-1 flex items-baseline gap-2 text-ink-3"><span className={monoLabel}>was</span><div className="min-w-0 opacity-70"><RuleSummary rule={old} /></div></div>
    )}</> });
  });
  for (const r of before?.rules ?? []) if (!afterKeys.has(r.ruleKey)) lines.push({ kind: 'del', node: <div className="text-ink-2"><RuleSummary rule={r} /></div> });
  const changed = lines.filter((l) => l.kind !== 'same').length;
  return (
    <DiffLines lines={lines}>
      {changed === 0 && <li className="py-[3px] text-ink-3">No effective changes.</li>}
    </DiffLines>
  );
}
