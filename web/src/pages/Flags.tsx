import { useEffect, useRef, useState } from 'react';
import { LockSimpleIcon } from '@phosphor-icons/react';
import { Button } from '@companyflags/ui/components/button';
import { Callout } from '@companyflags/ui/components/callout';
import { BulkBar, ColumnHead, KeyHints, RowCheck, SortHeader, tableHeadClass, tableRowClass, useListKeys, useSelection } from '@companyflags/ui/components/data-table';
import { Input } from '@companyflags/ui/components/input';
import { NativeSelect } from '@companyflags/ui/components/native-select';
import { barTextButton, FilterSelect, PageBar, ViewMenu, type SavedView } from '@companyflags/ui/components/page-bar';
import { Tabs } from '@companyflags/ui/components/tabs';
import { SearchField } from '@companyflags/ui/components/search-field';
import { cn } from '@companyflags/ui/lib/utils';
import { api, CODE_DEFAULT, fmtValue, KIND_INFO, prefetch, type FlagDetail, type FlagSummary } from '../api.ts';
import { downloadCsv } from '../csv.ts';
import { flagListPath, flagPath, pageEnv } from '../paths.ts';
import { HowItWorks } from '../howItWorks.tsx';
import { CountSlot, SkeletonRows } from '../loading.tsx';
import { pagerRow } from '../loadingKit.ts';
import { go, useApp } from '../app.ts';
import { writePersistent } from '../persist.ts';
import { plural } from '../text.ts';
import { Actions, Badge, ChipInput, Empty, ErrorList, Field, Modal, OnOff, Pager, Segmented, Switch, When } from '../ui.tsx';
import { monoLabel, type Paged, useAsync, usePersistentState, useServerPage, useSlashFocus } from '../uiKit.ts';
import { cleanTags, flagNameProblem, keyFromName, needsRemoveBy as removeByRequired, normalizeTag } from '../../../server/checks.ts';
import { blankRow, fromText, rowError, valueError, ValueInput, ValuesEditor, type ValueRow } from '../values.tsx';
import { hiddenKey } from '../../../server/evaluator.ts';
import { type SaveResult } from './flagParts.tsx';
import { useEnvs } from './envs.ts';
import { pathIn, roleInfo, switchPlan, type SwitchPath } from '../../../server/policy.ts';
import { DraftBar, ReviewDraft } from './draftReview.tsx';
import { useDraft } from '../useDraft.ts';
import { ConditionsTab, VersionsTab } from './versions.tsx';
import { FinishSetup, NoServices } from './setup.tsx';

/*
 * Flags (Google style: drafts and versions). The bar holds the environment and, while a draft exists,
 * "Publish changes (N)". Tabs: the flags, the environment's versions (roll back any of them), and the
 * conditions rules use. Edits made on flag pages collect in your draft until you publish them together.
 * Keyboard: / search, j/k move, x select, Enter open, Esc clear.
 */

type Sort = 'key' | 'status' | 'kind' | 'owner' | 'changed';
type EnvState = { enabled: boolean; entityLayers: number; defaultVariation: string; defaultValue: unknown; rules: number };
type Row = Omit<FlagSummary, 'envs'> & { envs: Record<string, EnvState>; changedAt?: string | null; changedBy?: string | null; lastVersion?: number | null };
type Tab = 'flags' | 'versions' | 'conditions';

/** checkbox, flag, the chosen environment, rules, purpose, owner, version (wide enough for its head and its ?), changed */
const COLS = 'grid grid-cols-[28px_minmax(0,2fr)_minmax(0,1fr)_64px_104px_minmax(0,1fr)_88px_84px] max-xl:grid-cols-[28px_minmax(0,2fr)_minmax(0,1fr)_64px_84px] max-md:grid-cols-[28px_minmax(0,1fr)_104px]';
const XL = 'max-xl:hidden';
const MD = 'max-md:hidden';
/** a row's height: two lines (the name, then the key and tags), as tall as a release's row (Releases.tsx);
 *  placeholder rows are the same */
const ROW = 'min-h-[76px] py-3.5';
/** what a saved view remembers */
type View = { env: string; status: string; kind: string; owner: string; tag?: string; sort: Sort; dir: 'asc' | 'desc' };
/** inline help for the terms people ask about */
const HELP = {
  envs: 'On or off in this environment, and the value everyone gets by default. How many have their own settings is counted underneath.',
  purpose: Object.values(KIND_INFO).join('. ') + '.',
  rules: 'How many rules decide who gets what in this environment, not counting anyone’s own settings.',
  version: 'The version of this environment that last changed this flag. Roll back from the Versions tab.',
};
const NONE: string[] = [];
/** "a, b and 3 more" */
const some = (xs: string[], n = 3) => (xs.length <= n ? xs.join(', ') : `${xs.slice(0, n).join(', ')} and ${xs.length - n} more`);
/** One chip shape for everything small in a row (tags, the draft mark): same height, size and padding, centred on the line. */
const CHIP = 'inline-flex h-[18px] shrink-0 items-center border px-1.5 text-[11px] leading-none';
const shown = (st: EnvState) => (st.defaultVariation === CODE_DEFAULT ? 'in-app default' : fmtValue(st.defaultValue));

