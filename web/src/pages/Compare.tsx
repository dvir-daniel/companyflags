import { useRef, useState, type ReactNode } from 'react';
import { ArrowsLeftRightIcon, ArrowSquareOutIcon } from '@phosphor-icons/react';
import { Button } from '@companyfeatures/ui/components/button';
import { Callout } from '@companyfeatures/ui/components/callout';
import { KeyHints, tableHeadClass, tableRowClass, useListKeys } from '@companyfeatures/ui/components/data-table';
import { CountSlot, SkeletonRows } from '../loading.tsx';
import { pagerRow } from '../loadingKit.ts';
import { Drawer, DrawerSection } from '@companyfeatures/ui/components/drawer';
import { NativeSelect } from '@companyfeatures/ui/components/native-select';
import { BAR_CONTROLS, FilterSelect, PageBar } from '@companyfeatures/ui/components/page-bar';
import { SearchField } from '@companyfeatures/ui/components/search-field';
import { cn } from '@companyfeatures/ui/lib/utils';
import { api, capital, entityLabel, fmtValue, type Dimensions } from '../api.ts';
import { listWords } from '../dimWords.ts';
import { go, useApp } from '../app.ts';
import { Empty, InAppDefault, PAGE_SIZE, Pager, Segmented, Val } from '../ui.tsx';
import { denseField, monoLabel, type Paged, usePersistentState, useServerPage, useSlashFocus } from '../uiKit.ts';
import { EntityPicker } from './flagParts.tsx';
import { useEnvs } from './envs.ts';

/*
 * Compare: the dense console layout. A sticky page bar (search, which flags), a setup block of two labelled lines
 * (what is compared and its two sides, A ⇄ B; then what is sent the same for both), a full-width table of what every
 * flag gives each side, and a drawer with one flag's two answers. Keyboard: / search, j/k move, Enter open.
 */

type Mode = 'entities' | 'environments' | 'apps';
type Side = { environment: string; project: string; entity: string | null };
type Outcome = { sent: boolean; value: unknown; codeDefault: boolean; variant: string | null; source: string; rule: string | null; byDevice: boolean };
type Row = { key: string; description: string | null; a: Outcome; b: Outcome; same: boolean };
// the list contract (matched = rows after "only differences" and search, all = every flag) plus how many differ
type Result = Paged & { different: number; rows: Row[] };
// the two sides picked in each mode, remembered together
type Picked = Record<Mode, [string, string]>;

// what's compared: two entities (in any dimension, named by the installation's words), two environments or two apps
const MODE_KEYS: Mode[] = ['entities', 'environments', 'apps'];
const modeLabels = (dims: Dimensions): Record<Mode, string> => ({ entities: capital(listWords(dims, 'and', true)) || 'Who', environments: 'Environments', apps: 'Flag sets' });
const sideNouns = (dims: Dimensions): Record<Mode, string> => ({ entities: capital(listWords(dims)) || 'Who', environments: 'Environment', apps: 'Flag set' });

/** flag, A, B; on a phone the flag spans both value columns */
// the main cell's button: the row's way in for the keyboard and screen readers (the row itself takes clicks too)
const openButton = 'block w-full min-w-0 cursor-default border-0 bg-transparent p-0 text-left text-inherit';
const COLS = 'grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)] max-sm:grid-cols-2';
/** placeholder rows: as tall as a row with a flag's key and description */
const ROW = 'min-h-14';
// a box for the entity picker (an input and its suggestions) that sets its width
const pickerBox = 'flex min-w-0 [&>input]:w-full [&>input]:min-w-0';
// the strip's selects: 32px, 13px text like the other fields in it
const stripSelect = '[&>select]:pl-2.5 [&>select]:text-13';

/** The page scrolls, not the list: after paging from the footer, bring the list's top back into view. */
function showListTop(list: HTMLElement | null) {
  const pane = list?.closest('main');
  if (list && pane && list.getBoundingClientRect().top < pane.getBoundingClientRect().top) list.scrollIntoView({ block: 'start' });
}

