import { useState } from 'react';
import { Button } from '@companyflags/ui/components/button';
import { Callout } from '@companyflags/ui/components/callout';
import { ColumnHead, tableHeadClass, tableRowClass } from '@companyflags/ui/components/data-table';
import { SkeletonRows } from '../loading.tsx';
import { pagerRow } from '../loadingKit.ts';
import { barTextButton, FilterSelect, PageBar } from '@companyflags/ui/components/page-bar';
import { SearchField } from '@companyflags/ui/components/search-field';
import { cn } from '@companyflags/ui/lib/utils';
import { fmtValue, many, one, type Dimension, type Section } from '../api.ts';
import { useApp } from '../app.ts';
import { childrenGridPath, entityHref } from '../paths.ts';
import { plural } from '../text.ts';
import { Empty, InAppDefault, Pager, Val } from '../ui.tsx';
import { type Paged, useServerPage } from '../uiKit.ts';
import { useEnvs } from './envs.ts';

/*
 * An entity and the entities right under it side by side (like Salesforce's account hierarchy): one row per flag, one
 * column for the entity and one per entity under it, with what each gets. A cell below is marked where it differs from
 * the entity, and "own" where it has settings of its own. #/dimensions/<dimension>/<key>/<env>/children
 */

type Who = { key: string; name: string; dimension: string };
type Cell = { variant: string; value: unknown; codeDefault: boolean; section: Section; cases: number; own: boolean };
type GridRow = { key: string; description: string | null; valueType: string; enabled: boolean; cells: Record<string, Cell>; differs: string[] };
type Grid = Paged & { entity: Who; children: Who[]; environment: string; differing: number; rows: GridRow[] };

