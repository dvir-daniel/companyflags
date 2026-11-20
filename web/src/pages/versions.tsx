// The Flags page's Versions and Conditions tabs (Google style). Every publish is a numbered version of an
// environment; any earlier one can be restored, as a new version, so rolling back is itself reversible.
// Restore undoes flag settings only: changes of other kinds (an entity moved, delivery, variants) are marked
// "not rolled back by restore", and a restore lists the ones it left as they are.
import { useEffect, useState } from 'react';
import { Button } from '@companyflags/ui/components/button';
import { Callout } from '@companyflags/ui/components/callout';
import { ColumnHead, KeyHints, tableHeadClass, tableRowClass, useListKeys } from '@companyflags/ui/components/data-table';
import { Drawer, DrawerRow, DrawerSection } from '@companyflags/ui/components/drawer';
import { cn } from '@companyflags/ui/lib/utils';
import { api, conditionText, entityIndex, vocabOf } from '../api.ts';
import { go, useApp } from '../app.ts';
import { plural } from '../text.ts';
import { Badge, Empty, PAGE_SIZE, Pager, When } from '../ui.tsx';
import { type Paged, useServerPage } from '../uiKit.ts';
import { Bone, SkeletonRows } from '../loading.tsx';
import { pagerRow } from '../loadingKit.ts';
import { LayerDiff } from './Approvals.tsx';
import { type SaveResult } from './flagParts.tsx';
import { useEnvs } from './envs.ts';
/** "a, b and 3 more" */
const some = (xs: string[], n = 3) => (xs.length <= n ? xs.join(', ') : `${xs.slice(0, n).join(', ')} and ${xs.length - n} more`);

type VersionRow = {
  revision: number; at: string; by: string[]; comment: string | null; changeSetId: number | null;
  changes: number; flags: string[]; kinds: string[]; emergency: boolean;
  notRolledBack: number;              // how many of its changes a restore doesn't undo
};
/** A later change a restore left as it is, in words ("Acme 12 moved out of Acme"). */
type NotRolledBack = { revision: number; kind: string; flag: string | null; entity: string | null; text: string };
const NOT_ROLLED_BACK = 'not rolled back by restore';
const RESTORE_ONLY = 'Restore undoes flag settings only: changes of other kinds stay as they are.';
type HistoryRow = { id: number; changeType: string; flag: string | null; entity: string | null; before: any; after: any; changedBy: string; comment: string | null };

const KIND_TEXT: Record<string, string> = {
  'layer.update': 'Changed settings', 'layer.create': 'Added settings', 'layer.delete': 'Removed settings',
  'flag.create': 'Created the flag', 'flag.archive': 'Archived the flag', 'flag.update': 'Changed the details', 'delivery.update': 'Changed its flag sets',
  'variations.update': 'Changed the variants', 'flag.meta': 'Changed the details',
  'entity.create': 'Added an entry', 'entity.update': 'Changed an entry', 'entity.link_replaced': 'Replaced an app link',
  // from before dimensions
  'customer.create': 'Added an entry', 'customer.update': 'Changed an entry', 'customer.link_replaced': 'Replaced an app link',
  'dimensions.update': 'Changed the dimensions',
  'environment.create': 'Added the environment',
};
const kindText = (k: string) => KIND_TEXT[k] ?? k.replace(/[._]/g, ' ');

/* ---------------------------------------------------------------- versions */

/** The main cell's button: the row's way in for the keyboard and screen readers (the row itself takes clicks too). */
const openButton = 'cursor-default border-0 bg-transparent p-0 text-left text-inherit';
const VCOLS = 'grid grid-cols-[92px_110px_minmax(0,0.8fr)_minmax(0,2fr)_minmax(0,1.5fr)_150px] max-xl:grid-cols-[92px_110px_minmax(0,0.8fr)_minmax(0,2fr)_150px] max-md:grid-cols-[72px_minmax(0,1fr)_110px]';
/** a version's row: what changed, then how many changes (placeholder rows are as tall) */
const VROW = 'min-h-[55px]';