/** The A or B mark: A outlined, B inverted, so the two columns can't be confused. */
function Letter({ side }: { side: 'A' | 'B' }) {
  return (
    <span aria-hidden className={cn('inline-grid size-4 shrink-0 place-items-center font-mono text-11 leading-none font-medium',
      side === 'A' ? 'border border-ink-3 text-ink' : 'bg-ink text-background')}>{side}</span>
  );
}

/** A field in the setup strip with its mono label inline. On a phone it fills its half of the row. */
function StripField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 items-center gap-2">
      <span className={cn(monoLabel, 'shrink-0')}>{label}</span>
      {children}
    </label>
  );
}

// Compare two entities, two environments or two apps: what every flag gives each side, and why.
export function Compare() {
  const { meta, revisionTick } = useApp();
  const { envName } = useEnvs();
  const firstEntities = meta.entities.map((c) => c.key);
  const MODES = MODE_KEYS.filter((m) => m !== 'entities' || meta.dimensions.length > 0);
  const LABEL = modeLabels(meta.dimensions);
  const SIDE_NOUN = sideNouns(meta.dimensions);
  // the page opens on the last comparison: the mode, "Show" and both sides of every mode are remembered
  const [savedMode, setMode] = usePersistentState<Mode>('compare.mode', 'entities');
  const mode: Mode = MODES.includes(savedMode) ? savedMode : MODES[0];
  const [show, setShow] = usePersistentState<'diff' | 'all'>('compare.show', 'diff');
  const onlyDiff = show !== 'all';
  const [saved, setSaved] = usePersistentState<Partial<Picked>>('compare.sides', {});
  // a remembered side that no longer exists (a removed entity, say) falls back to the default
  const known: Record<Mode, string[]> = { entities: firstEntities, environments: meta.environments.map((e) => e.key), apps: meta.projects.map((p) => p.key) };
  // until something is picked: the first two of each (the first entities in the list, not made-up ones)
  const defaults: Picked = {
    entities: [firstEntities[0] ?? '', firstEntities[1] ?? firstEntities[0] ?? ''],
    environments: [meta.environments[0]?.key ?? '', meta.environments[1]?.key ?? meta.environments[0]?.key ?? ''],
    apps: [meta.projects[0]?.key ?? '', meta.projects[1]?.key ?? meta.projects[0]?.key ?? ''],
  };
  const sideOf = (m: Mode): [string, string] => {
    const v = saved[m];
    return [0, 1].map((i) => (Array.isArray(v) && known[m].includes(v[i]) ? v[i] : defaults[m][i])) as [string, string];
  };
  const pick = (m: Mode) => (v: [string, string]) => setSaved({ ...saved, [m]: v });
  // what is compared, per mode
  const ents = sideOf('entities');
  const envs = sideOf('environments');
  const apps = sideOf('apps');
  const setEnts = pick('entities');
  const setEnvs = pick('environments');
  const setApps = pick('apps');
  // what stays the same for both sides
  const [env, setEnv] = useState(meta.environments[0]?.key ?? '');
  const [app, setApp] = useState(meta.projects[0]?.key ?? '');
  const [entity, setEntity] = useState(firstEntities[0] ?? '');
  // not sent until typed in
  const [version, setVersion] = useState('');
  const [device, setDevice] = useState('');
  const [q, setQ] = useState('');
  const [tries, setTries] = useState(0);   // Try again asks the server the same question again
  // the drawer's row; it stays set while the drawer slides out
  const [drawer, setDrawer] = useState<{ row: Row; open: boolean } | null>(null);
  const search = useRef<HTMLInputElement>(null);

  const sides: [Side, Side] = mode === 'entities'
    ? [{ environment: env, project: app, entity: ents[0] || null }, { environment: env, project: app, entity: ents[1] || null }]
    : mode === 'environments'
      ? [{ environment: envs[0], project: app, entity: entity || null }, { environment: envs[1], project: app, entity: entity || null }]
      : [{ environment: env, project: apps[0], entity: entity || null }, { environment: env, project: apps[1], entity: entity || null }];
  const sameSides = JSON.stringify(sides[0]) === JSON.stringify(sides[1]);
  const request = JSON.stringify({ sides, version, device });

  const n = q.trim().toLowerCase();
  // the server compares every flag, then sends back the counts and only the current page
  const paging = useServerPage<Result>((page) => ({
    key: `compare|${request}|${onlyDiff}|${n}|${page}`,
    load: () => sameSides
      ? Promise.resolve<Result>({ matched: 0, all: 0, page: 0, size: PAGE_SIZE, different: 0, rows: [] })
      : api<Result>('POST', '/compare', {
        a: sides[0], b: sides[1], attrs: { 'app.version': version, 'device.id': device }, q: n, onlyDiff, page, size: PAGE_SIZE,
      }),
  }), `${request}|${onlyDiff}|${n}`, `${revisionTick}:${tries}`);
  const data = paging.data;
  const rows = data?.rows ?? [];

  const openRow = (r: Row) => setDrawer({ row: r, open: true });
  const closeDrawer = () => setDrawer((d) => d && { ...d, open: false });
  const keys = useListKeys({ count: rows.length, onOpen: (i) => openRow(rows[i]), enabled: !drawer?.open });
  // "/" puts the cursor in the search box
  useSlashFocus(search, !drawer?.open);

  const entName = (k: string) => (k ? entityLabel(meta.entities, k) : 'Everyone');
  const labels: [string, string] = mode === 'entities' ? [entName(ents[0]), entName(ents[1])]
    : mode === 'environments' ? [envName(envs[0]), envName(envs[1])] : [apps[0], apps[1]];
  const swap = () => {
    if (mode === 'entities') setEnts([ents[1], ents[0]]);
    else if (mode === 'environments') setEnvs([envs[1], envs[0]]);
    else setApps([apps[1], apps[0]]);
  };
  const envSelect = (value: string, onChange: (v: string) => void, label: string, className: string) => (
    <NativeSelect size="sm" className={cn(stripSelect, className)} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      {meta.environments.map((e) => <option key={e.key} value={e.key}>{envName(e.key)}</option>)}
    </NativeSelect>
  );
  const appSelect = (value: string, onChange: (v: string) => void, label: string, className: string) => (
    <NativeSelect size="sm" className={cn(stripSelect, 'font-mono', className)} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      {meta.projects.map((p) => <option key={p.key} value={p.key}>{p.key}</option>)}
    </NativeSelect>
  );
  // A and B: as wide as what they hold (an entity's name, an environment, an app); on a phone they share the row
  const sideWidth = cn(mode === 'entities' ? 'w-40' : mode === 'environments' ? 'w-32' : 'w-28', 'max-sm:w-auto max-sm:flex-1');
  const pickers: [ReactNode, ReactNode] = mode === 'entities'
    ? [<span key="a" className={cn(pickerBox, sideWidth)}><EntityPicker value={ents[0]} onChange={(k) => setEnts([k, ents[1]])} /></span>,
      <span key="b" className={cn(pickerBox, sideWidth)}><EntityPicker value={ents[1]} onChange={(k) => setEnts([ents[0], k])} /></span>]
    : mode === 'environments'
      ? [envSelect(envs[0], (v) => setEnvs([v, envs[1]]), 'Environment A', sideWidth), envSelect(envs[1], (v) => setEnvs([envs[0], v]), 'Environment B', sideWidth)]
      : [appSelect(apps[0], (v) => setApps([v, apps[1]]), 'Flag set A', sideWidth), appSelect(apps[1], (v) => setApps([apps[0], v]), 'Flag set B', sideWidth)];
  const noun = mode === 'entities' ? (listWords(meta.dimensions, 'and', true) || 'entries') : mode === 'environments' ? 'environments' : 'flag sets';
  // "Open flag" goes to side A's environment
  const flagEnv = sides[0].environment;
  const fieldWidth = 'max-sm:w-auto max-sm:flex-1';

  // the drawer follows its row as the list reloads (after a publish, say)
  const shownRow = drawer ? rows.find((r) => r.key === drawer.row.key) ?? drawer.row : null;

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <PageBar title="Compare" count={sameSides ? undefined : <CountSlot text={data ? <span title={countText(data, labels)}>{countText(data)}</span> : undefined} />}>
        <SearchField ref={search} className="w-[240px] max-md:w-auto max-md:flex-1 max-sm:basis-full" data-search="compare" placeholder="Search  /"
          value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search flags" />
        <FilterSelect label="Show" value={show} onChange={setShow} options={[['diff', 'Differences'], ['all', 'All flags']]} />
      </PageBar>

      {/* the setup, as two labelled lines: what is compared and its two sides, then the rest of the request, sent
          the same for both. The mode sits next to the sides it changes; on a phone each label goes above its line */}
      <div role="group" aria-label="What to compare"
        className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-5 gap-y-2.5 border-b border-rule px-6 py-3 max-sm:grid-cols-1 max-sm:gap-y-1.5 max-sm:px-4">
        <span className={monoLabel}>Compare</span>
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 max-sm:mb-2">
          <Segmented<Mode> label="What to compare" value={mode} onChange={setMode} options={MODES.map((value) => ({ value, label: LABEL[value] }))}
            className="[&_[data-slot=segmented-item]]:h-[30px] max-sm:w-full max-sm:[&_[data-slot=segmented-item]]:flex-1" />
          <div className="flex min-w-0 items-center gap-2 max-sm:basis-full">
            <div role="group" aria-label={`${SIDE_NOUN[mode]} A`} className="flex min-w-0 items-center gap-2 max-sm:flex-1"><Letter side="A" />{pickers[0]}</div>
            <Button variant="ghost" size="icon" onClick={swap} title="Swap A and B" aria-label="Swap A and B"><ArrowsLeftRightIcon aria-hidden className="size-4" /></Button>
            <div role="group" aria-label={`${SIDE_NOUN[mode]} B`} className="flex min-w-0 items-center gap-2 max-sm:flex-1"><Letter side="B" />{pickers[1]}</div>
          </div>
        </div>
        <span className={monoLabel} title="Sent the same for A and B">Same for both</span>
        <div role="group" aria-label="Same for both" title="Sent the same for A and B"
          className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2 max-sm:grid max-sm:grid-cols-2 max-sm:gap-x-3">
          {mode !== 'environments' && <StripField label="Environment">{envSelect(env, setEnv, 'Environment', cn('w-32', fieldWidth))}</StripField>}
          {mode !== 'apps' && <StripField label="Flag set">{appSelect(app, setApp, 'Flag set', cn('w-28', fieldWidth))}</StripField>}
          {mode !== 'entities' && meta.dimensions.length > 0 && (
            <StripField label={SIDE_NOUN.entities}><span className={cn(pickerBox, 'w-40', fieldWidth)}><EntityPicker value={entity} onChange={setEntity} allowNone /></span></StripField>
          )}
          <StripField label="Version">
            <input className={cn(denseField, 'w-24 font-mono', fieldWidth)} value={version} onChange={(e) => setVersion(e.target.value)} placeholder="not sent" aria-label="App version" />
          </StripField>
          <StripField label="Device">
            <input className={cn(denseField, 'w-28 font-mono', fieldWidth)} value={device} onChange={(e) => setDevice(e.target.value)} placeholder="not sent" aria-label="Device ID"
              title="Decides who is inside a “% of devices” rule" />
          </StripField>
        </div>
      </div>

      {/* what every flag gives each side; while the next answer loads, the old rows stay in place, dimmed */}
      <div role="table" aria-label="Results" aria-busy={paging.loading} ref={paging.listRef}
        className={cn('flex-1 scroll-mt-[var(--page-bar-h,3.5rem)] transition-opacity duration-150', paging.loading && data && 'opacity-55')}>
        <div role="row" className={cn(COLS, tableHeadClass, 'max-md:static')}>
          <span role="columnheader" className="max-sm:hidden">Flag</span>
          <span role="columnheader" className="flex min-w-0 items-center gap-1.5"><Letter side="A" /><span className="truncate">{labels[0]}</span></span>
          <span role="columnheader" className="flex min-w-0 items-center gap-1.5"><Letter side="B" /><span className="truncate">{labels[1]}</span></span>
        </div>
        {sameSides ? <div className="px-6 py-10 max-sm:px-4"><Empty>Pick two different {noun} to compare.</Empty></div>
          : paging.error ? (
            <Callout tone="error" role="alert" className="m-6 flex flex-wrap items-center gap-x-4 gap-y-2 max-sm:m-4">
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">Couldn’t compare {labels[0]} and {labels[1]}: {paging.error}</span>
              <span className={BAR_CONTROLS}><Button variant="secondary" disabled={paging.loading} onClick={() => setTries((t) => t + 1)}>{paging.loading ? 'Trying…' : 'Try again'}</Button></span>
            </Callout>
          )
          : !data ? <SkeletonRows cols={COLS} cells={['max-sm:hidden', '', '']} rowClass={ROW} />
          : rows.length === 0 ? (
            <div className="px-6 py-10 max-sm:px-4">
              <Empty action={n ? <Button variant="secondary" onClick={() => setQ('')}>Clear search</Button> : onlyDiff ? <Button variant="secondary" onClick={() => setShow('all')}>Show all flags</Button> : undefined}>
                {n ? `No flags match “${q.trim()}”.` : `${labels[0]} and ${labels[1]} get the same value for every flag.`}
              </Empty>
            </div>
          ) : rows.map((r, i) => (
            <div key={r.key} role="row" data-row-index={i} data-active={keys.active === i} aria-selected={!!drawer?.open && drawer.row.key === r.key}
              onClick={() => { keys.setActive(i); openRow(r); }} className={cn(COLS, tableRowClass, 'cursor-default gap-y-1')}>
              <span role="cell" className="min-w-0 max-sm:col-span-2">
                <button type="button" className={openButton} aria-haspopup="dialog" onClick={(e) => { e.stopPropagation(); keys.setActive(i); openRow(r); }}>
                  <span className={cn('block truncate font-mono text-13 font-medium', r.same ? 'text-ink-3' : 'text-ink')}>{r.key}</span>
                  {r.description && <span className="block truncate text-ink-3">{r.description}</span>}
                </button>
              </span>
              <AnswerCell o={r.a} differs={!r.same} />
              <AnswerCell o={r.b} differs={!r.same} />
            </div>
          ))}
      </div>

      <div className={cn('flex flex-wrap items-center gap-4 border-t border-rule px-6 max-sm:px-4', pagerRow)}>
        {/* no selection here, so the "x select" hint (the second) is hidden */}
        <KeyHints hide={['select']} className="max-md:hidden" />
        <span className="flex-1" />
        {data && !sameSides && (
          <Pager page={paging.page} size={paging.size} matched={data.matched} noun="flags"
            onPage={(p) => { paging.go(p); keys.setActive(-1); showListTop(paging.listRef.current); }} />
        )}
      </div>

      <AnswerDrawer row={shownRow} open={!!drawer?.open} labels={labels} sides={sides} version={version} device={device}
        onClose={closeDrawer} onOpenFlag={(k) => { closeDrawer(); go(`flag/${k}/${flagEnv}`); }} openLabel={envName(flagEnv)} />
    </div>
  );
}

