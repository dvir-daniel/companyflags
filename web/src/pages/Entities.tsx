import { useEffect, useRef, useState } from 'react';
import { ArrowUpIcon, CaretRightIcon } from '@phosphor-icons/react';
import { Button } from '@companyfeatures/ui/components/button';
import { BulkBar, ColumnHead, KeyHints, RowCheck, tableHeadClass, tableRowClass, useListKeys, useSelection } from '@companyfeatures/ui/components/data-table';
import { barTextButton, PageBar } from '@companyfeatures/ui/components/page-bar';
import { SearchField } from '@companyfeatures/ui/components/search-field';
import { Tabs } from '@companyfeatures/ui/components/tabs';
import { cn } from '@companyfeatures/ui/lib/utils';
import { above as dimAbove, api, ApiError, below, capital, count, entityIndex, getsWithoutOwn, many, one, peek, title } from '../api.ts';
import { CountSlot, SkeletonRows } from '../loading.tsx';
import { pagerRow } from '../loadingKit.ts';
import { dimensionListPath, entityHref, entityPath, pageEnv, preload } from '../paths.ts';
import { go, useApp } from '../app.ts';
import { downloadCsv } from '../csv.ts';
import { Empty, Pager, When } from '../ui.tsx';
import { type Paged, usePersistentState, useServerPage, useSlashFocus } from '../uiKit.ts';
import { ChildrenGrid } from './childrenGrid.tsx';
import { EntityTree } from './entityTree.tsx';
import { EntityDialog, EntityFlags, EntityHeader, LoadError, OwnCounts } from './entityParts.tsx';
import { aboveOf, countText, MD, selectedRow, toTop, type EntityRow, type Who } from './entityKit.ts';

/*
 * What config is served per, as dense console pages (the Flags pattern): a sticky page bar, a full-width table with
 * checkboxes, a bulk bar while rows are selected. Keyboard: / search, j/k move, x select, Enter open, Esc clear.
 *   #/dimensions/<dimension>                    its entities and how many flags each has its own settings on
 *                                               (the top dimension also has a Tree of everything under it)
 *   #/dimensions/<dimension>/<key>/<env>        every flag from that entity's point of view
 *   #/dimensions/<dimension>/<key>/<env>/children   it and the entities right under it, side by side
 */

/** checkbox, entity, the entity above, own settings, added, open */
const LIST_COLS = 'grid grid-cols-[28px_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_104px_20px] max-md:grid-cols-[28px_minmax(0,1fr)_112px_20px]';
const LIST_COLS_TOP = 'grid grid-cols-[28px_minmax(0,2fr)_minmax(0,1fr)_104px_20px] max-md:grid-cols-[28px_minmax(0,1fr)_112px_20px]';
/** an entity's row: its name, then its key (placeholder rows are as tall) */
const LIST_ROW = 'min-h-[53px]';

/** A dimension that isn't there (removed, or a mistyped address): the way to the dimensions. */
function NoDimension({ dimensionKey }: { dimensionKey: string }) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <PageBar title={dimensionKey} />
      <div className="px-6 py-10 max-sm:px-4">
        <Empty action={<Button variant="secondary" onClick={() => go('settings/dimensions')}>Open the dimensions</Button>}>
          There’s no dimension “{dimensionKey}”. Settings → Dimensions says what config is served per.
        </Empty>
      </div>
    </div>
  );
}

export function DimensionPage({ dimensionKey }: { dimensionKey: string }) {
  const { meta } = useApp();
  const dimension = meta.dimensions.find((d) => d.key === dimensionKey);
  // the top dimension's page has a Tree of everything under it too (kept as you left it)
  const [view, setView] = usePersistentState<'list' | 'tree'>('dimension.view', 'list');
  if (!dimension) return <NoDimension dimensionKey={dimensionKey} />;
  const isTop = meta.dimensions[0]?.key === dimension.key && meta.dimensions.length > 1;
  return <EntityList key={dimension.key} dimensionKey={dimension.key} view={isTop ? view : 'list'} onView={isTop ? setView : undefined} />;
}