export function VersionsTab({ env }: { env: string }) {
  const { revisionTick, toast, ask, reload } = useApp();
  const { envName, isProtected } = useEnvs();
  const [tries, setTries] = useState(0);
  const paging = useServerPage<Paged & { rows: VersionRow[]; current: number; restorable: string[] }>((page) => `/environments/${env}/versions?page=${page}&size=${PAGE_SIZE}`,
    env, `${revisionTick}:${tries}`);
  const [open, setOpen] = useState<VersionRow | null>(null);
  const rows = paging.data?.rows ?? [];
  const current = paging.data?.current ?? 0;
  const restorable = paging.data?.restorable ?? [];
  const where = envName(env).toLowerCase();
  const reviewed = isProtected(env);
  // j/k move, Enter opens the version, like the other lists
  const keys = useListKeys({ count: rows.length, onOpen: (i) => setOpen(rows[i]), enabled: !open });

  // forgiveness: rolling back is saved as a new version, so it can be undone the same way
  const rollBack = async (v: VersionRow) => {
    const r = await ask({
      title: `Roll ${where} back to version ${v.revision}?`,
      body: <>
        <RollbackPreview env={env} revision={v.revision} />
        <p className="text-ink-3">It’s saved as a new version, so you can roll forward again the same way.{reviewed && ' An approver reviews it first.'}</p>
      </>,
      reason: { label: reviewed ? 'Why? (required)' : 'Why? (optional)', placeholder: `INC-123: errors after version ${current}` },
      actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'go', label: reviewed ? 'Request review' : `Roll back to version ${v.revision}`, tone: 'danger', needsReason: reviewed }],
    });
    if (r.action !== 'go') return;
    try {
      const res = await api<SaveResult & { restored: number; notRolledBack?: NotRolledBack[] }>('POST', `/environments/${env}/versions/${v.revision}/restore`, { reason: r.reason || undefined });
      // the later changes it left as they are, e.g. "Lumen moved out of Globex — not rolled back"
      const left = res.notRolledBack?.length ? `. ${some(res.notRolledBack.map((n) => n.text))} — not rolled back` : '';
      if (res.applied) toast(`Rolled ${where} back to version ${v.revision} (${plural(res.restored, 'setting')}) as version ${res.revision}${left}`);
      else toast(`Sent rolling ${where} back to version ${v.revision} for review (request #${res.changeSetId})${left}`, 'ok', { label: 'View', onClick: () => go(`approvals/${res.changeSetId}`) });
      setOpen(null);
      reload().catch(() => {});
    } catch (e) { toast(`Couldn’t roll back: ${(e as Error).message}`, 'err'); }
  };

  return (
    <>
      <div role="table" aria-label={`Versions of ${where}`} aria-busy={paging.loading} className={cn('flex-1 transition-opacity duration-150', paging.loading && paging.data && 'opacity-70')}>
        <div role="row" className={cn(VCOLS, tableHeadClass)}>
          <span>Version</span><span className="max-md:hidden">Published</span><span className="max-md:hidden">By</span>
          <span>What changed</span><ColumnHead className="max-xl:hidden" label="Note" help="The note or reason given when it was published." /><span />
        </div>
        {paging.error ? <Callout tone="error" role="alert" className="m-6 max-sm:m-4">Couldn’t load the versions: {paging.error} <Button variant="secondary" className="ml-2" onClick={() => setTries((t) => t + 1)}>Try again</Button></Callout>
          : !paging.data ? <SkeletonRows cols={VCOLS} cells={['', 'max-md:hidden', 'max-md:hidden', '', 'max-xl:hidden', '']} rowClass={VROW} />
          : rows.length === 0 ? <div className="px-6 py-10 max-sm:px-4"><Empty>No versions yet. Publishing your first change in {where} creates version 1.</Empty></div>
          : rows.map((v, i) => (
            <div key={v.revision} role="row" data-row-index={i} data-active={keys.active === i} onClick={() => { keys.setActive(i); setOpen(v); }}
              className={cn(VCOLS, tableRowClass, VROW, 'cursor-default')}>
              <span role="cell" className="flex items-center gap-2">
                <button type="button" className={cn(openButton, 'font-mono text-13 font-medium')} aria-haspopup="dialog" aria-label={`Version ${v.revision}`}
                  onClick={(e) => { e.stopPropagation(); keys.setActive(i); setOpen(v); }}>v{v.revision}</button>
                {v.revision === current && <span className="inline-flex items-center gap-1.5 text-xs text-ink-2"><span aria-hidden className="size-[7px] bg-ok" />Live</span>}
              </span>
              <span role="cell" className="max-md:hidden"><When iso={v.at} /></span>
              <span role="cell" className="truncate text-ink-2 max-md:hidden">{v.by.join(', ')}{v.emergency && <> <Badge kind="danger">emergency</Badge></>}</span>
              <span role="cell" className="min-w-0">
                <span className="block truncate">{v.flags.length ? some(v.flags) : kindText(v.kinds[0] ?? '')}</span>
                <span className="block truncate text-xs text-ink-3">{plural(v.changes, 'change')}{v.changeSetId ? ` · request #${v.changeSetId}` : ''}
                  {v.notRolledBack > 0 && <span title={RESTORE_ONLY}> · {v.notRolledBack === v.changes ? NOT_ROLLED_BACK : `${v.notRolledBack.toLocaleString()} ${NOT_ROLLED_BACK}`}</span>}</span>
              </span>
              <span role="cell" className="truncate text-ink-2 max-xl:hidden" title={v.comment ?? undefined}>{v.comment?.split('\n')[0] || <span className="text-ink-3">—</span>}</span>
              <span role="cell" className="flex justify-end" onClick={(e) => e.stopPropagation()}>
                {v.revision < current && <Button variant="outline" className="h-8 px-3 font-sans text-13 font-medium normal-case tracking-normal" onClick={() => rollBack(v)}>Roll back to this</Button>}
              </span>
            </div>
          ))}
      </div>
      {(paging.data || !paging.error) && (
        <div className={cn('flex flex-wrap items-center gap-4 border-t border-rule px-6 max-sm:px-4', pagerRow)}>
          <KeyHints hide={['select', 'search']} className="max-md:hidden" />
          <span className="flex-1" />
          {paging.data && <Pager page={paging.page} size={paging.size} matched={paging.data.matched} noun="versions" onPage={(p) => { paging.go(p); keys.setActive(-1); }} />}
        </div>
      )}
      <VersionDrawer env={env} v={open} current={current} restorable={restorable} onClose={() => setOpen(null)} onRollBack={rollBack} />
    </>
  );
}

