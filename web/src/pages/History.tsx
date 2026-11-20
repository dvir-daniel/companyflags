import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, buttonVariants } from '@companyflags/ui/components/button';
import { Callout } from '@companyflags/ui/components/callout';
import { BulkBar, KeyHints, RowCheck, SortHeader, tableHeadClass, tableRowClass, useListKeys, useSelection } from '@companyflags/ui/components/data-table';
import { Drawer, DrawerRow, DrawerSection } from '@companyflags/ui/components/drawer';
import { BAR_CONTROLS, barTextButton, FilterSelect, PageBar } from '@companyflags/ui/components/page-bar';
import { SearchField } from '@companyflags/ui/components/search-field';
import { cn } from '@companyflags/ui/lib/utils';
import { api, capital, entityIndex, peek, type Dimensions, type Entity, type Layer } from '../api.ts';
import { listWords } from '../dimWords.ts';
import { downloadCsv } from '../csv.ts';
import { historyQuery } from '../paths.ts';
import { Bone, CountSlot, SkeletonRows } from '../loading.tsx';
import { pagerRow } from '../loadingKit.ts';
import { go, useApp } from '../app.ts';
import { plural } from '../text.ts';
import { AgentBadge, Badge, Empty, JsonView, When } from '../ui.tsx';
import { denseField, monoLabel, usePersistentState, useSlashFocus } from '../uiKit.ts';
import { LayerDiff } from './Approvals.tsx';
import { useEnvs } from './envs.ts';

/*
 * History: the audit log as a dense console list, newest first, any age (server/history.ts). A sticky page bar
 * (search by flag, filters by environment, entity, person, kind of change and time, Export of everything they
 * match), a sortable full-width table that pages back with Load older, Export CSV for the selected rows, and a
 * drawer with one entry's comment and before/after. FlagHistory is the same table on the flag page's History tab.
 * Keyboard: / search, j/k move, x select, Enter open, Esc clear.
 */

const CHANGE_LABEL: Record<string, string> = {
  'layer.create': 'added own settings', 'layer.update': 'changed rules', 'layer.delete': 'removed own settings',
  'flag.create': 'created the flag', 'flag.update': 'changed settings', 'flag.archive': 'archived the flag', 'delivery.update': 'changed its services',
  'variations.update': 'changed variants', 'entity.create': 'added an entry', 'entity.update': 'changed an entry', 'entity.link_replaced': 'replaced an app link',
  // from before dimensions
  'customer.create': 'added an entry', 'customer.update': 'changed an entry', 'customer.link_replaced': 'replaced an app link',
  'dimensions.update': 'changed the dimensions',
  'api_key.create': 'created an API key', 'api_key.revoke': 'revoked an API key', 'change_set.create': 'requested approval',
  'change_set.approve': 'approved', 'change_set.reject': 'rejected', 'change_set.schedule': 'scheduled a request',
  'environment.create': 'added an environment', 'environment.update': 'changed an environment',
  'environment.links_replaced': 'replaced every app link in this environment', 'app.create': 'added a service',
  'app.update': 'changed a service’s kind', 'app.delete': 'deleted a service',
  'person.role': 'changed someone’s role', 'person.add': 'added someone', 'person.invite': 'made an invite link', 'person.password_reset': 'made a password reset link',
  'person.remove': 'removed someone’s access', 'sso.add': 'added single sign-on', 'sso.update': 'changed single sign-on',
  'sso.remove': 'removed single sign-on', 'cdn.update': 'set up the Cloudflare purge', 'cdn.remove': 'removed the Cloudflare purge',
  'cdn.purge': 'purged Cloudflare by hand',
  'webhook.create': 'added a webhook out', 'webhook.update': 'changed a webhook out', 'webhook.delete': 'deleted a webhook out',
  'webhook.secret': 'made a webhook’s new secret', 'webhook_in.create': 'added a webhook in', 'webhook_in.update': 'changed a webhook in',
  'webhook_in.delete': 'deleted a webhook in', 'webhook_in.token': 'made a webhook’s new address',
  'token.create': 'made an access token', 'token.revoke': 'revoked an access token',
};
const changeName = (t: string) => { const s = CHANGE_LABEL[t] ?? t; return `${s[0].toUpperCase()}${s.slice(1)}`; };

