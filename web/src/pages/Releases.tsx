// Releases (docs/content/docs/guide/releases.md): every release and where it is in one environment, then a new release. A release is
// a flag of kind 'release': its step is read from the flag's defaults (server/release.ts), so nothing is stored for it
// apart from the flag, and release flags are still on the Flags page too.
//   #/releases/<env>         this list, in one environment (the last one used when none is given)
//   #/flag/<key>/<env>/rollout    one release: its flag's page, on its Rollout tab (ReleasePage.tsx)
import { useEffect, useRef, useState } from 'react';
import { Badge as UIBadge } from '@companyflags/ui/components/badge';
import { Button } from '@companyflags/ui/components/button';
import { Callout } from '@companyflags/ui/components/callout';
import { ColumnHead, tableHeadClass, tableRowClass } from '@companyflags/ui/components/data-table';
import { Input } from '@companyflags/ui/components/input';
import { barTextButton, FilterSelect, PageBar } from '@companyflags/ui/components/page-bar';
import { SearchField } from '@companyflags/ui/components/search-field';
import { cn } from '@companyflags/ui/lib/utils';
import { api, prefetch } from '../api.ts';
import { go, useApp } from '../app.ts';
import { CountSlot, SkeletonRows } from '../loading.tsx';
import { pagerRow } from '../loadingKit.ts';
import { flagPath, pageEnv, releaseListPath } from '../paths.ts';
import { writePersistent } from '../persist.ts';
import { Actions, ChipInput, Empty, ErrorList, Field, Modal, Pager, Segmented, Switch, When } from '../ui.tsx';
import { fmtDate, useAsync, usePersistentState, useServerPage, useSlashFocus } from '../uiKit.ts';
import { cleanTags, flagNameProblem, keyFromName, normalizeTag } from '../../../server/checks.ts';
import { releaseVersionProblem } from '../../../server/semver.ts';
import { hiddenKey } from '../../../server/evaluator.ts';
import { useEnvs } from './envs.ts';
import { StepBar, type ReleaseList, type ReleaseRow } from './releaseParts.tsx';
import { NoServices } from './setup.tsx';
import { newFlagServices } from './flagsKit.ts';
import { roleInfo } from '../../../server/policy.ts';

const MD = 'max-md:hidden';
/** the release, its step here, when it last changed here, the owner, the remove-by date */
const COLS = 'grid grid-cols-[minmax(0,2fr)_minmax(0,1.6fr)_110px_minmax(0,1fr)_120px] max-md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]';
/** a taller row than the other lists: the step and its bar get room */
const ROW = 'min-h-[76px] py-3.5';

