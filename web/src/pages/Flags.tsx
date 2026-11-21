import { useEffect, useRef, useState } from 'react';
import { LockSimpleIcon } from '@phosphor-icons/react';
import { Button } from '@companyflags/ui/components/button';
import { Callout } from '@companyflags/ui/components/callout';
import { BulkBar, ColumnHead, KeyHints, RowCheck, SortHeader, tableHeadClass, tableRowClass, useListKeys } from '@companyflags/ui/components/data-table';
import { Input } from '@companyflags/ui/components/input';
import { NativeSelect } from '@companyflags/ui/components/native-select';
import { barTextButton, FilterSelect, PageBar, ViewMenu, type SavedView } from '@companyflags/ui/components/page-bar';
import { Tabs } from '@companyflags/ui/components/tabs';
import { SearchField } from '@companyflags/ui/components/search-field';
import { cn } from '@companyflags/ui/lib/utils';
import { api, CODE_DEFAULT, fmtValue, KIND_INFO, prefetch, type FlagDetail } from '../api.ts';
import { downloadCsv } from '../csv.ts';
import { FLAG_PAGE_SIZES, flagListPath, flagPageSize, flagPath, flagsHref, flagViewQuery, pageEnv, type FlagFilters, type FlagView } from '../paths.ts';
import { HowItWorks } from '../howItWorks.tsx';
import { CountSlot, SkeletonRows } from '../loading.tsx';
import { pagerRow } from '../loadingKit.ts';
import { go, useApp } from '../app.ts';
import { PAGE_SIZE, writePersistent } from '../persist.ts';
import { plural } from '../text.ts';
import { Actions, Badge, ChipInput, Empty, ErrorList, Field, Modal, OnOff, Pager, Segmented, Switch, When } from '../ui.tsx';
import { copyText, monoLabel, textareaField, useAsync, usePersistentState, useServerPage, useSlashFocus } from '../uiKit.ts';
import { cleanTags, flagNameProblem, keyFromName, needsRemoveBy as removeByRequired, normalizeTag } from '../../../server/checks.ts';
import { blankRow, fromText, rowError, toText, valueError, ValueInput, ValuesEditor, type ValueRow } from '../values.tsx';
import { firstMismatch } from '../../../server/jsonSchema.ts';
import { aiConfigTemplate, readSchemaText, schemaText } from './flagTemplates.ts';
import { hiddenKey } from '../../../server/evaluator.ts';
import { type SaveResult } from './flagParts.tsx';
import { useEnvs } from './envs.ts';
import { pathIn, roleInfo, switchPlan, type SwitchPath } from '../../../server/policy.ts';
import { DraftBar, ReviewDraft } from './draftReview.tsx';
import { useDraft } from '../useDraft.ts';
import { ConditionsTab } from './versions.tsx';
import { FinishSetup, NoServices } from './setup.tsx';
import { setupLeft, setupSteps } from './setupKit.ts';
import {
  allMatching, density, flagsCsv, isOverdue, mapLimit, newFlagServices, ROW_CLASS, SERVICES_HINT, startDefault, startsLine, switchBatches, switchItems, today, useFlagView,
  useKeptSelection, versionsHref, type Density, type EnvState, type FlagPage, type Row,
} from './flagsKit.ts';

/*
 * Flags (Google style: drafts). The bar holds the environment and, while a draft exists, "Publish changes (N)". Tabs:
 * the flags and the conditions rules use; an environment's versions are in History. The search, filters, sort and the
 * environments shown are in the address (#/flags/prod?owner=payments), so a link opens the same list. Edits made on
 * flag pages collect in your draft until you publish them together. Keyboard: / search, j/k move, x select, Enter
 * open, Esc clear.
 */

type Tab = 'flags' | 'conditions';

