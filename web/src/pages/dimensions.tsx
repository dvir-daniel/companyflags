import { useEffect, useRef, useState } from 'react';
import { Button } from '@companyflags/ui/components/button';
import { Callout } from '@companyflags/ui/components/callout';
import { tableHeadClass, tableRowClass } from '@companyflags/ui/components/data-table';
import { Input } from '@companyflags/ui/components/input';
import { cn } from '@companyflags/ui/lib/utils';
import {
  api, capital, checkDimensions, count, joined, MAX_DIMENSIONS, one, PRESETS, suggestKey, title, type Dimension, type DimensionInfo,
} from '../api.ts';
import { useApp } from '../app.ts';
import { Empty, ErrorList, Heading } from '../ui.tsx';
import { useAsync } from '../uiKit.ts';

/*
 * Settings → Dimensions (docs/design/dimensions.md): what this installation serves config per, one chain from the top
 * down, at most four. Each dimension has the words people read (singular and plural) and a key, which rules store as an
 * attribute ("Store is …"), so it's fixed once the dimension has entries. A dimension is added at the top or the bottom
 * and removed while it's empty and no rule uses it; the server says so when it refuses. Admins change it, no approval,
 * recorded in History. Everyone else sees it.
 */

type Row = Dimension & { fresh: boolean; keyTouched: boolean; entities: number };
const rowOf = (d: DimensionInfo): Row => ({ key: d.key, singular: d.singular, plural: d.plural, fresh: false, keyTouched: true, entities: d.entities });
const blank = (): Row => ({ key: '', singular: '', plural: '', fresh: true, keyTouched: false, entities: 0 });
const same = (a: Dimension[], b: Dimension[]) => JSON.stringify(a.map(({ key, singular, plural }) => [key, singular, plural]))
  === JSON.stringify(b.map(({ key, singular, plural }) => [key, singular, plural]));

const COLS = 'grid grid-cols-[28px_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,auto)] max-md:grid-cols-[28px_minmax(0,1fr)_minmax(0,auto)]';
const MD = 'max-md:hidden';
const cell = 'h-[34px] text-13';

/** A few sentences with the words, so it's clear how they read before saving. */
function Preview({ dims }: { dims: Dimension[] }) {
  const named = dims.filter((d) => d.singular.trim() && d.plural.trim());
  if (named.length === 0) return null;
  const lines = [
    named.map((d) => count(d, 3)).join(' · '),
    ...named.map((d) => `${capital(d.singular)} is one of …`),
    ...(named.length > 1 ? [`${joined(named, 'or')} is one of … (exactly that one, not those under it)`] : []),
    ...named.slice(1).map((d, i) => `${title(d)} follow their ${one(named[i])} until they have settings of their own`),
    ...named.map((d) => `+ Add ${one(d)}`),
  ];
  return (
    <div className="grid gap-1 border border-grid px-5 py-3.5 text-13 text-ink-2 max-sm:px-4">
      <span className="text-xs font-medium text-ink-3">How it reads</span>
      {lines.map((l) => <span key={l}>{l}</span>)}
    </div>
  );
}

