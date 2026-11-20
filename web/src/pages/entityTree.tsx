import { useEffect, useState } from 'react';
import { CaretDownIcon, CaretRightIcon } from '@phosphor-icons/react';
import { Button } from '@companyflags/ui/components/button';
import { Callout } from '@companyflags/ui/components/callout';
import { tableHeadClass, tableRowClass } from '@companyflags/ui/components/data-table';
import { cn } from '@companyflags/ui/lib/utils';
import { api, below, capital, count, one, type Dimension } from '../api.ts';
import { useApp } from '../app.ts';
import { entityHref, treeLevelPath } from '../paths.ts';
import { Empty } from '../ui.tsx';
import { SkeletonRows } from '../loading.tsx';
import type { EntityRow } from './entityKit.ts';
import { useEnvs } from './envs.ts';

/*
 * Every entity with those under it, from the top dimension down (#/dimensions/<top>, the Tree view). Each level loads
 * when it's opened (GET /dimensions/<dimension below>?parent=<key>), so a tree of 100,000 stores stays quick. Entities
 * of a lower dimension that have no parent come after the top's, under their own heading.
 */

const COLS = 'grid grid-cols-[minmax(0,2fr)_minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,0.8fr)] max-md:grid-cols-[minmax(0,1fr)_minmax(0,auto)]';
const MD = 'max-md:hidden';

type Loaded = { rows: EntityRow[] | null; error: string | null };

/** One level of the tree, as the server lists it (all of it: a level under one entity is short). */
function useLevel(dimension: string, parent: string, open: boolean, tick: number): Loaded & { retry: () => void } {
  const [got, setGot] = useState<Loaded>({ rows: null, error: null });
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (!open) return;
    let live = true;
    api<EntityRow[]>('GET', treeLevelPath(dimension, parent))
      .then((rows) => { if (live) setGot({ rows, error: null }); }, (e: Error) => { if (live) setGot({ rows: null, error: e.message }); });
    return () => { live = false; };
  }, [dimension, parent, open, tick, tries]);
  return { ...got, retry: () => setTries((t) => t + 1) };
}

export function EntityTree({ top, env }: { top: Dimension; env: string }) {
  const { meta, revisionTick } = useApp();
  const roots = useLevel(top.key, '', true, revisionTick);
  // lower dimensions with entities that have no parent: listed after the top's, each under its own heading
  const orphans = meta.dimensions.slice(1).filter((d) => d.entities > d.withParent);
  return (
    <div role="table" aria-label={`${capital(top.plural)} and everything under them`} className="flex-1">
      <div role="row" className={cn(COLS, tableHeadClass)}>
        <span role="columnheader">Name</span>
        <span role="columnheader" className={MD}>Dimension</span>
        <span role="columnheader">Under it</span>
        <span role="columnheader" className={MD}>Own settings</span>
      </div>
      <Level dimension={top} loaded={roots} depth={0} env={env} empty={`No ${top.plural} yet.`} />
      {orphans.map((d) => <Orphans key={d.key} dimension={d} env={env} />)}
    </div>
  );
}

function Orphans({ dimension, env }: { dimension: Dimension; env: string }) {
  const { meta, revisionTick } = useApp();
  const loaded = useLevel(dimension.key, '', true, revisionTick);
  const idx = meta.dimensions.findIndex((d) => d.key === dimension.key);
  const parent = idx > 0 ? meta.dimensions[idx - 1] : null;
  return (
    <>
      <div className="border-b border-grid px-6 pt-5 pb-2 text-13 font-medium text-ink-2 max-sm:px-4">
        {capital(dimension.plural)} with no {parent ? one(parent) : 'parent'}
      </div>
      <Level dimension={dimension} loaded={loaded} depth={0} env={env} empty="None." />
    </>
  );
}

function Level({ dimension, loaded, depth, env, empty }: { dimension: Dimension; loaded: Loaded & { retry: () => void }; depth: number; env: string; empty: string }) {
  if (loaded.error) {
    return (
      <Callout tone="error" role="alert" className="mx-6 my-2 flex flex-wrap items-center gap-x-4 gap-y-2 max-sm:mx-4" style={{ marginLeft: 24 + depth * 20 }}>
        <span className="min-w-0 flex-1">Couldn’t load the {dimension.plural}: {loaded.error}</span>
        <Button variant="secondary" onClick={loaded.retry}>Try again</Button>
      </Callout>
    );
  }
  if (!loaded.rows) return depth === 0 ? <SkeletonRows cols={COLS} cells={['', MD, '', MD]} rows={6} rowClass="min-h-11" /> : <div className="h-11" aria-busy />;
  if (loaded.rows.length === 0) return depth === 0 ? <div className="px-6 py-8 max-sm:px-4"><Empty>{empty}</Empty></div> : null;
  return <>{loaded.rows.map((r) => <Node key={r.key} row={r} dimension={dimension} depth={depth} env={env} />)}</>;
}

function Node({ row, dimension, depth, env }: { row: EntityRow; dimension: Dimension; depth: number; env: string }) {
  const { meta, revisionTick } = useApp();
  const { envName } = useEnvs();
  const [open, setOpen] = useState(false);
  const next = below(meta.dimensions, dimension.key);
  const kids = useLevel(next?.key ?? dimension.key, row.key, open && !!next, revisionTick);
  // flags with own settings, per environment: "2 in development, 1 in production"
  const own = meta.environments.filter((e) => row.flagsWithSettings?.[e.key])
    .map((e) => `${row.flagsWithSettings[e.key].toLocaleString()} in ${envName(e.key).toLowerCase()}`).join(', ');
  const canOpen = !!next && row.children > 0;
  return (
    <>
      <div role="row" className={cn(COLS, tableRowClass, 'min-h-11 cursor-default items-center')}>
        <span role="cell" className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: depth * 20 }}>
          {canOpen ? (
            <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={`What's under ${row.name}`}
              className="inline-grid size-6 shrink-0 cursor-default place-items-center border-0 bg-transparent text-ink-3 hover:bg-wash hover:text-ink">
              {open ? <CaretDownIcon aria-hidden className="size-3.5" /> : <CaretRightIcon aria-hidden className="size-3.5" />}
            </button>
          ) : <span className="size-6 shrink-0" />}
          <a href={entityHref(dimension.key, row.key, env)} className="min-w-0 truncate text-13 font-medium text-ink">{row.name}</a>
          <span className="truncate font-mono text-11 text-ink-3 max-sm:hidden">{row.key}</span>
        </span>
        <span role="cell" className={cn(MD, 'truncate text-13 text-ink-3')}>{capital(dimension.singular)}</span>
        <span role="cell" className="truncate text-13 text-ink-2">{next ? (row.children ? count(next, row.children) : <span className="text-ink-3">None</span>) : <span className="text-ink-3">—</span>}</span>
        <span role="cell" className={cn(MD, 'truncate text-13', own ? 'text-ink-2' : 'text-ink-3')}>{own || 'None'}</span>
      </div>
      {open && next && <Level dimension={next} loaded={kids} depth={depth + 1} env={env} empty="" />}
    </>
  );
}