export function Releases({ envKey }: { envKey?: string }) {
  const { meta, revisionTick } = useApp();
  const { envName } = useEnvs();
  // the environment the list shows: the one in the address, else the last one used (shared with Flags)
  const env = pageEnv(meta, envKey);
  useEffect(() => { if (envKey) writePersistent('env', envKey); }, [envKey]);
  const where = envName(env).toLowerCase();
  const [q, setQ] = useState('');
  const [show, setShow] = usePersistentState('releases.show', '');
  const [owner, setOwner] = usePersistentState('releases.owner', '');
  const [creating, setCreating] = useState(false);
  const [tries, setTries] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  useSlashFocus(search);
  const paging = useServerPage<ReleaseList>((page) => releaseListPath(env, show, owner, q.trim(), page), [env, q.trim(), show, owner].join('|'), `${revisionTick}:${tries}`);
  const rows = paging.data?.rows ?? [];
  const owners = paging.data?.owners ?? [];
  const filtered = !!(q || show || owner);
  const reset = () => { setQ(''); setShow(''); setOwner(''); };
  // viewers can look but not change anything (server/access.ts): no form the server would refuse
  const mayChange = roleInfo(meta.me.role).changes;
  const SHOW: [string, string][] = [['', 'All'], ['rolling', `Rolling out in ${where}`], ['not_started', `Not started in ${where}`], ['done', 'Ready to clean up'], ['overdue', 'Overdue']];

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <PageBar title="Releases" count={<CountSlot text={paging.data ? (filtered ? `${paging.data.matched} of ${paging.data.all}` : String(paging.data.all)) : undefined} />}
        actions={mayChange ? <Button onClick={() => setCreating(true)}>+ New release</Button> : <span className="text-13 text-ink-3">Viewers can look but not change anything</span>}>
        <FilterSelect label="Environment" value={env} onChange={(v) => go(`releases/${v}`)} options={meta.environments.map((e) => [e.key, envName(e.key)] as [string, string])} />
      </PageBar>

      <p className="m-0 border-b border-grid px-6 py-2.5 text-13 text-ink-2 max-sm:px-4">
        A release turns a new feature on step by step: a growing % of devices, then everyone, with early access for some first if you like. Then the flag is removed. A version release moves devices from one version to the next the same way, and stays.
      </p>

      <div className="flex flex-wrap items-center gap-2 border-b border-grid px-6 py-2.5 max-sm:px-4">
        <SearchField ref={search} className="w-[260px] max-md:w-auto max-md:flex-1 max-md:basis-full" placeholder="Search  /" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search releases" />
        <FilterSelect label="Show" value={show} onChange={setShow} options={SHOW} />
        {/* the owners come with the list: the filter keeps its place while it loads */}
        {(owners.length > 0 || !paging.data) && <FilterSelect label="Owner" value={owner} onChange={setOwner} options={[['', 'All'], ...owners.map((o) => [o, o] as [string, string])]} />}
        {filtered && <button type="button" onClick={reset} className={barTextButton}>Reset</button>}
      </div>

      <div role="table" aria-label="Releases" aria-busy={paging.loading} className={cn('flex-1', paging.loading && 'opacity-70')}>
        <div role="row" className={cn(COLS, tableHeadClass)}>
          <ColumnHead label="Release" />
          <ColumnHead label={`Step in ${where}`} help="Where the release is in this environment: not started, early access only, a % of devices, or everyone. Pick another environment at the top." />
          <ColumnHead label="Changed" className={MD} />
          <ColumnHead label="Owner" className={MD} />
          <ColumnHead label="Remove by" className={MD} help="Releases are temporary: remove the flag by this date. A version release stays." />
        </div>
        {paging.error ? <Callout tone="error" role="alert" className="m-6 max-sm:m-4">Couldn’t load releases: {paging.error} <Button variant="secondary" className="ml-2" onClick={() => setTries((t) => t + 1)}>Try again</Button></Callout>
          : !paging.data ? <SkeletonRows cols={COLS} cells={['', '', MD, MD, MD]} rowClass={ROW} />
          : rows.length === 0 ? (
            <div className="px-6 py-10">
              <Empty action={filtered ? <Button variant="secondary" onClick={reset}>Clear filters</Button> : mayChange ? <Button onClick={() => setCreating(true)}>+ New release</Button> : undefined}>
                {filtered ? 'No releases match.' : 'No releases yet. A release turns a new feature on step by step, then is removed.'}
              </Empty>
            </div>
          ) : rows.map((r) => <Row key={r.key} r={r} env={env} />)}
      </div>

      <div className={cn('flex flex-wrap items-center gap-4 border-t border-rule px-6 max-sm:px-4', pagerRow)}>
        <span className="flex-1" />
        {paging.data && <Pager page={paging.page} size={paging.size} matched={paging.data.matched} noun="releases" onPage={paging.go} />}
      </div>

      {creating && <CreateRelease onClose={() => setCreating(false)} owners={owners} />}
    </div>
  );
}