function EntityList({ dimensionKey, view, onView }: { dimensionKey: string; view: 'list' | 'tree'; onView?: (v: 'list' | 'tree') => void }) {
  const { meta, revisionTick, toast } = useApp();
  const dimension = meta.dimensions.find((d) => d.key === dimensionKey)!;
  const up = dimAbove(meta.dimensions, dimension.key);
  const down = below(meta.dimensions, dimension.key);
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [tries, setTries] = useState(0);   // Try again reloads the same page
  const root = useRef<HTMLDivElement>(null);
  const n = q.trim().toLowerCase();
  const tree = view === 'tree';
  // one page of entities, searched on the server; the server lists them by name, A to Z
  const paging = useServerPage<Paged & { rows: EntityRow[] }>((page) => dimensionListPath(dimension.key, n, page), n, `${revisionTick}:${tries}`);
  const rows = paging.data?.rows ?? [];
  const sel = useSelection(rows.map((r) => r.key));
  // an entity opens as its page straight away; hovering a row loads it first (paths.ts), so it opens with its data
  const openEntity = (key: string) => go(entityHref(dimension.key, key).slice(2));
  const keys = useListKeys({
    count: tree ? 0 : rows.length,
    onOpen: (i) => openEntity(rows[i].key),
    onToggle: (i) => sel.toggle(rows[i].key),
    onClear: () => sel.clear(),
    enabled: !adding && !tree,
  });
  const search = useRef<HTMLInputElement>(null);
  useSlashFocus(search, !adding && !tree);
  const chosen = rows.filter((r) => sel.isSelected(r.key));
  const cols = up ? LIST_COLS : LIST_COLS_TOP;

  const turn = (p: number) => { paging.go(p); keys.setActive(-1); toTop(root.current); };
  const exportCsv = () => {
    const list = chosen.length ? chosen : rows;
    downloadCsv(`${dimension.key}.csv`, ['key', 'name', ...(up ? [up.key] : []), ...meta.environments.map((e) => `own_settings_${e.key}`), 'added_at'],
      list.map((c) => [c.key, c.name, ...(up ? [c.parent ?? ''] : []), ...meta.environments.map((e) => c.flagsWithSettings[e.key] ?? 0), c.createdAt]));
    toast(`Exported ${count(dimension, list.length)} to ${dimension.key}.csv`);
  };
  const env = pageEnv(meta);
  const emptyText = up ? `No ${many(dimension)} yet. Each one gets what its ${one(up)} gets on every flag until it has settings of its own.`
    : `No ${many(dimension)} yet. Each one you add ${getsWithoutOwn(null)} on every flag until it has settings of its own.`;

  return (
    <div ref={root} className="flex min-h-full flex-1 flex-col">
      <PageBar title={title(dimension)} count={<CountSlot text={paging.data ? countText(paging.data) : undefined} />}
        actions={<Button onClick={() => setAdding(true)}>+ Add {one(dimension)}</Button>}>
        {!tree && <>
          <SearchField ref={search} className="w-[240px] max-md:w-auto max-md:flex-1" placeholder="Search  /" value={q}
            onChange={(e) => setQ(e.target.value)} aria-label={`Search ${many(dimension)} by name or key`} />
          {q && <button type="button" onClick={() => setQ('')} className={barTextButton}>Reset</button>}
        </>}
      </PageBar>
      {onView && (
        <div className="px-6 max-sm:px-4">
          <Tabs<'list' | 'tree'> label={`${title(dimension)} views`} value={view} onChange={onView} className="border-b-0"
            items={[{ value: 'list', label: 'List' }, { value: 'tree', label: 'Tree' }]} />
        </div>
      )}

      {tree ? <EntityTree top={dimension} env={env} /> : <>
        <div role="table" aria-label={title(dimension)} aria-busy={paging.loading} className={cn('flex-1', paging.loading && 'opacity-70', onView && 'border-t border-rule')}>
          <div role="row" className={cn(cols, tableHeadClass)}>
            <span role="columnheader"><RowCheck checked={sel.all} indeterminate={sel.some} onChange={sel.toggleAll} label={`Select all ${many(dimension)} on this page`} /></span>
            <span role="columnheader" aria-sort="ascending" title="By name, A to Z" className="inline-flex items-center gap-1 text-ink">
              {capital(dimension.singular)}<ArrowUpIcon aria-hidden className="size-3" />
            </span>
            {up && <span role="columnheader" className={MD}>{capital(up.singular)}</span>}
            <span role="columnheader"><ColumnHead label="Own settings" help={`Settings that apply only to this ${one(dimension)}, counted per environment. With none, it ${up ? `gets what its ${one(up)} gets` : getsWithoutOwn(null)}.`} /></span>
            <span role="columnheader" className={MD}>Added</span>
            <span role="columnheader"><span className="sr-only">Open</span></span>
          </div>
          {paging.error ? <LoadError className="m-6 max-sm:m-4" busy={paging.loading} onRetry={() => setTries((t) => t + 1)}>Couldn’t load the {many(dimension)}: {paging.error}</LoadError>
            : !paging.data ? <SkeletonRows cols={cols} cells={up ? ['', '', MD, '', MD, ''] : ['', '', '', MD, '']} rowClass={LIST_ROW} />
            : rows.length === 0 ? (
              <div className="px-6 py-10 max-sm:px-4">
                <Empty action={n ? <Button variant="secondary" onClick={() => setQ('')}>Clear search</Button> : <Button onClick={() => setAdding(true)}>+ Add {one(dimension)}</Button>}>
                  {n ? `Nothing matches “${q.trim()}”.` : emptyText}
                </Empty>
              </div>
            ) : rows.map((c, i) => (
              <div key={c.key} role="row" data-row-index={i} data-active={keys.active === i} data-selected={sel.isSelected(c.key)}
                onClick={() => { keys.setActive(i); openEntity(c.key); }} onPointerEnter={() => { void preload(entityHref(dimension.key, c.key), meta); }}
                className={cn(cols, tableRowClass, LIST_ROW, selectedRow, 'cursor-default')}>
                <span role="cell"><RowCheck checked={sel.isSelected(c.key)} onChange={() => sel.toggle(c.key)} label={`Select ${c.name}`} /></span>
                <span role="cell" className="min-w-0">
                  <span className="block truncate text-13 font-medium">{c.name}</span>
                  <span className="block truncate font-mono text-11 text-ink-3">
                    {c.key}
                    {down && c.children > 0 && <span className="font-sans"> · {count(down, c.children)}</span>}
                  </span>
                </span>
                {up && (
                  <span role="cell" className={cn(MD, 'min-w-0 truncate text-13')}>
                    {c.parent ? <a href={entityHref(up.key, c.parent)} onClick={(e) => e.stopPropagation()} className="text-ink-2">{c.parentName ?? c.parent}</a>
                      : <span className="text-ink-3">None</span>}
                  </span>
                )}
                <span role="cell" className="min-w-0 truncate">
                  <OwnCounts counts={c.flagsWithSettings} who={{ key: c.key, name: c.name, above: c.parent ? [{ key: c.parent, name: c.parentName ?? c.parent }] : [] }} />
                </span>
                <span role="cell" className={MD}><When iso={c.createdAt} /></span>
                <span role="cell">
                  <a href={entityHref(dimension.key, c.key)} onClick={(e) => e.stopPropagation()} aria-label={`Open ${c.name}`}
                    className="inline-grid size-5 place-items-center text-ink-3 hover:text-ink">
                    <CaretRightIcon aria-hidden className="size-3.5" />
                  </a>
                </span>
              </div>
            ))}
        </div>

        <div className={cn('flex flex-wrap items-center gap-4 border-t border-rule px-6 max-sm:px-4', pagerRow)}>
          <KeyHints className="max-md:hidden" />
          <span className="flex-1" />
          {paging.data && <Pager page={paging.page} size={paging.size} matched={paging.data.matched} noun={many(dimension)} onPage={turn} />}
        </div>

        <BulkBar count={sel.count} onClear={sel.clear}>
          <Button variant="outline" onClick={exportCsv}>Export {count(dimension, sel.count)} as CSV</Button>
        </BulkBar>
      </>}

      {adding && <EntityDialog dimension={dimension} onClose={() => setAdding(false)} />}
    </div>
  );
}