type Row = { id: number; environment: string | null; revision: number | null; changedAt: string; changedBy: string; actorType: string; changeType: string; flag: string | null; entity: string | null; before: any; after: any; comment: string | null; changeSetId: number | null };
type Rows = Row[] | Error | null;
type Sort = 'when' | 'who';
type Order = { by: Sort; dir: 'asc' | 'desc' };

/** Changes per page: the server's own page (server/history.ts HISTORY_PAGE). A full page means there may be more. */
const PAGE = 200;
const options = (values: string[], current: string, name: (v: string) => string = (v) => v): [string, string][] =>
  [['', 'All'], ...[...new Set([...values, ...(current ? [current] : [])])].map((v) => [v, name(v)] as [string, string]).sort((a, b) => a[1].localeCompare(b[1]))];
/** What a change is about, for the Change filter: the server matches every kind of change about it. Entries are the
 *  dimensions' entities, named by the installation's words ("Companies and brands"); their changes from before
 *  dimensions were `customer.*`. */
const subjects = (dims: Dimensions): [string, string][] => [
  ['layer', 'Rules and defaults'], ['flag', 'Flag details'], ['variations', 'Variants'], ['delivery', 'Services of a flag'],
  ['entity,customer', capital(listWords(dims, 'and', true)) || 'Entries'], ['dimensions', 'Dimensions'], ['change_set', 'Requests and reviews'],
  ['environment', 'Environments'], ['app', 'Services'], ['api_key', 'API keys'], ['person', 'People'], ['sso', 'Single sign-on'], ['cdn', 'CDN'], ['webhook,webhook_in', 'Webhooks'],
];
const WHEN: [string, string][] = [['', 'Any time'], ['today', 'Today'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'],
  ['365', 'Last 12 months'], ['custom', 'Between dates']];

type Pages = { rows: Rows; loading: boolean; more: boolean; older: 'idle' | 'loading' | Error; loadOlder: () => void; retry: () => void };

/** History for one request (`/history?…`), a page at a time: the newest page first (the kept answer at once, then a
 *  fresh one), then older pages on Load older. A new version puts its changes on top and keeps the older pages. */
function useHistoryPages(path: string, tick: number): Pages {
  const [rows, setRows] = useState<Rows>(() => peek<Row[]>(path) ?? null);
  const [loading, setLoading] = useState(() => !peek(path));
  const [more, setMore] = useState(() => (peek<Row[]>(path)?.length ?? 0) >= PAGE);
  const [older, setOlder] = useState<Pages['older']>('idle');
  const [tries, setTries] = useState(0);
  const shown = useRef({ path, rows });               // what's on screen, and the request it answers
  useEffect(() => { shown.current.rows = rows; }, [rows]);
  useEffect(() => {
    const run = { live: true };                         // a later request (other filters, a new version) takes over
    const same = shown.current.path === path;
    const kept = peek<Row[]>(path);
    if (!same && kept) { setRows(kept); setMore(kept.length >= PAGE); setOlder('idle'); }
    // other filters dim the rows on screen until their answer comes; a new version refreshes quietly
    setLoading(!kept && (!same || !Array.isArray(shown.current.rows)));
    api<Row[]>('GET', path).then((fresh) => {
      if (!run.live) return;
      const prev = shown.current.rows;
      const overlaps = same && Array.isArray(prev) && prev.length > fresh.length && fresh.length > 0 && fresh[fresh.length - 1].id <= prev[0].id;
      if (overlaps) {
        const oldest = fresh[fresh.length - 1].id;
        setRows([...fresh, ...prev.filter((r) => r.id < oldest)]);
      } else {
        setRows(fresh); setMore(fresh.length >= PAGE); setOlder('idle');
      }
      shown.current.path = path;
    }).catch((e) => { if (run.live) { setRows(e as Error); shown.current.path = path; } })
      .finally(() => { if (run.live) setLoading(false); });
    return () => { run.live = false; };
  }, [path, tick, tries]);
  const loadOlder = () => {
    const list = shown.current.rows;
    if (!Array.isArray(list) || !list.length || older === 'loading') return;
    const before = list[list.length - 1].id;
    setOlder('loading');
    api<Row[]>('GET', `${path}${path.endsWith('?') ? '' : '&'}before=${before}`).then((page) => {
      if (shown.current.path !== path) return;
      setRows((r) => (Array.isArray(r) ? [...r, ...page.filter((x) => x.id < before)] : r));
      setMore(page.length >= PAGE);
      setOlder('idle');
    }, (e) => setOlder(e as Error));
  };
  return { rows, loading, more, older, loadOlder, retry: () => setTries((t) => t + 1) };
}

const countOf = (h: Pages) => (Array.isArray(h.rows) ? `${h.rows.length.toLocaleString()}${h.more ? '+' : ''}` : undefined);

/** Under the table: Load older while there's more, then where the list ends. */
function Older({ h, end }: { h: Pages; end: string }) {
  if (!Array.isArray(h.rows) || !h.rows.length) return null;
  if (!h.more) return <span className="text-13 text-ink-3">{end}</span>;
  return <>
    {h.older instanceof Error && <span className="text-13 text-live" role="alert">Couldn’t load older changes: {h.older.message}</span>}
    <Button variant="secondary" disabled={h.older === 'loading'} onClick={h.loadOlder}>
      {h.older === 'loading' ? 'Loading…' : h.older instanceof Error ? 'Try again' : 'Load older'}
    </Button>
  </>;
}

/** checkbox, when, who, what changed, flag, entity, environment */
const COLS_ALL = 'grid grid-cols-[28px_96px_minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,1.5fr)_minmax(0,1fr)_88px] max-xl:grid-cols-[28px_96px_minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,1.5fr)_88px] max-md:grid-cols-[28px_minmax(0,1fr)_72px]';
/** the same without the flag (the flag page's tab) */
const COLS_FLAG = 'grid grid-cols-[28px_96px_minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)_88px] max-md:grid-cols-[28px_minmax(0,1fr)_72px]';
const XL = 'max-xl:hidden';
const MD = 'max-md:hidden';
const time = 'text-13 text-ink-2';
const link = 'text-ink underline decoration-ink-4 underline-offset-4 hover:decoration-ink';
const dash = <span className="text-ink-3">—</span>;
/** The main cell's button: the row's way in for the keyboard and screen readers (the row itself takes clicks too). */
const openButton = 'block w-full min-w-0 cursor-default border-0 bg-transparent p-0 text-left text-inherit';

/** History: the audit log, newest first, back to the very first change. */
export function History() {
  const { revisionTick, meta } = useApp();
  const { envName } = useEnvs();
  const [q, setQ] = useState(() => new URLSearchParams(location.hash.split('?')[1] ?? '').get('flag') ?? '');
  const [applied, setApplied] = useState(q.trim());
  const [env, setEnv] = usePersistentState('history.env', '');
  const [entity, setEntity] = usePersistentState('history.entity', '');
  const [who, setWho] = usePersistentState('history.who', '');
  const [change, setChange] = usePersistentState('history.change', '');
  const [when, setWhen] = usePersistentState('history.when', '');
  const [from, setFrom] = usePersistentState('history.from', '');
  const [to, setTo] = usePersistentState('history.to', '');
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => { const t = setTimeout(() => setApplied(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  // "/" puts the cursor in the search box
  useSlashFocus(search);

  // every filter is the server's, so it reaches all of history, not just what's on screen
  const query = historyQuery({ q: applied, entity, env, who, change, when, from, to });
  const h = useHistoryPages(`/history?${query}`, revisionTick);
  const filtered = !!(applied || env || entity || who || change || when);
  const clearFilters = () => { setQ(''); setApplied(''); setEnv(''); setEntity(''); setWho(''); setChange(''); setWhen(''); setFrom(''); setTo(''); };
  const entityOptions = useMemo(() => [['', 'All'], ...meta.entities.map((c) => [c.key, c.name])] as [string, string][], [meta.entities]);
  const nameOf = (k: string) => meta.users.find((u) => u.key === k)?.name ?? k;
  const SUBJECTS = subjects(meta.dimensions);
  const changeOptions: [string, string][] = [['', 'All'], ...SUBJECTS, ...(change && !SUBJECTS.some(([k]) => k === change) ? [[change, changeName(change)] as [string, string]] : [])];
  const exportHref = (format: 'csv' | 'json') => `/api/history/export?${query}${format === 'json' ? `${query ? '&' : ''}format=json` : ''}`;

  return (
    <div className="flex min-h-full flex-1 flex-col">
      {/* the bar: what this is and how many, and taking it away (everything these filters match, however old: not
          just what's on screen); the filters get a row of their own under it, as on Flags */}
      <PageBar title="History" count={<CountSlot text={countOf(h)} />}
        actions={<>
          <a href={exportHref('csv')} download data-slot="button" className={buttonVariants({ variant: 'secondary' })} title="Every change these filters match, as a spreadsheet">Export CSV</a>
          <a href={exportHref('json')} download data-slot="button" className={buttonVariants({ variant: 'secondary' })} title="Every change these filters match, as JSON">Export JSON</a>
        </>} />
      <div role="search" aria-label="Filter history" className="flex flex-wrap items-center gap-2 border-b border-grid px-6 py-2.5 max-sm:px-4">
        <SearchField ref={search} className="w-[240px] max-md:w-auto max-md:flex-1 max-md:basis-full" placeholder="Flag key  /" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search by flag key" />
        <FilterSelect label="Environment" value={env} onChange={setEnv} options={[['', 'All'], ...meta.environments.map((e) => [e.key, envName(e.key)] as [string, string])]} />
        {meta.dimensions.length > 0 && <FilterSelect label={capital(listWords(meta.dimensions))} value={entity} onChange={setEntity} options={entityOptions} />}
        <FilterSelect label="Who" value={who} onChange={setWho} options={options(meta.users.map((u) => u.key), who, nameOf)} />
        <FilterSelect label="Change" value={change} onChange={setChange} options={changeOptions} />
        <FilterSelect label="When" value={when} onChange={setWhen} options={WHEN} />
        {when === 'custom' && (
          <span className={cn(BAR_CONTROLS, 'inline-flex items-center gap-1.5 text-13 text-ink-2')}>
            <input type="date" className={denseField} value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label="From (included)" />
            <span aria-hidden>–</span>
            <input type="date" className={denseField} value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label="To (included)" />
          </span>
        )}
        {filtered && <button type="button" onClick={clearFilters} className={barTextButton}>Reset</button>}
      </div>
      <ChangeTable rows={h.rows} busy={h.loading} onRetry={h.retry} store="history" csvName="history.csv" filtered={filtered} onClearFilters={clearFilters}
        footer={<Older h={h} end={filtered ? 'That’s every change these filters match.' : 'That’s the first change ever made here.'} />} />
    </div>
  );
}

/** History for one flag: a tab on the flag page, the same table under its environment filter. */
export function FlagHistory({ flagKey }: { flagKey: string }) {
  const { revisionTick, meta } = useApp();
  const { envName } = useEnvs();
  const [env, setEnv] = usePersistentState('flag-history.env', '');
  const p = new URLSearchParams({ flag: flagKey });
  if (env) p.set('environment', env);
  const h = useHistoryPages(`/history?${p}`, revisionTick);
  const count = countOf(h);
  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-2 px-6 py-2.5 max-sm:px-4">
        <FilterSelect label="Environment" value={env} onChange={setEnv} options={[['', 'All'], ...meta.environments.map((e) => [e.key, envName(e.key)] as [string, string])]} />
        <span className="flex-1" />
        <span className="font-mono text-11 text-ink-3 uppercase">
          {count !== undefined ? `${count} ${count === '1' ? 'change' : 'changes'}` : <Bone className="w-20" />}
        </span>
      </div>
      <ChangeTable rows={h.rows} busy={h.loading} onRetry={h.retry} hideFlag store="flag-history" csvName={`history-${flagKey}.csv`} filtered={!!env} onClearFilters={() => setEnv('')}
        footer={<Older h={h} end="That’s the first change to this flag." />} />
    </div>
  );
}

/** Who made a change; an emergency bypass is marked red, an agent purple, a script or system by its kind. */
function Actor({ r }: { r: Row }) {
  return <>
    <span className="truncate font-medium">{r.changedBy}</span>
    {r.actorType === 'bypass' ? <Badge kind="danger">emergency</Badge>
      : r.actorType === 'agent' ? <AgentBadge />
      : r.actorType !== 'user' ? <span className="font-mono text-11 tracking-[0.55px] text-ink-3 uppercase">{r.actorType}</span> : null}
  </>;
}

/** The change list: sortable, selectable for Export CSV, a drawer for one entry. */
function ChangeTable({ rows, busy, onRetry, hideFlag, store, csvName, filtered, onClearFilters, footer }: {
  rows: Rows; busy: boolean; onRetry: () => void; hideFlag?: boolean; store: string; csvName: string; filtered: boolean; onClearFilters: () => void; footer?: ReactNode;
}) {
  const { meta, toast } = useApp();
  const { envName, isProtected } = useEnvs();
  const [order, setOrder] = usePersistentState<Order>(`${store}.sort`, { by: 'when', dir: 'desc' });
  const [entry, setEntry] = useState<Row | null>(null);
  const [open, setOpen] = useState(false);
  const sorted = useMemo(() => {
    if (!Array.isArray(rows)) return [];
    const m = order.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => (order.by === 'who'
      ? m * a.changedBy.localeCompare(b.changedBy) || b.id - a.id
      : m * (Date.parse(a.changedAt) - Date.parse(b.changedAt) || a.id - b.id)));
  }, [rows, order]);
  const sel = useSelection(sorted.map((r) => String(r.id)));
  const openRow = (r: Row) => { setEntry(r); setOpen(true); };
  const list = useListKeys({
    count: sorted.length,
    onOpen: (i) => openRow(sorted[i]),
    onToggle: (i) => sel.toggle(String(sorted[i].id)),
    onClear: () => { if (!open) sel.clear(); },
    enabled: !open,
  });
  const names = entityIndex(meta.entities);
  const whoWords = capital(listWords(meta.dimensions)) || 'Entry';
  const cols = hideFlag ? COLS_FLAG : COLS_ALL;
  const custCol = hideFlag ? MD : XL;
  const sortProps = { sort: order.by, dir: order.dir, onSort: (by: Sort, dir: 'asc' | 'desc') => setOrder({ by, dir }) };

  const exportCsv = () => {
    const chosen = sorted.filter((r) => sel.isSelected(String(r.id)));
    downloadCsv(csvName, ['changed_at', 'changed_by', 'actor_type', 'change', 'flag', 'entity', 'environment', 'revision', 'request', 'comment'],
      chosen.map((r) => [r.changedAt, r.changedBy, r.actorType, r.changeType, r.flag, r.entity, r.environment, r.revision, r.changeSetId, r.comment]));
    toast(`Exported ${plural(chosen.length, 'change')} to ${csvName}`);
  };

  return <>
    {/* while the filters reload, the old rows stay in place, dimmed */}
    <div role="table" aria-label="Changes" aria-busy={busy} className={cn('flex-1', busy && Array.isArray(rows) && 'opacity-70')}>
      <div role="row" className={cn(cols, tableHeadClass)}>
        <RowCheck head checked={sel.all} indeterminate={sel.some} onChange={sel.toggleAll} label="Select all changes" />
        <span className="max-md:order-last max-md:text-right"><SortHeader label="When" sortKey="when" {...sortProps} /></span>
        <span className={MD}><SortHeader label="Who" sortKey="who" {...sortProps} /></span>
        <span role="columnheader">What changed</span>
        {!hideFlag && <span role="columnheader" className={MD}>Flag</span>}
        <span role="columnheader" className={custCol}>{whoWords}</span>
        <span role="columnheader" className={MD}>Environment</span>
      </div>
      {rows instanceof Error ? (
        <Callout tone="error" role="alert" className="m-6 flex flex-wrap items-center gap-x-4 gap-y-2 max-sm:m-4">
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">Couldn’t load the history: {rows.message}</span>
          <span className={BAR_CONTROLS}><Button variant="secondary" disabled={busy} onClick={onRetry}>{busy ? 'Trying…' : 'Try again'}</Button></span>
        </Callout>
      )
        : !rows ? <SkeletonRows cols={cols} cells={['', 'max-md:order-last', MD, '', ...(hideFlag ? [] : [MD]), custCol, MD]} />
        : sorted.length === 0 ? (
          <div className="px-6 py-10 max-sm:px-4">
            <Empty action={filtered ? <Button variant="secondary" onClick={onClearFilters}>Clear filters</Button> : undefined}>
              {filtered ? 'No changes match these filters.' : 'Nothing has changed here yet.'}
            </Empty>
          </div>
        ) : sorted.map((r, i) => (
          <div key={r.id} role="row" data-row-index={i} data-active={list.active === i} aria-selected={sel.isSelected(String(r.id))}
            onClick={() => { list.setActive(i); openRow(r); }} className={cn(cols, tableRowClass, 'cursor-default')}>
            <RowCheck checked={sel.isSelected(String(r.id))} onChange={() => sel.toggle(String(r.id))} label={`Select change ${r.id}`} />
            <span role="cell" className={cn(time, 'max-md:order-last max-md:text-right')}><When iso={r.changedAt} /></span>
            <span role="cell" className={cn(MD, 'flex min-w-0 items-center gap-1.5')}><Actor r={r} /></span>
            <span role="cell" className="min-w-0">
              <button type="button" className={openButton} aria-haspopup="dialog" onClick={(e) => { e.stopPropagation(); list.setActive(i); openRow(r); }}>
                <span className="block truncate">{changeName(r.changeType)}{r.changeSetId && <span className="text-ink-3"> · #{r.changeSetId}</span>}</span>
                {r.comment && <span className="block truncate text-ink-3 max-md:hidden">{r.comment}</span>}
                <span className="flex min-w-0 items-center gap-1.5 text-ink-3 md:hidden">
                  <span className="truncate">{[r.changedBy, !hideFlag && r.flag, r.environment && envName(r.environment)].filter(Boolean).join(' · ')}</span>
                  {r.actorType === 'bypass' && <Badge kind="danger">emergency</Badge>}
                  {r.actorType === 'agent' && <AgentBadge />}
                </span>
              </button>
            </span>
            {!hideFlag && (
              <span role="cell" className={cn(MD, 'min-w-0 truncate')}>
                {r.flag ? <a className={cn(link, 'font-mono text-xs')} href={`#/flag/${r.flag}${r.environment ? `/${r.environment}` : ''}`} onClick={(e) => e.stopPropagation()}>{r.flag}</a> : dash}
              </span>
            )}
            <span role="cell" className={cn(custCol, 'truncate text-ink-2')} title={r.entity ?? undefined}>{r.entity ? names.get(r.entity)?.name ?? r.entity : dash}</span>
            <span role="cell" className={MD}>{r.environment ? <span className={cn('text-13', isProtected(r.environment) ? 'text-flag' : 'text-ink-2')}>{envName(r.environment)}</span> : dash}</span>
          </div>
        ))}
    </div>

    {/* there while the list loads too, as tall as with Load older in it, so the table's bottom edge stays put */}
    <div className={cn('flex flex-wrap items-center gap-4 border-t border-rule px-6 py-2.5 max-sm:px-4', pagerRow)}>
      <KeyHints hide={hideFlag ? ['search'] : undefined} className="max-md:hidden" />
      <span className="flex-1" />
      {footer}
    </div>

    <BulkBar count={sel.count} onClear={sel.clear}>
      <Button variant="outline" onClick={exportCsv}>Export CSV</Button>
    </BulkBar>

    <EntryDrawer entry={entry} open={open} onClose={() => setOpen(false)} hideFlag={hideFlag} names={names} whoWords={whoWords} />
  </>;
}

/** One change in full: who, when, where, the comment, and what it was before and after. */
function EntryDrawer({ entry: r, open, onClose, hideFlag, names, whoWords }: { entry: Row | null; open: boolean; onClose: () => void; hideFlag?: boolean; names: Map<string, Entity>; whoWords: string }) {
  const { envName } = useEnvs();
  const toFlag = !hideFlag && r?.flag;
  return (
    <Drawer open={open} onClose={onClose} title={r ? changeName(r.changeType) : ''}
      subtitle={r ? <>{r.changedBy}{r.flag && !hideFlag && <> · <span className="font-mono">{r.flag}</span></>} · <When iso={r.changedAt} /></> : undefined}
      footer={r && (toFlag || r.changeSetId) ? <>
        {toFlag && <Button onClick={() => { onClose(); go(`flag/${r.flag}${r.environment ? `/${r.environment}` : ''}`); }}>Open flag</Button>}
        {r.changeSetId && <Button variant={toFlag ? 'secondary' : 'default'} onClick={() => { onClose(); go(`approvals/${r.changeSetId}`); }}>Open request #{r.changeSetId}</Button>}
      </> : undefined}>
      {r && <>
        <DrawerSection title="Entry">
          <DrawerRow label="Who"><span className="inline-flex max-w-full items-center gap-1.5"><Actor r={r} /></span></DrawerRow>
          <DrawerRow label="When">{new Date(r.changedAt).toLocaleString()} <span className="text-ink-3">· <When iso={r.changedAt} /></span></DrawerRow>
          <DrawerRow label="Change">{changeName(r.changeType)}</DrawerRow>
          {!hideFlag && <DrawerRow label="Flag">{r.flag ? <span className="font-mono">{r.flag}</span> : dash}</DrawerRow>}
          <DrawerRow label={whoWords}>{r.entity ? <>{names.get(r.entity)?.name ?? r.entity} <span className="font-mono text-xs text-ink-3">{r.entity}</span></> : dash}</DrawerRow>
          <DrawerRow label="Environment">{r.environment ? envName(r.environment) : dash}</DrawerRow>
          {r.revision != null && <DrawerRow label="Revision"><span className="font-mono">{r.revision}</span></DrawerRow>}
          {r.changeSetId && <DrawerRow label="Request">#{r.changeSetId}</DrawerRow>}
        </DrawerSection>
        {r.comment && (
          <DrawerSection title="Comment">
            <p className="m-0 text-13 whitespace-pre-line text-ink-1 [overflow-wrap:anywhere]">{r.comment}</p>
          </DrawerSection>
        )}
        {(r.before || r.after) && (
          <DrawerSection title="Before and after">
            {r.changeType.startsWith('layer.') ? <LayerDiff before={r.before as Layer | null} after={r.after as Layer | null} entity={r.entity} /> : (
              <div className="grid gap-3">
                <div className="grid min-w-0 content-start gap-1.5"><span className={monoLabel}>Before</span>{r.before == null ? dash : <JsonView value={r.before} />}</div>
                <div className="grid min-w-0 content-start gap-1.5"><span className={monoLabel}>After</span>{r.after == null ? dash : <JsonView value={r.after} />}</div>
              </div>
            )}
          </DrawerSection>
        )}
      </>}
    </Drawer>
  );
}