// `below`: the dimension of the entities under it
export function ChildrenGrid({ entity, below, env }: { entity: Who; below: Dimension; env: string }) {
  const { revisionTick } = useApp();
  const { envName } = useEnvs();
  const [q, setQ] = useState('');
  const [show, setShow] = useState<'all' | 'diff'>('all');
  const [tries, setTries] = useState(0);
  const n = q.trim().toLowerCase();
  const paging = useServerPage<Grid>((page) => childrenGridPath(entity.dimension, entity.key, env, show === 'diff', n, page),
    `${n}|${show}|${env}|${entity.key}`, `${revisionTick}:${tries}`);
  const data = paging.data;
  const children = data?.children ?? [];
  // the flag column, the entity, then each one under it; a wide one scrolls sideways with the flag column kept in view
  const cols = { gridTemplateColumns: `minmax(200px, 1.3fr) repeat(${children.length + 1}, minmax(150px, 1fr))` };
  const where = envName(env).toLowerCase();
  const reset = () => { setQ(''); setShow('all'); };

  return (
    <>
      <PageBar className="border-t">
        <SearchField className="w-[240px] max-md:w-auto max-md:flex-1 max-md:basis-full" placeholder="Search flags" value={q}
          onChange={(e) => setQ(e.target.value)} aria-label="Search flags" />
        <FilterSelect label="Show" value={show} onChange={setShow} options={[['all', 'All flags'], ['diff', `Only where some ${many(below)} differ`]]} />
        {(n || show !== 'all') && <button type="button" onClick={reset} className={barTextButton}>Reset</button>}
        <span className="ml-auto text-13 text-ink-3 max-md:hidden">
          {data ? (data.differing ? `${plural(data.differing, 'flag')} in ${where} where some ${many(below)} differ from ${entity.name}` : `Every ${one(below)} gets what ${entity.name} gets in ${where}`) : null}
        </span>
      </PageBar>

      {paging.error && (
        <Callout tone="error" role="alert" className="mx-6 mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 max-sm:mx-4">
          <span className="min-w-0 flex-1">Couldn’t load the {many(below)}: {paging.error}</span>
          <Button variant="secondary" onClick={() => setTries((x) => x + 1)}>Try again</Button>
        </Callout>
      )}
      <div className="flex-1 overflow-x-auto">
        <div role="table" aria-label={`${entity.name} and its ${many(below)}`} aria-busy={paging.loading} className={cn('min-w-max', paging.loading && 'opacity-70')}>
          {/* inside the sideways-scrolling box the header can't stick under the page bar, so it sits at the top of the grid */}
          <div role="row" className={cn('grid', tableHeadClass, '[--page-bar-h:0px]')} style={cols}>
            <span role="columnheader" className="sticky left-0 z-10 bg-panel">Flag</span>
            <ColumnHead label={entity.name} help={`What ${entity.name} itself gets. Its ${many(below)} get the same unless they have settings of their own.`} />
            {children.map((b) => <span key={b.key} role="columnheader"><a href={entityHref(b.dimension, b.key, env)} className="text-inherit">{b.name}</a></span>)}
          </div>
          {!data ? <SkeletonRows cols="grid" style={cols} cells={['', '', ...children.map(() => '')]} rowClass="min-h-14" />
            : data.rows.length === 0 ? (
              <div className="px-6 py-10 max-sm:px-4">
                <Empty action={n || show !== 'all' ? <Button variant="secondary" onClick={reset}>Show all flags</Button> : undefined}>
                  {show === 'diff' ? `None of the ${many(below)} differ from ${entity.name}${n ? ' on flags matching this search' : ''} in ${where}.` : n ? `No flag matches “${q.trim()}”.` : 'No flags yet.'}
                </Empty>
              </div>
            ) : data.rows.map((r) => (
              <div key={r.key} role="row" className={cn('grid', tableRowClass, 'cursor-default items-start')} style={cols}>
                <span role="cell" className="sticky left-0 z-10 min-w-0 bg-background">
                  <a href={`#/flag/${r.key}/${env}`} className="block truncate font-mono text-13 font-medium text-ink">{r.key}</a>
                  {r.description && <span className="block truncate text-ink-3">{r.description}</span>}
                </span>
                <GridCell role="cell" cell={r.cells[entity.key]} />
                {/* the cell holds the link (a link with role="cell" would stop being a link) */}
                {children.map((b) => (
                  <span key={b.key} role="cell" className="min-w-0">
                    <a href={entityHref(b.dimension, b.key, env)} title={`Open ${b.name}`}
                      className={cn('-my-1 block min-w-0 px-2 py-1 text-ink no-underline hover:no-underline', r.differs.includes(b.key) ? 'bg-wash' : '')}>
                      <GridCell cell={r.cells[b.key]} differs={r.differs.includes(b.key)} />
                    </a>
                  </span>
                ))}
              </div>
            ))}
        </div>
      </div>

      <div className={cn('flex flex-wrap items-center gap-4 border-t border-rule px-6 max-sm:px-4', pagerRow)}>
        <span className="py-2.5 text-13 text-ink-3">Shaded: it gets something else than {entity.name}. <b className="font-medium text-ink-2">Own</b>: it has settings of its own.</span>
        <span className="flex-1" />
        {data && <Pager page={paging.page} size={paging.size} matched={data.matched} noun="flags" onPage={paging.go} />}
      </div>
    </>
  );
}

/** What one entity gets for a flag. `role="cell"` when it is the cell itself (the entity's); one under it sits in a link. */
function GridCell({ cell, differs, role }: { cell?: Cell; differs?: boolean; role?: 'cell' }) {
  if (!cell) return <span role={role} />;
  const value = cell.section === 'not_sent' ? <span className="text-ink-3">Not sent</span>
    : cell.codeDefault ? <InAppDefault />
    : <Val className={cn('min-w-0', differs ? 'font-medium' : 'text-ink-2')} title={fmtValue(cell.value)}>{fmtValue(cell.value)}</Val>;
  return (
    <span role={role} className="flex min-w-0 flex-col gap-0.5">
      <span className="min-w-0 truncate">{value}</span>
      {(cell.own || cell.cases > 0) && (
        <span className="text-xs text-ink-3">
          {cell.own && <b className="font-medium text-ink-2">Own</b>}
          {cell.own && cell.cases > 0 && ' · '}
          {cell.cases > 0 && `+${plural(cell.cases, 'case')} by request`}
        </span>
      )}
    </span>
  );
}