/** What a restore to `revision` would do, from the server (restore-preview: it counts every later version, not just
 *  the page shown): " (3 versions, touching a, b and 1 more)", "…" while it loads; and the later changes of other kinds
 *  it leaves as they are (restore undoes flag settings only: server/journal.ts). */
type RestorePreview = { versions: number; flags: string[]; notRolledBack?: NotRolledBack[] };
function RollbackPreview({ env, revision }: { env: string; revision: number }) {
  const [preview, setPreview] = useState<RestorePreview | 'failed' | null>(null);
  useEffect(() => {
    let live = true;
    api<RestorePreview>('GET', `/environments/${encodeURIComponent(env)}/versions/${revision}/restore-preview`)
      .then((p) => { if (live) setPreview(p); }, () => { if (live) setPreview('failed'); });
    return () => { live = false; };
  }, [env, revision]);
  const scope = preview === null ? <span aria-busy="true"> (…)</span>
    : preview === 'failed' || !preview.versions ? null
    : <> ({plural(preview.versions, 'version')}{preview.flags.length ? <>, touching {some(preview.flags)}</> : null})</>;
  const kept = preview && preview !== 'failed' ? preview.notRolledBack ?? [] : [];
  return <>
    <p>Every flag setting changed after version {revision} goes back to how it was then{scope}.</p>
    {kept.length > 0 && <p>{plural(kept.length, 'later change')} of other kinds ({some(kept.map((n) => n.text))}) {kept.length === 1 ? 'stays' : 'stay'} as {kept.length === 1 ? 'it is' : 'they are'}: restore undoes flag settings only.</p>}
  </>;
}