/** checkbox, flag, the chosen environment (or every one), rules, purpose, owner, version (wide enough for its head and its ?), changed */
const COLS = 'grid grid-cols-[28px_minmax(0,2fr)_minmax(0,1fr)_64px_104px_minmax(0,1fr)_88px_84px] max-xl:grid-cols-[28px_minmax(0,2fr)_minmax(0,1fr)_64px_84px] max-md:grid-cols-[28px_minmax(0,1fr)_104px]';
const COLS_ALL = 'grid grid-cols-[28px_minmax(0,2fr)_minmax(0,2fr)_64px_104px_minmax(0,1fr)_88px_84px] max-xl:grid-cols-[28px_minmax(0,2fr)_minmax(0,2fr)_64px_84px] max-md:grid-cols-[28px_minmax(0,1fr)_minmax(0,1fr)]';
const XL = 'max-xl:hidden';
const MD = 'max-md:hidden';
/** The OpenFeature call that reads a flag of each type, for the Key field's hint. */
const READER: Record<string, string> = { bool: 'getBooleanValue', string: 'getStringValue', number: 'getNumberValue', json: 'getObjectValue' };
/** inline help for the terms people ask about */
const HELP = {
  envs: 'On or off in this environment, and the value everyone gets by default. How many have their own settings is counted underneath.',
  all: 'On or off in each environment. Sorting goes by the environment chosen above.',
  purpose: Object.values(KIND_INFO).join('. ') + '.',
  rules: 'How many rules decide who gets what in this environment, not counting anyone’s own settings.',
  version: 'The revision of this environment that last changed this flag. Every revision is in History.',
};
const NONE: string[] = [];
/** "a, b and 3 more" */
const some = (xs: string[], n = 3) => (xs.length <= n ? xs.join(', ') : `${xs.slice(0, n).join(', ')} and ${xs.length - n} more`);
/** One chip shape for everything small in a row (tags, the draft mark): same height, size and padding, centred on the line. */
const CHIP = 'inline-flex h-[18px] shrink-0 items-center border px-1.5 text-[11px] leading-none';
const shown = (st: EnvState) => (st.defaultVariation === CODE_DEFAULT ? 'in-app default' : fmtValue(st.defaultValue));
const DENSITY_OPTIONS = [{ value: 'comfortable' as const, label: 'Comfortable' }, { value: 'compact' as const, label: 'Compact' }];
const errText = (e: unknown) => (e as Error).message;