/* ---------------------------------------------------------------- one entity */

// Another entity is another page: it starts fresh, so nothing from the one open before (its answer, an error, a
// selection) shows under this one. `view`: 'children' opens the tab of the entities under it.
export function EntityPage({ dimensionKey, entityKey, envKey, view }: { dimensionKey: string; entityKey: string; envKey?: string; view?: string }) {
  const { meta } = useApp();
  if (!meta.dimensions.some((d) => d.key === dimensionKey)) return <NoDimension dimensionKey={dimensionKey} />;
  return <OneEntity key={`${dimensionKey}/${entityKey}`} dimensionKey={dimensionKey} entityKey={entityKey} envKey={envKey} view={view} />;
}

function OneEntity({ dimensionKey, entityKey, envKey, view }: { dimensionKey: string; entityKey: string; envKey?: string; view?: string }) {
  const { meta, revisionTick } = useApp();
  const dimension = meta.dimensions.find((d) => d.key === dimensionKey)!;
  const childDimension = below(meta.dimensions, dimension.key);
  const children: Who[] = childDimension ? meta.entities.filter((c) => c.parent === entityKey).map((c) => ({ key: c.key, name: c.name, dimension: c.dimension, parent: c.parent })) : [];
  const showChildren = view === 'children' && !!childDimension && children.length > 0;
  // memory: the page opens the way you left it (the own-settings filter); the environment is the one last used
  // anywhere (Flags, a flag, an entity); the search starts empty
  const [lastEnv, setLastEnv] = usePersistentState('env', '');
  const env = pageEnv(meta, envKey);
  useEffect(() => { if (envKey && envKey !== lastEnv) setLastEnv(envKey); }, [envKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [editing, setEditing] = useState(false);
  const [tries, setTries] = useState(0);   // Try again reloads the header's facts
  const refreshFacts = () => setTries((t) => t + 1);
  // the header's facts: own settings in every environment, and when it was added (its one row: a 404 when there's
  // no such entity in this dimension)
  const path = entityPath(dimension.key, entityKey);
  const [info, setInfo] = useState<EntityRow | null>(() => peek<EntityRow>(path) ?? null);
  const [infoError, setInfoError] = useState<{ status: number | null; message: string } | null>(null);
  useEffect(() => {
    let live = true;
    api<EntityRow>('GET', path)
      .then((r) => { if (live) { setInfo(r); setInfoError(null); } })
      .catch((e: Error) => { if (live) setInfoError({ status: e instanceof ApiError ? e.status : null, message: e.message }); });
    return () => { live = false; };
  }, [path, revisionTick, tries]);

  if (infoError?.status === 404) {
    return (
      <div className="flex min-h-full flex-1 flex-col">
        <PageBar crumbs={<a href={`#/dimensions/${encodeURIComponent(dimension.key)}`} className="text-ink-3 no-underline hover:text-ink hover:no-underline">{title(dimension)}</a>} title={entityKey} />
        <div className="px-6 py-10 max-sm:px-4">
          <Empty action={<Button variant="secondary" onClick={() => go(`dimensions/${dimension.key}`)}>All {many(dimension)}</Button>}>
            Not found: there’s nothing with the key “{entityKey}” in {many(dimension)}. It may have been removed.
          </Empty>
        </div>
      </div>
    );
  }
  // the header draws at once from the entities the console already knows; the counts follow with its row
  const known = entityIndex(meta.entities).get(entityKey);
  const entity: Who = info ? { key: info.key, name: info.name, dimension: dimension.key, parent: info.parent }
    : { key: entityKey, name: known?.name ?? entityKey, dimension: dimension.key, parent: known?.parent };
  const above = aboveOf(meta, entityKey);

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <EntityHeader entity={entity} dimension={dimension} above={above} under={children} childDimension={childDimension} env={env}
        view={showChildren ? 'children' : undefined} counts={info?.flagsWithSettings} addedAt={info?.createdAt}
        countsFailed={!!infoError} onEdit={info ? () => setEditing(true) : undefined} />
      {infoError && <LoadError line className="mx-6 mb-3 max-sm:mx-4" busy={false} onRetry={refreshFacts}>
        <span title={infoError.message}>Couldn’t load {entity.name}’s own-settings counts: {infoError.message}</span>
      </LoadError>}
      {/* with entities under it: its flags, or it and them side by side */}
      {childDimension && children.length > 0 && (
        <div className="px-6 max-sm:px-4">
          <Tabs<'flags' | 'children'> label={`${entity.name}: sections`} value={showChildren ? 'children' : 'flags'}
            onChange={(v) => go(entityHref(dimension.key, entity.key, env, v === 'children' ? 'children' : undefined).slice(2))} className="border-b-0"
            items={[{ value: 'flags', label: 'Flags' }, { value: 'children', label: `${title(childDimension)} · ${children.length}` }]} />
        </div>
      )}
      {showChildren && childDimension ? <ChildrenGrid entity={entity} below={childDimension} env={env} />
        : <EntityFlags entity={entity} env={env} keysEnabled={!editing} onChanged={refreshFacts} />}
      {editing && info && <EntityDialog dimension={dimension} entity={entity} onClose={() => setEditing(false)} />}
    </div>
  );
}