/** One version: everything it changed, before and after. */
function VersionDrawer({ env, v, current, restorable, onClose, onRollBack }: {
  env: string; v: VersionRow | null; current: number; restorable: string[]; onClose: () => void; onRollBack: (v: VersionRow) => void;
}) {
  const { meta } = useApp();
  const { envName } = useEnvs();
  // the changes of the version shown; another version's (still on screen while this one loads) are never shown
  const revision = v?.revision;
  const shownFor = `${env}:${revision}`;
  const [loaded, setLoaded] = useState<{ for: string; rows: HistoryRow[] } | { for: string; err: string } | null>(null);
  useEffect(() => {
    if (revision === undefined) return;
    let live = true;
    const key = `${env}:${revision}`;
    api<HistoryRow[]>('GET', `/history?environment=${encodeURIComponent(env)}&revision=${revision}`)
      .then((r) => { if (live) setLoaded({ for: key, rows: r }); }, (e) => { if (live) setLoaded({ for: key, err: e.message }); });
    return () => { live = false; };
  }, [env, revision]);
  const mine = loaded?.for === shownFor ? loaded : null;
  const rows = mine && 'rows' in mine ? mine.rows : null;
  const err = mine && 'err' in mine ? mine.err : null;
  const nameOf = (k: string) => entityIndex(meta.entities).get(k)?.name ?? k;
  return (
    <Drawer open={!!v} onClose={onClose} width={680}
      title={v ? `Version ${v.revision} of ${envName(env).toLowerCase()}` : ''}
      subtitle={v ? <>Published <When iso={v.at} className="text-13 text-ink-2" /> by {v.by.join(', ')}{v.revision === current ? ' · live now' : ''}</> : undefined}
      footer={v && (v.revision < current || v.changeSetId) ? <>
        {v.revision < current && <Button variant="stop" onClick={() => onRollBack(v)}>Roll back to this version</Button>}
        {v.changeSetId && <Button variant="secondary" onClick={() => { onClose(); go(`approvals/${v.changeSetId}`); }}>Open request #{v.changeSetId}</Button>}
      </> : undefined}>
      {v?.comment && <DrawerSection title="Note"><p className="m-0 text-13 whitespace-pre-line text-ink-1 [overflow-wrap:anywhere]">{v.comment}</p></DrawerSection>}
      <DrawerSection title={rows ? plural(rows.length, 'change') : 'Changes'}>
        {err ? <Callout tone="error">Couldn’t load this version: {err}</Callout>
          : !rows ? <div aria-hidden className="grid gap-3 py-3"><Bone className="w-2/3" /><Bone className="w-1/2" /><Bone className="w-3/5" /></div>
          : rows.map((h) => (
            <div key={h.id} className="border-b border-grid py-3 last:border-b-0">
              <DrawerRow label={kindText(h.changeType)}>
                {h.flag ? <a href={`#/flag/${h.flag}/${env}`} onClick={onClose} className="font-mono text-ink">{h.flag}</a> : '—'}
                {h.entity && <span className="text-ink-2"> · {nameOf(h.entity)}</span>}
                {!restorable.includes(h.changeType) && <> <Badge title={RESTORE_ONLY}>{NOT_ROLLED_BACK}</Badge></>}
              </DrawerRow>
              {h.changeType.startsWith('layer.') && <div className="mt-2"><LayerDiff before={h.before} after={h.after} entity={h.entity} /></div>}
            </div>
          ))}
      </DrawerSection>
    </Drawer>
  );
}

/* ---------------------------------------------------------------- conditions */

type ConditionRow = { condition: any; flags: number; rules: number; examples: string[] };
const CCOLS = 'grid grid-cols-[minmax(0,2fr)_90px_90px_minmax(0,2fr)] max-md:grid-cols-[minmax(0,1fr)_70px]';

export function ConditionsTab({ env }: { env: string }) {
  const { meta, revisionTick } = useApp();
  const { envName } = useEnvs();
  const [tries, setTries] = useState(0);
  // each answer says which request it answers: another environment's rows are never shown as this one's (a skeleton
  // until this one's arrive), and a refresh of the same environment keeps its rows, dimmed, until the new ones come
  const request = `${env}:${revisionTick}:${tries}`;
  const [data, setData] = useState<{ env: string; request: string; rows: ConditionRow[] } | null>(null);
  const [failed, setFailed] = useState<{ request: string; message: string } | null>(null);
  useEffect(() => {
    let live = true;
    const asked = `${env}:${revisionTick}:${tries}`;
    api<ConditionRow[]>('GET', `/environments/${encodeURIComponent(env)}/conditions`)
      .then((r) => { if (live) setData({ env, request: asked, rows: r }); }, (e) => { if (live) setFailed({ request: asked, message: e.message }); });
    return () => { live = false; };
  }, [env, revisionTick, tries]);
  const rows = data?.env === env ? data.rows : null;
  const err = failed?.request === request ? failed.message : null;
  const loading = data?.request !== request && !err;
  const vocab = vocabOf(meta);
  const where = envName(env).toLowerCase();
  return (
    <div role="table" aria-label={`Conditions used in ${where}`} aria-busy={loading} className={cn('flex-1 transition-opacity duration-150', loading && rows && 'opacity-70')}>
      <div role="row" className={cn(CCOLS, tableHeadClass)}>
        <ColumnHead label="Condition" help="Who a rule is for. Rules in this environment use these conditions; the same condition used in several flags shows once." />
        <span>Flags</span><span className="max-md:hidden">Rules</span><span className="max-md:hidden">Used by</span>
      </div>
      {err ? <Callout tone="error" role="alert" className="m-6 max-sm:m-4">Couldn’t load the conditions: {err} <Button variant="secondary" className="ml-2" onClick={() => setTries((t) => t + 1)}>Try again</Button></Callout>
        : !rows ? <SkeletonRows cols={CCOLS} cells={['', '', 'max-md:hidden', 'max-md:hidden']} />
        : rows.length === 0 ? <div className="px-6 py-10 max-sm:px-4"><Empty>No rule in {where} uses a condition yet. Rules with conditions appear here once they’re published.</Empty></div>
        : rows.map((c) => (
          <div key={JSON.stringify(c.condition)} role="row" className={cn(CCOLS, tableRowClass)}>
            <span role="cell" className="min-w-0 [overflow-wrap:anywhere]">{conditionText(c.condition, vocab)}</span>
            <span role="cell" className="font-mono text-13">{c.flags.toLocaleString()}</span>
            <span role="cell" className="font-mono text-13 text-ink-2 max-md:hidden">{c.rules.toLocaleString()}</span>
            <span role="cell" className="min-w-0 truncate text-13 max-md:hidden">
              {c.examples.map((k, j) => <span key={k}>{j > 0 && ', '}<a href={`#/flag/${k}/${env}`} className="font-mono text-xs text-ink">{k}</a></span>)}
              {c.flags > c.examples.length && <span className="text-ink-3"> and {c.flags - c.examples.length} more</span>}
            </span>
          </div>
        ))}
    </div>
  );
}