function Row({ r, env }: { r: ReleaseRow; env: string }) {
  const href = `#/flag/${encodeURIComponent(r.key)}/${encodeURIComponent(env)}/rollout`;
  const s = r.envs[env] ?? null;
  return (
    <div role="row" onClick={() => go(`flag/${r.key}/${env}/rollout`)} onPointerEnter={() => { void prefetch(flagPath(r.key)); }}
      className={cn(COLS, tableRowClass, ROW, 'cursor-default')}>
      <span role="cell" className="min-w-0">
        <a href={href} onClick={(e) => e.stopPropagation()} className="block min-w-0 text-ink no-underline hover:no-underline">
          <span className="flex min-w-0 items-center gap-2">
            <span className={cn('truncate text-sm font-medium', !r.name && 'font-mono')}>{r.name ?? r.key}</span>
          </span>
          <span className="mt-1 flex min-w-0 items-center gap-1.5 overflow-hidden" title={r.tags.join(', ') || undefined}>
            {r.name && <span className="shrink-0 truncate font-mono text-xs text-ink-3">{r.key}</span>}
            {r.tags.map((t) => <span key={t} className="inline-flex h-[18px] shrink-0 items-center border border-rule px-1.5 font-mono text-[11px] leading-none text-ink-2">{t}</span>)}
          </span>
        </a>
      </span>
      <span role="cell" className="min-w-0">
        {s ? <>
          <span className="block truncate text-sm text-ink" title={s.text}>{s.sent ? s.text : <span className="text-ink-3">In no service</span>}</span>
          <StepBar state={s} className="mt-2 h-2 max-w-[240px]" />
          {s.waiting && <span className="mt-1.5 block text-xs text-flag">Waiting · request #{s.waiting.id}</span>}
          {r.ready && <UIBadge variant="ok" className="mt-1.5" title="Everyone has it wherever it’s sent: remove it from the code, then archive it">Ready to clean up</UIBadge>}
        </> : <span className="text-ink-3">—</span>}
      </span>
      <span role="cell" className={MD}><When iso={s?.changedAt} /></span>
      <span role="cell" className={cn(MD, 'truncate text-13 text-ink-2')}>{r.owner ?? <span className="text-ink-3">—</span>}</span>
      <span role="cell" className={cn(MD, 'text-13', r.overdue ? 'font-medium text-live' : 'text-ink-2')}
        title={r.overdue ? 'Past its remove-by date' : s?.versions && !r.removeBy ? 'A version release stays: each new version moves through the same steps' : undefined}>
        {r.removeBy ? fmtDate(r.removeBy) : s?.versions ? 'Stays' : '—'}
        {r.overdue && <span className="block text-xs">Overdue</span>}
      </span>
    </div>
  );
}

/** A new release: an on/off flag of kind release that starts "not started" everywhere (off where the environment
 *  needs review, server/control.ts createFlag), or a version release (docs/content/docs/guide/releases.md) that starts with
 *  everyone on its first version and has no remove-by date. Who gets it first is chosen on its page. */
function CreateRelease({ onClose, owners }: { onClose: () => void; owners: string[] }) {
  const { meta, toast } = useApp();
  const [what, setWhat] = useState<'feature' | 'versions'>('feature');
  const versions = what === 'versions';
  const [first, setFirst] = useState('1.0.0');
  const firstError = versions ? releaseVersionProblem(first) : null;
  const [name, setName] = useState('');
  const [key, setKeyRaw] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const onName = (n: string) => { setName(n); if (!keyEdited) setKeyRaw(keyFromName(n)); };
  const [description, setDescription] = useState('');
  const [owner, setOwner] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [removeBy, setRemoveBy] = useState(() => new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10));
  // every service, apps and backends, as a new flag (flagsKit.ts)
  const [apps, setApps] = useState<string[]>(() => newFlagServices(meta.services));
  const { busy, error, run } = useAsync();
  const keyError = key && !/^[a-z][a-z0-9_]*$/.test(key) ? 'Start with a letter; use lowercase letters, digits and _' : null;
  const tagError = cleanTags(tags).problem;
  const nameError = flagNameProblem(name);
  const canSubmit = !!key && !keyError && !tagError && !nameError && (versions ? !firstError : !!removeBy) && !busy;
  const submit = async () => {
    const common = { key, name: name.trim() || null, tags: cleanTags(tags).tags, owner: owner.trim() || null, description, kind: 'release',
      delivery: Object.fromEntries(meta.environments.map((e) => [e.key, apps])) };
    const res = await run(() => api('POST', '/flags', versions
      // its versions are free values: each the value it is, with no variant list to grow
      ? { ...common, valueType: 'string', removeBy: null, freeValues: true, variations: [{ key: hiddenKey(first), value: first }],
        base: { enabled: true, defaultVariation: hiddenKey(first), rules: [] } }
      : { ...common, valueType: 'bool', removeBy, variations: [{ key: 'on', value: true }, { key: 'off', value: false }],
        base: { enabled: true, defaultVariation: 'off', rules: [] } }));
    if (res) { toast(`Created ${name.trim() || key}`); onClose(); go(`flag/${key}`); }
  };
  return (
    <Modal title="New release" onClose={onClose} wide footer={
      <Actions>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button disabled={!canSubmit} onClick={submit}>{busy ? 'Creating…' : 'Create release'}</Button>
      </Actions>
    }>
      <div className="grid gap-1.5">
        <span className="font-mono text-11 tracking-[0.55px] text-ink-3 uppercase">What does it release?</span>
        <div><Segmented<'feature' | 'versions'> label="What does it release?" value={what} onChange={setWhat}
          options={[{ value: 'feature', label: 'A feature, on or off' }, { value: 'versions', label: 'Versions' }]} /></div>
        <span className="text-13 text-ink-3">{versions
          ? 'Its value is a version, like 1.0.0. Each new version moves from the one everyone is on, step by step. It stays: no remove-by date.'
          : 'True turns on the new feature, false keeps the old one. Once everyone has it, the flag is removed.'}</span>
      </div>
      <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
        <Field label="Name" hint={nameError ? <span className="text-live">{nameError}</span> : versions ? 'What people see, e.g. Web bundle.' : 'What people see, e.g. New checkout.'}>
          <Input data-autofocus value={name} placeholder={versions ? 'Web bundle' : 'New checkout'} aria-invalid={!!nameError} onChange={(e) => onName(e.target.value)} />
        </Field>
        <Field label="Key" required hint={keyError ? <span className="text-live">{keyError}</span> : versions ? <>What your code reads: the version to load, like “1.0.0”.</> : <>What your code reads: true for the new feature, false for the old one.</>}>
          <Input className="font-mono" value={key} placeholder={versions ? 'web_bundle' : 'new_checkout'} aria-invalid={!!keyError}
            onChange={(e) => { setKeyEdited(true); setKeyRaw(e.target.value.toLowerCase().replace(/[\s-]+/g, '_')); }} />
        </Field>
      </div>
      <Field label="Description">
        <Input value={description} placeholder={versions ? 'What does it version? The app loads it at launch.' : 'What does it turn on?'} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
        <Field label="Owner" hint="The team responsible for it.">
          <Input value={owner} list="release-owners" placeholder="payments-team" onChange={(e) => setOwner(e.target.value)} />
          <datalist id="release-owners">{owners.map((o) => <option key={o} value={o} />)}</datalist>
        </Field>
        {versions ? (
          <Field label="First version" required hint={firstError ? <span className="text-live">{firstError}</span> : 'Everyone starts on it. Three numbers, like 1.0.0.'}>
            <Input className="font-mono" value={first} placeholder="1.0.0" aria-invalid={!!firstError} spellCheck={false} onChange={(e) => setFirst(e.target.value)} />
          </Field>
        ) : (
          <Field label="Remove by" required hint="Releases are temporary: by then the flag should be gone from the code.">
            <Input type="date" value={removeBy} onChange={(e) => setRemoveBy(e.target.value)} />
          </Field>
        )}
      </div>
      <Field label="Tags" hint={tagError ? <span className="text-live">{tagError}</span> : 'To group releases by team or area. Press Enter after each.'}>
        <ChipInput label="Tags" values={tags} onChange={(v) => setTags(v.map(normalizeTag))} placeholder="checkout, web" invalid={!!tagError} />
      </Field>
      <div className="grid gap-1.5" role="group" aria-label="Services">
        <span className="font-mono text-11 tracking-[0.55px] text-ink-3 uppercase">Services</span>
        {meta.services.length === 0 ? <NoServices what="this release" /> : (
          <div className="flex flex-wrap gap-x-5 gap-y-2 py-1">
            {meta.services.map((p) => (
              <Switch key={p.key} label={p.key} checked={apps.includes(p.key)} onChange={(on) => setApps(on ? [...apps, p.key] : apps.filter((x) => x !== p.key))}>
                <span className="font-mono text-13 text-ink">{p.key}</span>
              </Switch>
            ))}
          </div>
        )}
      </div>
      <p className="m-0 text-13 text-ink-3">
        {versions
          ? <>Everyone starts on {firstError ? 'the first version' : first}. Your code reads the version and loads it. Turned off, the flag sends nothing, and apps use the version built into them.</>
          : <>It starts with nobody: everyone gets false. In your app, make false (the default in the code) the old behaviour: turning a release off sends nothing, and apps use the default in their code.</>}
      </p>
      <ErrorList error={error} />
    </Modal>
  );
}