/** "6 of 5,009 flags differ", or with the sides: "6 of 5,009 flags differ between Microsoft and Google". */
function countText(r: Result, sides?: [string, string]) {
  const text = `${r.different.toLocaleString()} of ${r.all.toLocaleString()} flags ${r.different === 1 ? 'differs' : 'differ'}`;
  return sides ? `${text} between ${sides[0]} and ${sides[1]}` : text;
}

/** One side's value: bold when A and B differ, dimmed when they don't. In the drawer (`full`) a long value wraps. */
function Answer({ o, differs, full }: { o: Outcome; differs: boolean; full?: boolean }) {
  if (!o.sent) return <span className={cn('text-13', differs ? 'font-semibold text-ink' : 'text-ink-3')}>Not sent</span>;
  if (o.codeDefault) return <InAppDefault className={cn(differs ? 'font-semibold text-ink' : 'opacity-60')} />;
  return <Val className={cn(differs ? 'font-semibold' : 'text-ink-3', full && 'whitespace-normal [overflow-wrap:anywhere]')} title={fmtValue(o.value)}>{fmtValue(o.value)}</Val>;
}

const BY_DEVICE = 'Decided by a “% of devices” rule: another device ID can get another value';

/** A table cell: the value (and whether it varies by device), then where it comes from. */
function AnswerCell({ o, differs }: { o: Outcome; differs: boolean }) {
  return (
    <span role="cell" className="min-w-0">
      <span className="flex min-w-0 items-center gap-2">
        <Answer o={o} differs={differs} />
        {o.byDevice && <span className={cn(monoLabel, 'shrink-0 text-ink-2')} title={BY_DEVICE}>by device</span>}
      </span>
      <span className="block truncate text-xs text-ink-3">{o.source}{o.rule && <> · {o.rule}</>}</span>
    </span>
  );
}