export function Flags({ envKey, tab: tabKey }: { envKey?: string; tab?: string }) {
  const { meta, revisionTick, toast, ask, reload } = useApp();
  const { envName, envOf, isProtected } = useEnvs();
  // memory: the list opens the way the address says, else the way you left it; the search starts empty
  const env = pageEnv(meta, envKey);
  useEffect(() => { if (envKey) writePersistent('env', envKey); }, [envKey]);
  // an environment's versions are in History now, the one home for what changed: an old link goes there
  useEffect(() => { if (tabKey === 'versions') location.replace(versionsHref(env)); }, [tabKey, env]);
  const tab: Tab = tabKey === 'conditions' ? 'conditions' : 'flags';
  const [view, setView] = useFlagView();
  const { q, status, kind, owner, tag, stale, sort, show } = view;
  const dir = view.dir === 'desc' ? 'desc' : 'asc';
  const change = (c: Partial<FlagView>) => setView({ ...view, ...c });
  const query = flagViewQuery(view);
  const openTab = (t: Tab) => go(`flags/${encodeURIComponent(env)}${t === 'flags' ? (query ? `?${query}` : '') : `/${t}`}`);
  // the address always says what the list shows, so it can be copied and shared
  useEffect(() => {
    if (tab !== 'flags' || !/^#\/?flags(\/|\?|$)/.test(location.hash)) return;
    const want = flagsHref(env, view);
    if (location.hash !== want) history.replaceState(history.state, '', want);
  }, [env, view, tab]);
  const [sizeRaw, setSize] = usePersistentState<number>('flags.size', PAGE_SIZE);
  const size = flagPageSize(sizeRaw);
  const [densityRaw, setDensity] = usePersistentState<Density>('flags.density', 'comfortable');
  const dense = density(densityRaw) === 'compact';
  const ROW = ROW_CLASS[density(densityRaw)];
  // a saved view is the list's address without "#/": "flags/prod?owner=payments" (the search included)
  const [views, setViews] = usePersistentState<SavedView<string>[]>('flags.savedViews', []);
  const [creating, setCreating] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const [tries, setTries] = useState(0);   // Try again after a failed load
  const { session: drafts, summary: draft } = useDraft(env);

  const filters: FlagFilters = { env, q: q.trim(), status, kind, owner, tag, stale, sort, dir };
  const filterKey = [q.trim(), env, status, kind, owner, tag, stale, sort, dir, size].join('|');
  const paging = useServerPage<FlagPage>((page) => flagListPath(filters, page, size), filterKey, `${revisionTick}:${tries}`);
  const rows = tab === 'flags' ? paging.data?.rows ?? [] : [];
  // every page's answer lists the owners and tags in use; the shown answer stays while the next one loads
  const owners = paging.data?.owners ?? NONE;
  const tagsInUse = paging.data?.tags ?? NONE;
  // the selection stays while you page; a new search or filter starts over
  const sel = useKeptSelection([q.trim(), env, status, kind, owner, tag, stale].join('|'));
  const keys = useListKeys({
    count: rows.length,
    onOpen: (i) => go(`flag/${rows[i].key}/${env}`),
    onToggle: (i) => sel.toggle(rows[i]),
    onClear: () => sel.clear(),
    enabled: tab === 'flags' && !creating && !reviewing,
  });
  // "/" puts the cursor in the search box
  useSlashFocus(search, tab === 'flags');

  const onSort = (k: string, d: 'asc' | 'desc') => change({ sort: k, dir: d });
  const needsReview = isProtected(env);
  const chosen = sel.rows;
  const filtered = !!(q || status || kind || owner || tag || stale);
  const reset = () => change({ q: '', status: '', kind: '', owner: '', tag: '', stale: '' });
  const envs = meta.environments.map((e) => e.key);
  const all = show === 'all';
  const cols = all ? COLS_ALL : COLS;
  const day = today();
  const matched = paging.data?.matched ?? 0;
  const steps = setupSteps(meta, paging.data?.all);

  // ---- bulk actions. How each switch goes through is policy.ts switchPlan, the same call the switch on a flag's page
  // makes: now where nothing is reviewed, a request in a protected environment, or break-glass for on call turning a
  // kill switch or ops flag off. What goes now is one publish (one version), what is reviewed is one request.
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
        {rv > 0 && <p>{bg ? `${some(plan.review)} ${rv === 1 ? 'goes' : 'go'} to an approver first.` : rv === 1 ? 'The change goes to an approver first.' : 'They go to an approver first, as one request.'}</p>}
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
  /** Turns the flags on or off (the switch is never drafted: on call it must act now). Each flag's settings are read
   *  first, then what goes now is one publish and what is reviewed is one request, both all or nothing
   *  (POST /environments/:env/publish). Break-glass goes one flag at a time, as the server logs each. Undo from the
   *  toast for what went live where nothing is reviewed. */
  const applyEnabled = async (steps: { key: string; path: SwitchPath }[], on: boolean, reason: string | undefined, offerUndo: boolean) => {
    const where = `in ${envName(env).toLowerCase()}`;
    const again = () => applyEnabled(steps, on, reason, offerUndo);
    setBusy(`Reading ${plural(steps.length, 'flag')}…`);
    let details: FlagDetail[];
    try { details = await mapLimit(steps, 6, (s) => api<FlagDetail>('GET', flagPath(s.key))); }
    catch (e) { setBusy(null); toast(`Nothing changed ${where}: couldn’t read the flags (${errText(e)})`, 'err', { label: 'Retry', onClick: again }); return; }
    const byKey = new Map(details.map((d) => [d.key, d]));
    const pick = (ks: string[]) => ks.flatMap((k) => byKey.get(k) ?? []);
    const batches = switchBatches(steps);
    const applied: string[] = []; const broke: string[] = []; let reviewed = 0; const failed: typeof steps = []; let why = '';
    for (const [path, ks] of [['now', batches.now], ['review', batches.review]] as const) {
      const items = switchItems(pick(ks), env, on);
      if (!items.length) continue;
      setBusy(path === 'now' ? `Turning ${on ? 'on' : 'off'} ${plural(items.length, 'flag')}…` : `Requesting review of ${plural(items.length, 'change')}…`);
      try {
        const res = await api<SaveResult>('POST', `/environments/${encodeURIComponent(env)}/publish`, { items, reason });
        if (res.applied) applied.push(...items.map((i) => i.flag)); else reviewed += items.length;
      } catch (e) { failed.push(...items.map((i) => ({ key: i.flag, path }))); why ||= errText(e); }
    }
    for (const [i, key] of batches.breakGlass.entries()) {
      const item = switchItems(pick([key]), env, on)[0];
      if (!item) continue;
      setBusy(`Turning off ${i + 1} of ${batches.breakGlass.length} by break-glass…`);
      try {
        const res = await api<SaveResult>('PUT', `/flags/${encodeURIComponent(key)}/layers/${encodeURIComponent(env)}/base`, {
          layer: item.layer, expectedVersion: item.expectedVersion, reason, bypassReason: reason,
        });
        if (!res.applied) reviewed++; else broke.push(key);
      } catch (e) { failed.push({ key, path: 'break-glass' }); why ||= errText(e); }
    }
    setBusy(null); sel.clear(); reload().catch(() => {});
    void drafts.noteChanged([...applied, ...broke]);               // a draft made since on these flags is stale now
    const text = [applied.length && `Turned ${on ? 'on' : 'off'} ${plural(applied.length, 'flag')} ${where}`,
      broke.length && `Turned off ${plural(broke.length, 'flag')} ${where} by break-glass (logged)`,
      reviewed && `${plural(reviewed, 'change')} sent for review`,
      failed.length && `${plural(failed.length, 'flag')} not changed (${some(failed.map((f) => f.key))}): ${why}`].filter(Boolean).join(' · ') || `Nothing to change ${where}`;
    // a failure offers Retry for just the failed ones; a clean run offers Undo
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
      try { await api('POST', `/flags/${encodeURIComponent(f.key)}/archive`); } catch (e) { failed.push(f); why ||= errText(e); }
    }
    setBusy(null); sel.clear(); reload().catch(() => {});
    const done = list.length - failed.length;
    toast([done && `Archived ${plural(done, 'flag')}`, failed.length && `${plural(failed.length, 'flag')} not archived (${some(failed.map((f) => f.key))}): ${why}`].filter(Boolean).join(' · '),
      failed.length ? 'err' : 'ok', failed.length ? { label: 'Retry', onClick: () => archive(failed) } : undefined);
  };
  /** The selected flags, or with none selected every flag the filters match (all pages), as a CSV. */
  const exportCsv = async (picked?: Row[]) => {
    let list = picked;
    if (!list) {
      setBusy('Exporting…');
      try { list = await allMatching(filters); } catch (e) { setBusy(null); toast(`Couldn’t export: ${errText(e)}`, 'err'); return; }
      setBusy(null);
    }
    const table = flagsCsv(list, envs);
    downloadCsv(`flags-${env}.csv`, table.header, table.rows);
    toast(`Exported ${plural(list.length, 'flag')} to flags-${env}.csv`);
  };
  const selectAllMatching = async () => {
    setBusy('Selecting…');
    try { sel.choose(await allMatching(filters)); } catch (e) { toast(`Couldn’t select them all: ${errText(e)}`, 'err'); }
    setBusy(null);
  };
  const here = flagsHref(env, view).slice(2);       // "flags/prod?owner=payments", as a saved view keeps it
  const statusCell = (st: EnvState | undefined, full: boolean) => !st ? <span className="text-ink-3">—</span> : <>
    <OnOff on={!!st.enabled} />
    {full && <span className={cn('truncate font-mono text-xs text-ink-3', dense ? 'ml-2' : 'block')} title={shown(st)}>{shown(st)}{st.entityLayers ? <span className="font-sans">, {st.entityLayers.toLocaleString()} with own settings</span> : null}</span>}
  </>;

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
        <FilterSelect label="Environment" value={env} onChange={(v) => go(tab === 'flags' ? flagsHref(v, view).slice(2) : `flags/${encodeURIComponent(v)}/${tab}`)} options={meta.environments.map((e) => [e.key, envName(e.key)] as [string, string])} />
      </PageBar>

      <div className="flex items-center gap-4 border-b border-rule px-6 max-sm:px-4">
        <Tabs<Tab> label="Flags sections" value={tab} onChange={openTab} className="border-b-0"
          items={[{ value: 'flags', label: 'Flags' }, { value: 'conditions', label: 'Conditions' }]} />
        <span className="flex-1" />
        <a href={versionsHref(env)} className="text-13 text-ink-2">Revisions of {envName(env).toLowerCase()} in History →</a>
      </div>

      {/* unfinished work stays in view; with no draft, a protected environment says what publishing means here */}
      {draft.flags.length > 0 ? <DraftBar env={env} onReview={() => setReviewing(true)} />
        : needsReview && <div className="flex items-center gap-2 border-b border-grid px-6 py-2 text-13 text-flag max-sm:px-4"><LockSimpleIcon aria-hidden className="size-3.5" />{envName(env)} is protected: publishing sends your draft to an approver first.</div>}

      {tab === 'conditions' && <ConditionsTab env={env} />}

      {tab === 'flags' && <>
        {/* while a step of the checklist isn't done (dimensions are optional, so never one of them), what's left */}
        {paging.data && setupLeft(steps) && <FinishSetup flags={paging.data.all} onNewFlag={mayChange ? () => setCreating(true) : undefined} />}
        <div className="flex flex-wrap items-center gap-2 border-b border-grid px-6 py-2.5 max-sm:px-4">
          <SearchField ref={search} className="w-[260px] max-md:w-auto max-md:flex-1 max-md:basis-full" data-search="flags" placeholder="Search  /" value={q} onChange={(e) => change({ q: e.target.value })} aria-label="Search flags" />
          <FilterSelect label="Status" value={status} onChange={(v) => change({ status: v })} options={[['', 'All'], ['on', `On in ${envName(env).toLowerCase()}`], ['off', `Off in ${envName(env).toLowerCase()}`]]} />
          <FilterSelect label="Purpose" value={kind} onChange={(v) => change({ kind: v })} options={[['', 'All'], ...Object.keys(KIND_INFO).map((k) => [k, kindName(k)] as [string, string])]} />
          <FilterSelect label="Owner" value={owner} onChange={(v) => change({ owner: v })} options={[['', 'All'], ...owners.map((o) => [o, o] as [string, string])]} />
          {/* the tags in use come with the list: the filter keeps its place while it loads */}
          {(tagsInUse.length > 0 || !paging.data) && <FilterSelect label="Tag" value={tag} onChange={(v) => change({ tag: v })} options={[['', 'All'], ...tagsInUse.map((t) => [t, t] as [string, string])]} />}
          <FilterSelect label="Remove by" value={stale} onChange={(v) => change({ stale: v })} options={[['', 'Any'], ['overdue', 'Overdue']]} />
          {envs.length > 1 && <FilterSelect label="Show" value={show} onChange={(v) => change({ show: v })} options={[['', envName(env)], ['all', 'All environments']]} />}
          <ViewMenu views={views} current={here} onApply={(v) => go(v)} onChange={setViews} />
          <button type="button" onClick={() => void copyText(location.href, 'the link to this list', toast)} className={barTextButton}>Copy link</button>
          {filtered && <button type="button" onClick={reset} className={barTextButton}>Reset</button>}
          <span className="flex-1" />
          {paging.data && matched > 0 && <button type="button" disabled={!!busy} onClick={() => void exportCsv()} className={barTextButton}>{filtered ? `Export ${matched.toLocaleString()} matching` : 'Export all'}</button>}
        </div>

        <div role="table" aria-label="Flags" aria-busy={paging.loading} className={cn('flex-1', paging.loading && 'opacity-70')}>
          <div role="row" className={cn(cols, tableHeadClass)}>
            <RowCheck head checked={sel.pageAll(rows)} indeterminate={sel.pageSome(rows)} onChange={() => sel.togglePage(rows)} label="Select all on this page" />
            <SortHeader label="Flag" sortKey="key" sort={sort} dir={dir} onSort={onSort} />
            {all ? (
              <span role="columnheader" className="grid min-w-0 gap-x-2" style={{ gridTemplateColumns: `repeat(${envs.length}, minmax(0, 1fr))` }} title={HELP.all}>
                {envs.map((e) => e === env ? <SortHeader key={e} label={envName(e)} sortKey="status" sort={sort} dir={dir} onSort={onSort} />
                  : <span key={e} className="truncate">{envName(e)}</span>)}
              </span>
            ) : <SortHeader label={envName(env)} sortKey="status" sort={sort} dir={dir} onSort={onSort} help={HELP.envs} />}
            <ColumnHead className={MD} label="Rules" help={HELP.rules} />
            <span className={XL}><SortHeader label="Purpose" sortKey="kind" sort={sort} dir={dir} onSort={onSort} help={HELP.purpose} /></span>
            <span className={XL}><SortHeader label="Owner" sortKey="owner" sort={sort} dir={dir} onSort={onSort} /></span>
            <ColumnHead className={XL} label="Revision" help={HELP.version} />
            <span className={MD}><SortHeader label="Changed" sortKey="changed" sort={sort} dir={dir} onSort={onSort} /></span>
          </div>
          {paging.error ? <Callout tone="error" role="alert" className="m-6 max-sm:m-4">Couldn’t load flags: {paging.error} <Button variant="secondary" className="ml-2" onClick={() => setTries((t) => t + 1)}>Try again</Button></Callout>
            : !paging.data ? <SkeletonRows cols={cols} cells={['', '', '', MD, XL, XL, XL, MD]} rowClass={ROW} />
            : rows.length === 0 ? (
              <div className="px-6 py-10">
                <Empty action={filtered ? <Button variant="secondary" onClick={reset}>{status || kind || owner || tag || stale ? 'Clear filters' : 'Clear search'}</Button> : mayChange ? <Button onClick={() => setCreating(true)}>+ New flag</Button> : undefined}>
                  {filtered
                    ? `No flags match ${[q.trim() && `“${q.trim()}”`, status && `${status} in ${envName(env).toLowerCase()}`, kind && `purpose ${kindName(kind).toLowerCase()}`, owner && `owner ${owner}`, tag && `tag ${tag}`, stale && 'past their remove-by date'].filter(Boolean).join(', ')}.`
                    : 'No flags yet. A flag lets you turn a feature on or off, or change a value, without shipping a new build.'}
                </Empty>
              </div>
            ) : rows.map((f, i) => {
              const late = isOverdue(f.removeBy, day);
              return (
                <div key={f.key} role="row" data-row-index={i} data-active={keys.active === i} data-selected={sel.isSelected(f.key) || undefined}
                  onClick={() => { keys.setActive(i); go(`flag/${f.key}/${env}`); }} onPointerEnter={() => { void prefetch(flagPath(f.key)); }}
                  className={cn(cols, tableRowClass, ROW, 'cursor-default')}>
                  <RowCheck checked={sel.isSelected(f.key)} onChange={() => sel.toggle(f)} label={`Select ${f.key}`} />
                  <span role="cell" className="min-w-0" title={f.description ?? undefined}>
                    {/* the flag's address: Tab reaches it, Enter opens it, and it opens in a new tab like any link.
                        Comfortable: two fixed-height lines (the name and the draft mark, then the key and tags). Compact: one */}
                    <a href={`#/flag/${encodeURIComponent(f.key)}/${encodeURIComponent(env)}`} onClick={(e) => { e.stopPropagation(); keys.setActive(i); }}
                      onFocus={() => { void prefetch(flagPath(f.key)); }} className={cn('min-w-0 text-ink no-underline hover:no-underline', dense ? 'flex h-5 items-center gap-2' : 'block')}>
                      <span className="flex h-5 min-w-0 items-center gap-2">
                        {f.name ? <span className="truncate text-13 font-medium text-ink">{f.name}</span> : <span className="truncate font-mono text-13 font-medium">{f.key}</span>}
                        {draft.has(f.key) && <span title="In your draft: unpublished changes to this flag" className={cn(CHIP, 'border-flag/40 bg-flag-bg font-medium text-flag')}>Draft</span>}
                        {late && <span title={`Past its remove-by date, ${f.removeBy}: clean it up`} className={cn(CHIP, 'border-live/40 font-medium text-live')}>Overdue</span>}
                      </span>
                      <span className={cn('flex h-[18px] min-w-0 items-center gap-1.5', !dense && 'mt-0.5')}>
                        {f.name ? <span className="max-w-full shrink-0 truncate font-mono text-xs leading-none text-ink-3">{f.key}</span> : !dense && <span className="min-w-0 truncate text-xs leading-none text-ink-3">{f.description}</span>}
                        {!dense && <span className="flex min-w-0 items-center gap-1 overflow-hidden" title={f.tags.join(', ') || undefined}>
                          {f.tags.map((t) => <span key={t} className={cn(CHIP, 'border-rule font-mono text-ink-2')}>{t}</span>)}
                        </span>}
                      </span>
                    </a>
                  </span>
                  {all ? (
                    <span role="cell" className="grid min-w-0 items-center gap-x-2" style={{ gridTemplateColumns: `repeat(${envs.length}, minmax(0, 1fr))` }}>
                      {envs.map((e) => {
                        const st = f.envs[e];
                        return <span key={e} className="min-w-0 truncate" title={`${envName(e)}: ${st ? `${st.enabled ? 'on' : 'off'}, everyone gets ${shown(st)}` : 'no settings'}`}>{statusCell(st, false)}</span>;
                      })}
                    </span>
                  ) : <span role="cell" className={cn('min-w-0', dense && 'flex items-center')}>{statusCell(f.envs[env], true)}</span>}
                  <span role="cell" className={cn(MD, 'font-mono text-13', f.envs[env]?.rules ? 'text-ink' : 'text-ink-3')}>{f.envs[env]?.rules ?? 0}</span>
                  <span role="cell" className={XL}>{f.kind === 'release'
                    ? <a href={`#/flag/${encodeURIComponent(f.key)}/${encodeURIComponent(env)}/rollout`} onClick={(e) => e.stopPropagation()} title="Open its rollout" className="no-underline hover:no-underline"><Badge>{kindName(f.kind)} →</Badge></a>
                    : <Badge>{kindName(f.kind)}</Badge>}</span>
                  <span role="cell" className={cn(XL, 'truncate text-ink-2')}>{f.owner ?? <span className="text-ink-3">—</span>}</span>
                  <span role="cell" className={cn(XL, 'font-mono text-13 text-ink-2')}>{f.lastVersion ? `#${f.lastVersion}` : '—'}</span>
                  <span role="cell" className={MD}><When iso={f.changedAt} /></span>
                </div>
              );
            })}
        </div>

        <div className={cn('flex flex-wrap items-center gap-4 border-t border-rule px-6 max-sm:px-4', pagerRow)}>
          <KeyHints className="max-md:hidden" />
          <span className="flex-1" />
          <Segmented label="Density" value={density(densityRaw)} onChange={setDensity} options={DENSITY_OPTIONS} />
          <FilterSelect label="Rows" value={String(size)} onChange={(v) => setSize(Number(v))} options={FLAG_PAGE_SIZES.map((n) => [String(n), String(n)] as [string, string])} />
          {paging.data && <Pager page={paging.page} size={paging.size} matched={paging.data.matched} noun="flags" onPage={(p) => { paging.go(p); keys.setActive(-1); }} />}
        </div>

        <BulkBar count={sel.count} onClear={sel.clear}>
          {busy ? <span className="text-13 text-ink-2">{busy}</span> : <>
            <Button variant="outline" disabled={!mayChange} onClick={() => setEnabled(false)}>Turn off in {envName(env).toLowerCase()}</Button>
            <Button variant="outline" disabled={!mayChange} onClick={() => setEnabled(true)}>Turn on in {envName(env).toLowerCase()}</Button>
            <Button variant="outline" onClick={() => void exportCsv(chosen)}>Export CSV</Button>
            <Button variant="stop" disabled={!mayChange} onClick={() => archive()}>Archive</Button>
            {sel.count < matched && <button type="button" onClick={() => void selectAllMatching()} className={barTextButton}>Select all {matched.toLocaleString()} matching</button>}
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

const TEMPLATE_OPTIONS = [{ value: 'blank', label: 'Blank' }, { value: 'ai', label: 'AI config' }];

const startRows = (type: string): ValueRow[] => type === 'bool'
  ? [{ key: 'on', text: 'true', isNew: true }, { key: 'off', text: 'false', isNew: true }]
  : [{ key: 'default', text: type === 'number' ? '0' : type === 'json' ? '{}' : '', isNew: true }];

function CreateFlag({ onClose, owners, tagsInUse }: { onClose: () => void; owners: string[]; tagsInUse: string[] }) {
  const { meta, toast } = useApp();
  const { envName, isProtected } = useEnvs();
  // the readable name comes first; the key follows it until you edit the key yourself
  const [name, setName] = useState('');
  const [key, setKeyRaw] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const setKey = (k: string) => { setKeyEdited(true); setKeyRaw(k); };
  const onName = (n: string) => {
    setName(n);
    if (!keyEdited) setKeyRaw(keyFromName(n));
    if (template === 'ai' && !descEdited) setDescriptionRaw(aiConfigTemplate(n).description);
  };
  const [owner, setOwner] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [valueType, setValueType] = useState('bool');
  const [kind, setKind] = useState('release');
  const [description, setDescriptionRaw] = useState('');
  const [descEdited, setDescEdited] = useState(false);
  const setDescription = (d: string) => { setDescEdited(true); setDescriptionRaw(d); };
  // a template fills the form (flagTemplates.ts); everything stays editable
  const [template, setTemplate] = useState('blank');
  // a JSON flag's JSON Schema (server/jsonSchema.ts), as typed: empty for none
  const [schema, setSchema] = useState('');
  const [removeBy, setRemoveBy] = useState(() => new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10));
  const [rows, setRows] = useState<ValueRow[]>(startRows('bool'));
  // what everyone gets: a named value, so the first read answers with one (the code default stays a choice)
  const [defPick, setDef] = useState<string>(() => startDefault(startRows('bool'), 'bool'));
  // variants on (named values to pick from), or free values: any value typed into the rules. On/off flags always have
  // their two variants
  const [named, setNamed] = useState(true);
  const free = valueType !== 'bool' && !named;
  const [first, setFirst] = useState('');
  // a new flag goes to every service, apps and backends: a backend reads only the flags it is in
  const [delivery, setDelivery] = useState<string[]>(() => newFlagServices(meta.services));
  const { busy, error, run } = useAsync();

  const keyError = key && !/^[a-z][a-z0-9_]*$/.test(key) ? 'Start with a letter; use lowercase letters, digits and _' : null;
  const tagError = cleanTags(tags).problem;
  const nameError = flagNameProblem(name);
  const valuesInvalid = free ? !!valueError(valueType, first) : rows.some((r) => rowError(valueType, r, rows));
  const typedSchema = valueType === 'json' ? readSchemaText(schema) : { schema: null, error: null };
  // the values that don't match the schema, as the server would refuse them: "fast: model is required"
  const mismatch = typedSchema.schema && !valuesInvalid
    ? firstMismatch(typedSchema.schema, free ? [{ key: 'The value everyone gets', value: fromText(valueType, first) }] : rows.map((r) => ({ key: r.key, value: fromText(valueType, r.text) })))
    : null;
  const needsRemoveBy = removeByRequired(kind);
  // what everyone gets where the flag starts on, in words for the line above Create
  // a renamed or removed value can't stay the default: the first one is, then
  const def = defPick === CODE_DEFAULT || rows.some((r) => r.key === defPick) ? defPick : startDefault(rows, valueType);
  const defRow = rows.find((r) => r.key === def);
  const served = free ? (first ? first : '') : def === CODE_DEFAULT || !defRow ? '' : defRow.text && defRow.text !== def ? `${def} (${defRow.text})` : def;
  const canSubmit = !!key && !keyError && !tagError && !nameError && (free || rows.length > 0) && !valuesInvalid && !typedSchema.error && !mismatch && !busy;

  const setType = (t: string) => { setValueType(t); setRows(startRows(t)); setDef(startDefault(startRows(t), t)); setFirst(''); setSchema(''); };
  const chooseTemplate = (t: string) => {
    setTemplate(t);
    if (t === 'ai') {
      const tpl = aiConfigTemplate(name);
      setValueType(tpl.valueType); setKind(tpl.kind); setNamed(true); setFirst('');
      setRows(tpl.variants.map((v) => ({ key: v.key, text: toText(tpl.valueType, v.value), isNew: true })));
      setDef(tpl.defaultVariation);
      setSchema(schemaText(tpl.jsonSchema));
      if (!descEdited || !description.trim()) { setDescriptionRaw(tpl.description); setDescEdited(false); }
    } else {
      setType('bool'); setKind('release');
      if (!descEdited) setDescriptionRaw('');
    }
  };

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
      ...(typedSchema.schema ? { jsonSchema: typedSchema.schema } : {}),
      delivery: Object.fromEntries(meta.environments.map((e) => [e.key, delivery])),
    }));
    // a release opens on its release page (Releases.tsx), where its first step is chosen
    if (res) { toast(`Created ${name.trim() || key}`); onClose(); go(`flag/${key}`); }
  };

  return (
    <Modal title="New flag" onClose={onClose} wide footer={
      <Actions>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button disabled={!canSubmit} onClick={submit}>{busy ? 'Creating…' : 'Create flag'}</Button>
      </Actions>
    }>
      <div className="grid gap-1.5">
        <span className={monoLabel}>Start from</span>
        <Segmented className="justify-self-start" label="Start from" value={template} onChange={chooseTemplate} options={TEMPLATE_OPTIONS} />
        {template === 'ai' && <span className="text-13 text-ink-3">A JSON config for an AI feature: its model, prompt and settings, with two variants to compare and a JSON Schema they must match.</span>}
      </div>
      <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
        <Field label="Name" hint={nameError ? <span className="text-live">{nameError}</span> : 'What people see in the list, e.g. New search ranking.'}>
          <Input data-autofocus value={name} placeholder="New search ranking" aria-invalid={!!nameError} onChange={(e) => onName(e.target.value)} />
        </Field>
        <Field label="Key" required hint={keyError ? <span className="text-live">{keyError}</span> : (
          <>What your code reads, e.g. <span className="font-mono text-ink-2">{READER[valueType] ?? 'getBooleanValue'}("{key || 'new_search_ranking'}")</span>. It can’t be changed later.</>
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
            {rows.filter((r) => r.key).map((r) => <option key={r.key} value={r.key}>{r.key}{r.text && r.text !== r.key ? ` (${r.text})` : ''}</option>)}
            <option value={CODE_DEFAULT}>In-app default (send nothing: apps use the default in their code)</option>
          </NativeSelect>
        </Field>
      </>}
      {valueType === 'json' && (
        <Field label="JSON Schema" hint={typedSchema.error || mismatch ? <span className="text-live">{typedSchema.error ?? mismatch}</span>
          : 'Optional. Every value of this flag must match it, so a field can’t go missing.'}>
          <textarea rows={6} spellCheck={false} value={schema} placeholder={'{ "type": "object", "required": ["model"] }'} aria-invalid={!!typedSchema.error || !!mismatch}
            onChange={(e) => setSchema(e.target.value)} className={cn(textareaField, 'rounded-none font-mono text-13')} />
        </Field>
      )}

      <div className="grid gap-1.5" role="group" aria-label="Services">
        <span className={monoLabel}>Services</span>
        {meta.services.length === 0 ? <NoServices /> : <>
          <div className="flex flex-wrap gap-x-5 gap-y-2 py-1">
            {meta.services.map((p) => (
              <Switch key={p.key} label={p.key} checked={delivery.includes(p.key)}
                onChange={(on) => setDelivery(on ? [...delivery, p.key] : delivery.filter((x) => x !== p.key))}>
                <span className="font-mono text-13 text-ink">{p.key}</span>
              </Switch>
            ))}
          </div>
          <span className="text-13 text-ink-3">{SERVICES_HINT}</span>
        </>}
      </div>
      {meta.environments.length > 0 && <p className="m-0 text-13 text-ink-2">{startsLine(meta.environments.map((e) => ({ name: envName(e.key), reviewed: isProtected(e.key) })), served)}</p>}
      <ErrorList error={error} />
    </Modal>
  );
}