export function DimensionsSection({ admin, focus }: { admin: boolean; focus?: boolean }) {
  const { meta, reload, toast, setDirty } = useApp();
  const saved = meta.dimensions;
  const [rows, setRows] = useState<Row[]>(() => saved.map(rowOf));
  const [base, setBase] = useState(saved);
  // someone else's save brings new dimensions: start from them again unless there are edits here
  if (saved !== base) { setBase(saved); if (same(rows, base)) setRows(saved.map(rowOf)); }
  const edited = !same(rows, saved);
  const { busy, error, run } = useAsync();
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { if (focus) ref.current?.scrollIntoView({ block: 'start' }); }, [focus]);
  useEffect(() => { setDirty('dimensions', edited); return () => setDirty('dimensions', false); }, [edited, setDirty]);

  const problems = checkDimensions(rows);
  // until there's an entry, the only file an app can read is its service's file for everyone (the app-files plugin)
  const files = meta.plugins?.includes('app-files') ?? true;
  const until = files ? ' Until then, apps can read only the file for everyone (Services → Link).' : '';
  const set = (i: number, change: Partial<Row>) => setRows((rs) => rs.map((r, j) => {
    if (j !== i) return r;
    const next = { ...r, ...change };
    // a new dimension's key follows its singular until it's typed in
    if (next.fresh && !next.keyTouched && change.singular !== undefined) next.key = suggestKey(change.singular);
    return next;
  }));
  const add = (where: 'top' | 'bottom') => setRows((rs) => (where === 'top' ? [blank(), ...rs] : [...rs, blank()]));
  const remove = (i: number) => setRows((rs) => rs.filter((_, j) => j !== i));
  const preset = (dims: Dimension[]) => setRows(dims.map((d) => ({ ...d, fresh: true, keyTouched: true, entities: 0 })));
  const save = async () => {
    const r = await run(() => api<DimensionInfo[]>('PUT', '/dimensions', { dimensions: rows.map(({ key, singular, plural }) => ({ key, singular, plural })) }));
    if (!r) return;
    setRows(r.map(rowOf));
    try { await reload(); } catch (e) { toast(`Saved, but the console couldn’t refresh: ${(e as Error).message}`, 'err'); }
    toast(r.length ? `Saved: ${r.map((d) => title(d)).join(' › ')}` : 'Saved: no dimensions');
  };

  return (
    <section ref={ref} aria-labelledby="s-dims" className="grid scroll-mt-16 gap-3">
      <Heading id="s-dims" title="Dimensions" action={admin && rows.length > 0 && rows.length < MAX_DIMENSIONS && <Button variant="secondary" onClick={() => add('bottom')}>+ Add below</Button>}>
        What config is served per: one chain from the top down, at most {MAX_DIMENSIONS}. Each entry gets its own settings on every flag,
        its own app link and page, and follows the one above it until it has settings of its own. Rules check each dimension by its key.
      </Heading>
      {rows.length === 0 ? (
        admin ? (
          <div className="grid gap-3 border border-grid px-5 py-4 max-sm:px-4">
            <span className="text-13 text-ink-2">None yet. An app reads its flags with an entry’s app link (on the entry’s page), so add a dimension and one entry first.{until} Start from one of these, or make your own.</span>
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((p) => <Button key={p.name} variant="secondary" onClick={() => preset(p.dimensions)}>{p.name}</Button>)}
              <Button variant="secondary" onClick={() => add('top')}>Custom</Button>
            </div>
          </div>
        ) : <Empty>No dimensions yet. An app reads its flags with an entry’s app link, so an admin adds a dimension and one entry here first.{until}</Empty>
      ) : (
        <div role="table" aria-label="Dimensions">
          <div role="row" className={cn(COLS, tableHeadClass)}>
            <span role="columnheader"><span className="sr-only">Level</span></span>
            <span role="columnheader">Singular</span>
            <span role="columnheader" className={MD}>Plural</span>
            <span role="columnheader" className={MD}>Key</span>
            <span role="columnheader" className={MD}>Entries</span>
            <span />
          </div>
          {rows.map((r, i) => {
            const fixed = !r.fresh;   // a saved dimension keeps its key: rules store it
            return (
              <div key={i} role="row" className={cn(COLS, tableRowClass, 'items-center')}>
                <span role="cell" className="font-mono text-11 text-ink-3">{i === 0 ? 'Top' : `${i + 1}`}</span>
                <span role="cell" className="min-w-0">
                  {admin ? <Input className={cell} value={r.singular} placeholder="store" aria-label={`Dimension ${i + 1}: singular`}
                    onChange={(e) => set(i, { singular: e.target.value })} />
                    : <span className="text-13 font-medium">{capital(r.singular)}</span>}
                </span>
                <span role="cell" className={cn(MD, 'min-w-0')}>
                  {admin ? <Input className={cell} value={r.plural} placeholder="stores" aria-label={`Dimension ${i + 1}: plural`} onChange={(e) => set(i, { plural: e.target.value })} />
                    : <span className="text-13 text-ink-2">{capital(r.plural)}</span>}
                </span>
                <span role="cell" className={cn(MD, 'min-w-0')}>
                  {admin && !fixed ? <Input className={cn(cell, 'font-mono')} value={r.key} placeholder="store" aria-label={`Dimension ${i + 1}: key`}
                    onChange={(e) => set(i, { key: e.target.value, keyTouched: true })} />
                    : <code className="font-mono text-13 text-ink-2" title="Rules store this key, so it can’t change">{r.key}</code>}
                </span>
                <span role="cell" className={cn(MD, 'text-13 text-ink-2')}>{r.fresh ? <span className="text-ink-3">New</span> : r.entities.toLocaleString()}</span>
                <span role="cell" className="flex justify-end gap-2">
                  {admin && i === 0 && rows.length < MAX_DIMENSIONS && <Button variant="secondary" onClick={() => add('top')}>Add above</Button>}
                  {admin && <Button variant="secondary" disabled={r.entities > 0} title={r.entities > 0 ? 'Move or remove its entries first' : undefined}
                    aria-label={`Remove ${r.singular || `dimension ${i + 1}`}`} onClick={() => remove(i)}>Remove</Button>}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {admin && edited && problems.length > 0 && <Callout tone="warn" className="grid gap-1">{problems.map((p) => <span key={p}>{p}</span>)}</Callout>}
      {rows.length > 0 && <Preview dims={rows} />}
      <ErrorList error={error} />
      {admin && edited && (
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={busy || problems.length > 0} onClick={() => void save()}>{busy ? 'Saving…' : 'Save dimensions'}</Button>
          <Button variant="secondary" disabled={busy} onClick={() => setRows(saved.map(rowOf))}>Discard</Button>
          <span className="text-13 text-ink-3">Nothing apps get changes: entries and their settings come next.</span>
        </div>
      )}
    </section>
  );
}