// a drawer line: its name, then A's and B's side by side
const PAIR_LINE = 'grid grid-cols-[104px_minmax(0,1fr)_minmax(0,1fr)] items-baseline gap-x-4 border-b border-grid py-2.5 text-13 last:border-b-0 max-sm:grid-cols-[80px_minmax(0,1fr)_minmax(0,1fr)] max-sm:gap-x-3';
function Pair({ label, a, b }: { label: string; a: ReactNode; b: ReactNode }) {
  return (
    <div className={PAIR_LINE}>
      <span className="text-ink-3">{label}</span>
      <span className="min-w-0 text-ink [overflow-wrap:anywhere]">{a}</span>
      <span className="min-w-0 text-ink [overflow-wrap:anywhere]">{b}</span>
    </div>
  );
}

/** One flag's two answers side by side, and what each side asked with. */
function AnswerDrawer({ row, open, labels, sides, version, device, onClose, onOpenFlag, openLabel }: {
  row: Row | null; open: boolean; labels: [string, string]; sides: [Side, Side]; version: string; device: string;
  onClose: () => void; onOpenFlag: (key: string) => void; openLabel: string;
}) {
  const { meta } = useApp();
  const { envName } = useEnvs();
  const entName = (k: string | null) => (k ? entityLabel(meta.entities, k) : null);
  const none = <span className="text-ink-3">—</span>;
  const differs = !!row && !row.same;
  return (
    <Drawer open={open} onClose={onClose} title={<span className="font-mono">{row?.key}</span>}
      subtitle={row ? (row.same ? 'Same for A and B' : 'A and B differ') : undefined}
      footer={row && <Button onClick={() => onOpenFlag(row.key)}>Open flag in {openLabel.toLowerCase()} <ArrowSquareOutIcon aria-hidden className="size-3.5" /></Button>}>
      {row && <>
        {row.description && <p className="m-0 mb-5 text-sm text-ink-2 [overflow-wrap:anywhere]">{row.description}</p>}
        <div className={cn(PAIR_LINE, 'border-rule py-2')}>
          <span />
          {(['A', 'B'] as const).map((s, i) => (
            <span key={s} className={cn(monoLabel, 'flex min-w-0 items-center gap-1.5')}><Letter side={s} /><span className="truncate">{labels[i]}</span></span>
          ))}
        </div>
        <DrawerSection title="Answer" className="mt-4">
          <Pair label="Value" a={<Answer o={row.a} differs={differs} full />} b={<Answer o={row.b} differs={differs} full />} />
          <Pair label="Source" a={row.a.source} b={row.b.source} />
          <Pair label="Rule" a={row.a.rule ?? none} b={row.b.rule ?? none} />
          <Pair label="By device" a={row.a.byDevice ? <span title={BY_DEVICE}>Varies</span> : 'No'} b={row.b.byDevice ? <span title={BY_DEVICE}>Varies</span> : 'No'} />
        </DrawerSection>
        <DrawerSection title="Asked with">
          <Pair label="Environment" a={envName(sides[0].environment)} b={envName(sides[1].environment)} />
          <Pair label="Flag set" a={<span className="font-mono">{sides[0].project}</span>} b={<span className="font-mono">{sides[1].project}</span>} />
          {meta.dimensions.length > 0 && <Pair label={capital(listWords(meta.dimensions)) || 'Who'} a={entName(sides[0].entity) ?? none} b={entName(sides[1].entity) ?? none} />}
          <Pair label="App version" a={version ? <span className="font-mono">{version}</span> : none} b={version ? <span className="font-mono">{version}</span> : none} />
          <Pair label="Device ID" a={device ? <span className="font-mono">{device}</span> : none} b={device ? <span className="font-mono">{device}</span> : none} />
        </DrawerSection>
      </>}
    </Drawer>
  );
}