export function Flags({ envKey, tab: tabKey }: { envKey?: string; tab?: string }) {
  const { meta, revisionTick, toast, ask, reload } = useApp();
  const { envName, envOf, isProtected } = useEnvs();
  // memory: the list opens the way you left it (environment, filters, sort); the search starts empty
  const env = pageEnv(meta, envKey);
  useEffect(() => { if (envKey) writePersistent('env', envKey); }, [envKey]);
  const tab: Tab = tabKey === 'versions' || tabKey === 'conditions' ? tabKey : 'flags';
  const openTab = (t: Tab) => go(`flags/${env}${t === 'flags' ? '' : `/${t}`}`);
  const [q, setQ] = useState('');
  const [status, setStatus] = usePersistentState('flags.status', '');
  const [kind, setKind] = usePersistentState('flags.kind', '');
  const [owner, setOwner] = usePersistentState('flags.owner', '');
  const [tag, setTag] = usePersistentState('flags.tag', '');
  const [sort, setSort] = usePersistentState<Sort>('flags.sort', 'key');
  const [dir, setDir] = usePersistentState<'asc' | 'desc'>('flags.dir', 'asc');
  const [views, setViews] = usePersistentState<SavedView<View>[]>('flags.views', []);
  const [creating, setCreating] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const [tries, setTries] = useState(0);   // Try again after a failed load
  const { session: drafts, summary: draft } = useDraft(env);

  const filterKey = [q.trim(), env, status, kind, owner, tag, sort, dir].join('|');
  const paging = useServerPage<Paged & { rows: Row[]; owners?: string[]; tags?: string[] }>(
    (page) => flagListPath({ env, q: q.trim(), status, kind, owner, tag, sort, dir }, page), filterKey, `${revisionTick}:${tries}`);
  const rows = tab === 'flags' ? paging.data?.rows ?? [] : [];
  // every page's answer lists the owners and tags in use; the shown answer stays while the next one loads
  const owners = paging.data?.owners ?? NONE;
  const tagsInUse = paging.data?.tags ?? NONE;
  const sel = useSelection(rows.map((r) => r.key));
  const keys = useListKeys({
    count: rows.length,
    onOpen: (i) => go(`flag/${rows[i].key}/${env}`),
    onToggle: (i) => sel.toggle(rows[i].key),
    onClear: () => sel.clear(),
    enabled: tab === 'flags' && !creating && !reviewing,
  });
  // "/" puts the cursor in the search box
  useSlashFocus(search, tab === 'flags');

  const onSort = (k: Sort, d: 'asc' | 'desc') => { setSort(k); setDir(d); };
  const needsReview = isProtected(env);
  const chosen = rows.filter((r) => sel.isSelected(r.key));
  const filtered = !!(q || status || kind || owner || tag);
  const view: View = { env, status, kind, owner, tag, sort, dir };
  const applyView = (v: View) => { setStatus(v.status); setKind(v.kind); setOwner(v.owner); setTag(v.tag ?? ''); setSort(v.sort); setDir(v.dir); if (v.env !== env) go(`flags/${v.env}`); };
  const reset = () => { setQ(''); setStatus(''); setKind(''); setOwner(''); setTag(''); };
  const envs = meta.environments.map((e) => e.key);

  // ---- bulk actions: one call per flag, in order. How each switch goes through is policy.ts switchPlan, the same call
  // the switch on a flag's page makes: now where nothing is reviewed, a change set in a protected environment, or
  // break-glass for on call turning a kill switch or ops flag off.
  const mayChange = roleInfo(meta.me.role).changes;
  const setEnabled = async (on: boolean) => {
    const where = `in ${envName(env).toLowerCase()}`;
    const plan = switchPlan(meta.me, chosen.map((f) => ({ key: f.key, kind: f.kind, enabled: !!f.envs[env]?.enabled })), envOf(env), on, draft.has);
    const changing = [...plan.now, ...plan.breakGlass, ...plan.review];
    if (!changing.length) {
      toast(plan.refused.length ? 'Viewers can look but not change anything: ask an admin for a role' : `Nothing to change ${where}: ${chosen.length === 1 ? 'it is' : 'they are'} already ${on ? 'on' : 'off'}`);
      return;
    }
    const verb = on ? 'turn on' : 'turn off';
    // the switch is never drafted: saved drafts on these flags are discarded once you go ahead, as on a flag's page
    if (plan.drafted.length) {
      const d = await ask({
        title: `Discard your changes and ${verb} ${changing.length === 1 ? changing[0] : plural(changing.length, 'flag')}?`,
        body: <p>You have unpublished changes to {some(plan.drafted)} in {envName(env).toLowerCase()}. They’re discarded first, then {changing.length === 1 ? 'the flag is' : 'the flags are'} {on ? 'turned on' : 'turned off'}.</p>,
        actions: [{ id: 'keep', label: 'Keep editing' }, { id: 'go', label: `Discard and ${verb}`, tone: on ? 'primary' : 'danger' }],
      });
      if (d.action !== 'go') return;
    }
    const planned = (key: string): SwitchPath => pathIn(plan, key) ?? 'now';
    const bg = plan.breakGlass.length;
    const rv = plan.review.length;
    // forgiveness: where nothing is reviewed, act at once and offer Undo
    if (!bg && !rv) {
      drafts.discard(plan.drafted);
      return applyEnabled(changing.map((key) => ({ key, path: planned(key) })), on, undefined, true);
    }
    const r = await ask({
      title: `${on ? 'Turn on' : 'Turn off'} ${plural(changing.length, 'flag')} ${where}?`,
      body: <>
        <p>{on ? 'Apps get values from the rules again.' : <><b className="font-medium">Nobody will get a value</b> from {changing.length === 1 ? 'this flag' : 'these flags'}; every app uses the default in its code.</>}</p>
        {bg > 0 && <p className="text-ink-3">You can use break-glass, so {rv ? some(plan.breakGlass) : bg === 1 ? 'it' : 'they'} can go off right away. It’s logged for review.</p>}
        {rv > 0 && <p>{bg ? `${some(plan.review)} ${rv === 1 ? 'goes' : 'go'} to an approver first.` : rv === 1 ? 'The change goes to an approver first.' : 'Each change goes to an approver first.'}</p>}
      </>,
      reason: { label: 'Why? (required)', placeholder: on ? 'Issue resolved' : 'INC-123: checkout errors' },
      actions: [{ id: 'cancel', label: 'Cancel' },
        ...(bg ? [{ id: 'now', label: rv ? `Turn off ${bg} now, request review of ${rv}` : 'Turn off now', tone: 'danger' as const, needsReason: true }] : []),
        { id: 'request', label: bg && rv ? `Request review of all ${changing.length}` : 'Request review', tone: bg ? 'default' as const : on ? 'primary' as const : 'danger' as const, needsReason: true }],
    });
    if (r.action !== 'now' && r.action !== 'request') return;
    drafts.discard(plan.drafted);
    // "Request review" sends the ones on call could turn off now for review too, as the switch's second choice does
    await applyEnabled(changing.map((key) => ({ key, path: r.action === 'request' && planned(key) === 'break-glass' ? 'review' : planned(key) })), on, r.reason, true);
  };
  /** Turns the flags on or off one by one, each the way its step says (the switch is never drafted: on call it must
   *  act now). Break-glass steps send the reason as the break-glass reason. Undo from the toast for what went live
   *  where nothing is reviewed. */
  const applyEnabled = async (steps: { key: string; path: SwitchPath }[], on: boolean, reason: string | undefined, offerUndo: boolean) => {
    const applied: string[] = []; const broke: string[] = []; let requested = 0; const failed: typeof steps = []; let why = '';
    for (const [i, step] of steps.entries()) {
      setBusy(`Turning ${on ? 'on' : 'off'} ${i + 1} of ${steps.length}…`);
      try {
        const d = await api<FlagDetail>('GET', `/flags/${step.key}`);
        const base = d.layers[env].base;
        if (!!base.enabled === on) continue;
        const res = await api<SaveResult>('PUT', `/flags/${step.key}/layers/${env}/base`, {
          layer: { ...base, enabled: on }, expectedVersion: base.version, reason,
          bypassReason: step.path === 'break-glass' ? reason : undefined,
        });
        if (!res.applied) requested++; else if (res.bypass) broke.push(step.key); else applied.push(step.key);
      } catch (e) { failed.push(step); why ||= (e as Error).message; }
    }
    setBusy(null); sel.clear(); reload().catch(() => {});
    void drafts.noteChanged([...applied, ...broke]);               // a draft made since on these flags is stale now
    const where = `in ${envName(env).toLowerCase()}`;
    const text = [applied.length && `Turned ${on ? 'on' : 'off'} ${plural(applied.length, 'flag')} ${where}`,
      broke.length && `Turned off ${plural(broke.length, 'flag')} ${where} by break-glass (logged)`,
      requested && `${plural(requested, 'change')} sent for review`,
      failed.length && `${plural(failed.length, 'flag')} not changed (${failed.map((f) => f.key).join(', ')}): ${why}`].filter(Boolean).join(' · ') || `Nothing to change ${where}`;
    // a partial failure offers Retry for just the failed ones; a clean run offers Undo
    toast(text, failed.length ? 'err' : 'ok', failed.length ? { label: 'Retry', onClick: () => applyEnabled(failed, on, reason, offerUndo) }
      : offerUndo && applied.length ? { label: 'Undo', onClick: () => applyEnabled(applied.map((key) => ({ key, path: 'now' as const })), !on, 'Undo', false) } : undefined);
  };
  const archive = async (list = chosen) => {
    const r = await ask({
      title: `Archive ${plural(list.length, 'flag')}?`,
      body: <p>They leave every service in every environment, right away and without a review; apps and backends fall back to the defaults in their code. Their history is kept.</p>,
      actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'go', label: 'Archive', tone: 'danger' }],
    });
    if (r.action !== 'go') return;
    const failed: Row[] = []; let why = '';
    for (const [i, f] of list.entries()) {
      setBusy(`Archiving ${i + 1} of ${list.length}…`);
      try { await api('POST', `/flags/${f.key}/archive`); } catch (e) { failed.push(f); why ||= (e as Error).message; }
    }
    setBusy(null); sel.clear(); reload().catch(() => {});
    const done = list.length - failed.length;
    toast([done && `Archived ${plural(done, 'flag')}`, failed.length && `${plural(failed.length, 'flag')} not archived (${failed.map((f) => f.key).join(', ')}): ${why}`].filter(Boolean).join(' · '),
      failed.length ? 'err' : 'ok', failed.length ? { label: 'Retry', onClick: () => archive(failed) } : undefined);
  };
  const exportCsv = () => {
    const list = chosen.length ? chosen : rows;
    downloadCsv(`flags-${env}.csv`, ['key', 'name', 'tags', ...envs.map((e) => `${e}_status`), 'type', 'purpose', 'owner', 'last_version', 'changed_at'],
      list.map((f) => [f.key, f.name, f.tags.join(' '), ...envs.map((e) => (f.envs[e]?.enabled ? 'on' : 'off')), f.valueType, f.kind, f.owner, f.lastVersion, f.changedAt]));
    toast(`Exported ${plural(list.length, 'flag')} to flags-${env}.csv`);
  };

  return (
    <div className="flex min-h-full flex-1 flex-col">
      {/* the bar: the environment everything below is about, and — while a draft exists — publishing it */}
      <PageBar title="Flags" count={<CountSlot text={paging.data ? (filtered ? `${paging.data.matched.toLocaleString()} of ${paging.data.all.toLocaleString()}` : paging.data.all.toLocaleString()) : undefined} />}
        actions={<>
          {draft.flags.length > 0 && <Button onClick={() => setReviewing(true)}>{needsReview ? 'Request review' : 'Publish changes'} ({draft.changes})</Button>}
          <HowItWorks />
          {mayChange ? <Button variant={draft.flags.length > 0 ? 'secondary' : 'default'} onClick={() => setCreating(true)}>+ New flag</Button>
            : <span className="text-13 text-ink-3">Viewers can look but not change anything</span>}
        </>}>
        <FilterSelect label="Environment" value={env} onChange={(v) => go(`flags/${v}${tab === 'flags' ? '' : `/${tab}`}`)} options={meta.environments.map((e) => [e.key, envName(e.key)] as [string, string])} />
      </PageBar>

      <div className="border-b border-rule px-6 max-sm:px-4">
        <Tabs<Tab> label="Flags sections" value={tab} onChange={openTab} className="border-b-0"
          items={[{ value: 'flags', label: 'Flags' }, { value: 'versions', label: 'Versions' }, { value: 'conditions', label: 'Conditions' }]} />
      </div>

      {/* unfinished work stays in view; with no draft, a protected environment says what publishing means here */}
      {draft.flags.length > 0 ? <DraftBar env={env} onReview={() => setReviewing(true)} />
        : needsReview && <div className="flex items-center gap-2 border-b border-grid px-6 py-2 text-13 text-flag max-sm:px-4"><LockSimpleIcon aria-hidden className="size-3.5" />{envName(env)} is protected: publishing sends your draft to an approver first.</div>}

      {tab === 'versions' && <VersionsTab env={env} />}
      {tab === 'conditions' && <ConditionsTab env={env} />}

      {tab === 'flags' && <>
        {/* until apps can read flags (a service and an entry with its app link), what's left to set up */}
        {(meta.projects.length === 0 || meta.entities.length === 0) && <FinishSetup flags={paging.data?.all} onNewFlag={mayChange ? () => setCreating(true) : undefined} />}
        <div className="flex flex-wrap items-center gap-2 border-b border-grid px-6 py-2.5 max-sm:px-4">
          <SearchField ref={search} className="w-[260px] max-md:w-auto max-md:flex-1 max-md:basis-full" data-search="flags" placeholder="Search  /" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search flags" />
          <FilterSelect label="Status" value={status} onChange={setStatus} options={[['', 'All'], ['on', `On in ${envName(env).toLowerCase()}`], ['off', `Off in ${envName(env).toLowerCase()}`]]} />
          <FilterSelect label="Purpose" value={kind} onChange={setKind} options={[['', 'All'], ...Object.keys(KIND_INFO).map((k) => [k, kindName(k)] as [string, string])]} />
          <FilterSelect label="Owner" value={owner} onChange={setOwner} options={[['', 'All'], ...owners.map((o) => [o, o] as [string, string])]} />
          {/* the tags in use come with the list: the filter keeps its place while it loads */}
          {(tagsInUse.length > 0 || !paging.data) && <FilterSelect label="Tag" value={tag} onChange={setTag} options={[['', 'All'], ...tagsInUse.map((t) => [t, t] as [string, string])]} />}
          <ViewMenu views={views} current={view} onApply={applyView} onChange={setViews} />
          {filtered && <button type="button" onClick={reset} className={barTextButton}>Reset</button>}
        </div>

        <div role="table" aria-label="Flags" aria-busy={paging.loading} className={cn('flex-1', paging.loading && 'opacity-70')}>
          <div role="row" className={cn(COLS, tableHeadClass)}>
            <RowCheck head checked={sel.all} indeterminate={sel.some} onChange={sel.toggleAll} label="Select all on this page" />
            <SortHeader label="Flag" sortKey="key" sort={sort} dir={dir} onSort={onSort} />
            <SortHeader label={envName(env)} sortKey="status" sort={sort} dir={dir} onSort={onSort} help={HELP.envs} />
            <ColumnHead className={MD} label="Rules" help={HELP.rules} />
            <span className={XL}><SortHeader label="Purpose" sortKey="kind" sort={sort} dir={dir} onSort={onSort} help={HELP.purpose} /></span>
            <span className={XL}><SortHeader label="Owner" sortKey="owner" sort={sort} dir={dir} onSort={onSort} /></span>
            <ColumnHead className={XL} label="Version" help={HELP.version} />
            <span className={MD}><SortHeader label="Changed" sortKey="changed" sort={sort} dir={dir} onSort={onSort} /></span>
          </div>
          {paging.error ? <Callout tone="error" role="alert" className="m-6 max-sm:m-4">Couldn’t load flags: {paging.error} <Button variant="secondary" className="ml-2" onClick={() => setTries((t) => t + 1)}>Try again</Button></Callout>
            : !paging.data ? <SkeletonRows cols={COLS} cells={['', '', '', MD, XL, XL, XL, MD]} rowClass={ROW} />
            : rows.length === 0 ? (
              <div className="px-6 py-10">
                <Empty action={filtered ? <Button variant="secondary" onClick={reset}>{status || kind || owner || tag ? 'Clear filters' : 'Clear search'}</Button> : mayChange ? <Button onClick={() => setCreating(true)}>+ New flag</Button> : undefined}>
                  {filtered
                    ? `No flags match ${[q.trim() && `“${q.trim()}”`, status && `${status} in ${envName(env).toLowerCase()}`, kind && `purpose ${kindName(kind).toLowerCase()}`, owner && `owner ${owner}`, tag && `tag ${tag}`].filter(Boolean).join(', ')}.`
                    : 'No flags yet. A flag lets you turn a feature on or off, or change a value, without shipping a new build.'}
                </Empty>
              </div>
            ) : rows.map((f, i) => (
              <div key={f.key} role="row" data-row-index={i} data-active={keys.active === i} aria-selected={sel.isSelected(f.key)}
                onClick={() => { keys.setActive(i); go(`flag/${f.key}/${env}`); }} onPointerEnter={() => { void prefetch(flagPath(f.key)); }}
                className={cn(COLS, tableRowClass, ROW, 'cursor-default')}>
                <RowCheck checked={sel.isSelected(f.key)} onChange={() => sel.toggle(f.key)} label={`Select ${f.key}`} />
                <span role="cell" className="min-w-0" title={f.description ?? undefined}>
                  {/* the flag's address: Tab reaches it, Enter opens it, and it opens in a new tab like any link.
                      Two fixed-height lines, everything centred on them: the name (and the draft mark), then the key and tags */}
                  <a href={`#/flag/${encodeURIComponent(f.key)}/${encodeURIComponent(env)}`} onClick={(e) => { e.stopPropagation(); keys.setActive(i); }}
                    onFocus={() => { void prefetch(flagPath(f.key)); }} className="block min-w-0 text-ink no-underline hover:no-underline">
                    <span className="flex h-5 min-w-0 items-center gap-2">
                      {f.name ? <span className="truncate text-13 font-medium text-ink">{f.name}</span> : <span className="truncate font-mono text-13 font-medium">{f.key}</span>}
                      {draft.has(f.key) && <span title="In your draft: unpublished changes to this flag" className={cn(CHIP, 'border-flag/40 bg-flag-bg font-medium text-flag')}>Draft</span>}
                    </span>
                    <span className="mt-0.5 flex h-[18px] min-w-0 items-center gap-1.5">
                      {f.name ? <span className="max-w-full shrink-0 truncate font-mono text-xs leading-none text-ink-3">{f.key}</span> : <span className="min-w-0 truncate text-xs leading-none text-ink-3">{f.description}</span>}
                      <span className="flex min-w-0 items-center gap-1 overflow-hidden" title={f.tags.join(', ') || undefined}>
                        {f.tags.map((t) => <span key={t} className={cn(CHIP, 'border-rule font-mono text-ink-2')}>{t}</span>)}
                      </span>
                    </span>
                  </a>
                </span>
                {(() => {
                  const st = f.envs[env];
                  return (
                    <span role="cell" className="min-w-0">
                      {st ? <>
                        <OnOff on={!!st.enabled} />
                        <span className="block truncate font-mono text-xs text-ink-3" title={shown(st)}>{shown(st)}{st.entityLayers ? <span className="font-sans">, {st.entityLayers.toLocaleString()} with own settings</span> : null}</span>
                      </> : <span className="text-ink-3">—</span>}
                    </span>
                  );
                })()}
                <span role="cell" className={cn(MD, 'font-mono text-13', f.envs[env]?.rules ? 'text-ink' : 'text-ink-3')}>{f.envs[env]?.rules ?? 0}</span>
                <span role="cell" className={XL}>{f.kind === 'release'
                  ? <a href={`#/release/${encodeURIComponent(f.key)}/${encodeURIComponent(env)}`} onClick={(e) => e.stopPropagation()} title="Open its release page" className="no-underline hover:no-underline"><Badge>{kindName(f.kind)} →</Badge></a>
                  : <Badge>{kindName(f.kind)}</Badge>}</span>
                <span role="cell" className={cn(XL, 'truncate text-ink-2')}>{f.owner ?? <span className="text-ink-3">—</span>}</span>
                <span role="cell" className={cn(XL, 'font-mono text-13 text-ink-2')}>{f.lastVersion ? `v${f.lastVersion}` : '—'}</span>
                <span role="cell" className={MD}><When iso={f.changedAt} /></span>
              </div>
            ))}
        </div>

        <div className={cn('flex flex-wrap items-center gap-4 border-t border-rule px-6 max-sm:px-4', pagerRow)}>
          <KeyHints className="max-md:hidden" />
          <span className="flex-1" />
          {paging.data && <Pager page={paging.page} size={paging.size} matched={paging.data.matched} noun="flags" onPage={(p) => { paging.go(p); keys.setActive(-1); }} />}
        </div>

        <BulkBar count={sel.count} onClear={sel.clear}>
          {busy ? <span className="text-13 text-ink-2">{busy}</span> : <>
            <Button variant="outline" disabled={!mayChange} onClick={() => setEnabled(false)}>Turn off in {envName(env).toLowerCase()}</Button>
            <Button variant="outline" disabled={!mayChange} onClick={() => setEnabled(true)}>Turn on in {envName(env).toLowerCase()}</Button>
            <Button variant="outline" onClick={exportCsv}>Export CSV</Button>
            <Button variant="stop" disabled={!mayChange} onClick={() => archive()}>Archive</Button>
          </>}
        </BulkBar>
      </>}

      {reviewing && <ReviewDraft env={env} onClose={() => setReviewing(false)} />}
      {creating && <CreateFlag onClose={() => setCreating(false)} owners={owners} tagsInUse={tagsInUse} />}
    </div>
  );
}

const TYPE_OPTIONS = [
  { value: 'bool', label: 'On / off' }, { value: 'string', label: 'Text' }, { value: 'number', label: 'Number' }, { value: 'json', label: 'JSON' },
];

// "Release — roll out a new feature, then remove the flag" → name "Release", hint "Roll out a new feature, then remove the flag."
const kindName = (k: string) => KIND_INFO[k]?.split(' — ')[0] ?? k.replace('_', ' ');
const kindHint = (k: string) => {
  const rest = KIND_INFO[k]?.split(' — ')[1];
  return rest ? `${rest[0].toUpperCase()}${rest.slice(1)}.` : undefined;
};

const startRows = (type: string): ValueRow[] => type === 'bool'
  ? [{ key: 'on', text: 'true', isNew: true }, { key: 'off', text: 'false', isNew: true }]
  : [{ key: 'default', text: type === 'number' ? '0' : type === 'json' ? '{}' : '', isNew: true }];

function CreateFlag({ onClose, owners, tagsInUse }: { onClose: () => void; owners: string[]; tagsInUse: string[] }) {
  const { meta, toast } = useApp();
  // the readable name comes first; the key follows it until you edit the key yourself
  const [name, setName] = useState('');
  const [key, setKeyRaw] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const setKey = (k: string) => { setKeyEdited(true); setKeyRaw(k); };
  const onName = (n: string) => { setName(n); if (!keyEdited) setKeyRaw(keyFromName(n)); };
  const [owner, setOwner] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [valueType, setValueType] = useState('bool');
  const [kind, setKind] = useState('release');
  const [description, setDescription] = useState('');
  const [removeBy, setRemoveBy] = useState(() => new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10));
  const [rows, setRows] = useState<ValueRow[]>(startRows('bool'));
  const [def, setDef] = useState<string>(CODE_DEFAULT);
  // variants on (named values to pick from), or free values: any value typed into the rules. On/off flags always have
  // their two variants
  const [named, setNamed] = useState(true);
  const free = valueType !== 'bool' && !named;
  const [first, setFirst] = useState('');
  // a new flag goes to every app (Settings → Apps); backends get it too, as they download every rule
  const [delivery, setDelivery] = useState<string[]>(meta.projects.filter((p) => p.kind === 'client').map((p) => p.key));
  const { busy, error, run } = useAsync();

  const keyError = key && !/^[a-z][a-z0-9_]*$/.test(key) ? 'Start with a letter; use lowercase letters, digits and _' : null;
  const tagError = cleanTags(tags).problem;
  const nameError = flagNameProblem(name);
  const valuesInvalid = free ? !!valueError(valueType, first) : rows.some((r) => rowError(valueType, r, rows));
  const needsRemoveBy = removeByRequired(kind);
  const canSubmit = !!key && !keyError && !tagError && !nameError && (free || rows.length > 0) && !valuesInvalid && !busy;

  const setType = (t: string) => { setValueType(t); setRows(startRows(t)); setDef(CODE_DEFAULT); setFirst(''); };

  const submit = async () => {
    const res = await run(() => api('POST', '/flags', {
      key, name: name.trim() || null, tags: cleanTags(tags).tags, owner: owner.trim() || null, valueType, kind, description, removeBy: needsRemoveBy ? removeBy : null,
      ...(free ? {
        // free values: the value everyone gets is the first one, typed in (a hidden variant)
        freeValues: true, variations: [{ key: hiddenKey(fromText(valueType, first)), value: fromText(valueType, first) }],
        base: { enabled: true, defaultVariation: hiddenKey(fromText(valueType, first)), rules: [] },
      } : {
        variations: rows.map((r) => ({ key: r.key, value: fromText(valueType, r.text) })),
        base: { enabled: true, defaultVariation: def, rules: [] },
      }),
      delivery: Object.fromEntries(meta.environments.map((e) => [e.key, delivery])),
    }));
    // a release opens on its release page (Releases.tsx), where its first step is chosen
    if (res) { toast(`Created ${name.trim() || key}`); onClose(); go(kind === 'release' ? `release/${key}` : `flag/${key}`); }
  };

  return (
    <Modal title="New flag" onClose={onClose} wide footer={
      <Actions>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button disabled={!canSubmit} onClick={submit}>{busy ? 'Creating…' : 'Create flag'}</Button>
      </Actions>
    }>
      <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
        <Field label="Name" hint={nameError ? <span className="text-live">{nameError}</span> : 'What people see in the list, e.g. New search ranking.'}>
          <Input data-autofocus value={name} placeholder="New search ranking" aria-invalid={!!nameError} onChange={(e) => onName(e.target.value)} />
        </Field>
        <Field label="Key" required hint={keyError ? <span className="text-live">{keyError}</span> : (
          <>What your code reads, e.g. <span className="font-mono text-ink-2">getBooleanValue("{key || 'new_search_ranking'}")</span>. It can’t be changed later.</>
        )}>
          <Input className="font-mono" value={key} placeholder="new_search_ranking" aria-invalid={!!keyError}
            onChange={(e) => setKey(e.target.value.toLowerCase().replace(/[\s-]+/g, '_'))} />
        </Field>
      </div>
      <Field label="Description">
        <Input value={description} placeholder="What does this flag control?" onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
        <Field label="Owner" hint="The team responsible for it.">
          <Input value={owner} list="flag-owners" placeholder="payments-team" onChange={(e) => setOwner(e.target.value)} />
          <datalist id="flag-owners">{owners.map((o) => <option key={o} value={o} />)}</datalist>
        </Field>
        <Field label="Tags" hint={tagError ? <span className="text-live">{tagError}</span> : 'To group flags by team or area. Press Enter after each.'}>
          <ChipInput label="Tags" values={tags} onChange={(v) => setTags(v.map(normalizeTag))} suggestions={tagsInUse} placeholder="checkout, web" invalid={!!tagError} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
        <Field label="Purpose" hint={kindHint(kind)}>
          <NativeSelect className="w-full" value={kind} onChange={(e) => setKind(e.target.value)}>
            {Object.keys(KIND_INFO).map((k) => <option key={k} value={k}>{kindName(k)}</option>)}
          </NativeSelect>
        </Field>
        {needsRemoveBy && (
          <Field label="Remove by" required hint={`${kindName(kind)} flags should be temporary.`}>
            <Input type="date" value={removeBy} onChange={(e) => setRemoveBy(e.target.value)} />
          </Field>
        )}
      </div>

      <div className="grid gap-1.5">
        <span className={monoLabel}>Type</span>
        <Segmented className="justify-self-start" label="Type" value={valueType} onChange={setType} options={TYPE_OPTIONS} />
      </div>
      {valueType !== 'bool' && (
        <div className="grid gap-1.5">
          <span className={monoLabel}>Variants</span>
          <Switch label="Variants" checked={named} onChange={setNamed}>
            <span className="text-13 text-ink-2">{named ? 'On: rules pick from named values, listed here' : 'Off: type any value into the rules (free values)'}</span>
          </Switch>
        </div>
      )}
      {free ? (
        <Field label="Value everyone gets" required hint={first && valueError(valueType, first) ? <span className="text-live">{valueError(valueType, first)}</span>
          : 'Rules can give others any value you type. You can switch to the in-app default after creating the flag.'}>
          <ValueInput type={valueType} label="Value everyone gets" text={first} onChange={setFirst} invalid={!!first && !!valueError(valueType, first)} />
        </Field>
      ) : <>
        <div className="grid gap-1.5">
          <span className={monoLabel}>Named values</span>
          <ValuesEditor type={valueType} rows={rows} onChange={setRows} />
          {valueType !== 'bool' && (
            <Button variant="link" className="justify-self-start" onClick={() => setRows([...rows, blankRow(valueType, rows)])}>+ Add variant</Button>
          )}
        </div>
        <Field label="Default" hint="What everyone gets. You can add rules after creating the flag.">
          <NativeSelect className="w-full" value={def} onChange={(e) => setDef(e.target.value)}>
            <option value={CODE_DEFAULT}>In-app default (send nothing)</option>
            {rows.filter((r) => r.key).map((r) => <option key={r.key} value={r.key}>{r.key}</option>)}
          </NativeSelect>
        </Field>
      </>}

      <div className="grid gap-1.5" role="group" aria-label="Services">
        <span className={monoLabel}>Services</span>
        {meta.projects.length === 0 ? <NoServices /> : <>
          <div className="flex flex-wrap gap-x-5 gap-y-2 py-1">
            {meta.projects.map((p) => (
              <Switch key={p.key} label={p.key} checked={delivery.includes(p.key)}
                onChange={(on) => setDelivery(on ? [...delivery, p.key] : delivery.filter((x) => x !== p.key))}>
                <span className="font-mono text-13 text-ink">{p.key}</span>
              </Switch>
            ))}
          </div>
          <span className="text-13 text-ink-3">The services this flag is in, in every environment.</span>
        </>}
      </div>
      <ErrorList error={error} />
    </Modal>
  );
}
