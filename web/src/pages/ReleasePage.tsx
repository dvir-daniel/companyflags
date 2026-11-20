// One release (docs/design/releases.md), in two tabs like a flag's page. Rollout: a card with where the release is in
// the picked environment, who has it, the % stages and the next step (as Firebase's rollouts and LaunchDarkly's
// progressive rollouts show it); cleaning up once everyone has it; then the flag's rules, edited right there with the
// flag page's own editor (FlagPage.tsx FlagRules). History: the flag's history, as on its page.
// Every step saves the flag's defaults (PUT /flags/:key/layers/:env/base), built by server/release.ts applyChange:
// at once where the environment needs no review (with Undo), as a request where it does. The rules editor changes the
// same rules through a draft; the card reads whatever results (or says the rules are custom).
// A version release (docs/design/release-versions.md) gets its own card (VersionCard): the version everyone is on, the one
// moving to it, and rollback; its bar has + New version (NewVersion), and it's never cleaned up.
import { lazy, Suspense, useEffect, useState } from 'react';
import { ArrowLeftIcon, LockSimpleIcon } from '@phosphor-icons/react';
import { StatusMark } from '@companyflags/ui/components/badge';
import { Button } from '@companyflags/ui/components/button';
import { Callout } from '@companyflags/ui/components/callout';
import { Input } from '@companyflags/ui/components/input';
import { SectionLabel } from '@companyflags/ui/components/page';
import { FilterSelect, PageBar } from '@companyflags/ui/components/page-bar';
import { Tabs } from '@companyflags/ui/components/tabs';
import { Tooltip } from '@companyflags/ui/components/tooltip';
import { cn } from '@companyflags/ui/lib/utils';
import { api, entityLabel, peek, type FlagDetail, type Layer } from '../api.ts';
import { go, useApp } from '../app.ts';
import { flagPath, flagRequestsPath, pageEnv } from '../paths.ts';
import { writePersistent } from '../persist.ts';
import { Actions, Empty, ErrorList, Field, Modal, OnOff, Segmented } from '../ui.tsx';
import { fmtDate, useAsync } from '../uiKit.ts';
import { DetailBarSkeleton, EnvChip, FlagHistorySkeleton, FlagRulesSkeleton, RolloutSkeleton, TabsSkeleton } from '../loading.tsx';
import { RELEASE_TABS } from '../loadingKit.ts';
import { useDraft } from '../useDraft.ts';
import { canBreakGlassRollback, roleInfo } from '../../../server/policy.ts';
import {
  applyChange, backChange, changeText, holdBacks, isRollback, isVersionRelease, LADDER, nextChange, readyToCleanUp, releaseState, stepText, type Change, type ReleaseState,
} from '../../../server/release.ts';
import { bumpVersion, compareVersions, newVersionProblem } from '../../../server/semver.ts';
import { FlagFacts } from './flagHeader.tsx';
import { EntityPicker, PowerSwitch, type SaveResult } from './flagParts.tsx';
import { useEnvs } from './envs.ts';

// the History tab loads its code (History, and through it Approvals) the first time it opens
const FlagHistory = lazy(() => import('./History.tsx').then((m) => ({ default: m.FlagHistory })));
// the rules under the rollout card are the flag page's own rules editor (FlagPage.tsx FlagRules), loaded with the page
const FlagRules = lazy(() => import('./FlagPage.tsx').then((m) => ({ default: m.FlagRules })));

type Request = { id: number; environment: string; status: string; author: string; reason: string | null; scheduledAt: string | null; createdAt: string };
type Tab = 'rollout' | 'history';
const OPEN = new Set(['in_review', 'approved', 'scheduled']);
const STATUS: Record<string, string> = { in_review: 'waiting for review', approved: 'approved, not applied yet', scheduled: 'scheduled' };

/** A GET that opens with the console's last answer (api.ts peek) and fetches a fresh one behind it. */
function useGet<T>(path: string, refresh: unknown) {
  const [got, setGot] = useState<{ path: string; data?: T; error: string | null }>(() => ({ path, data: peek<T>(path), error: null }));
  const [tries, setTries] = useState(0);
  useEffect(() => {
    let live = true;
    api<T>('GET', path).then((data) => { if (live) setGot({ path, data, error: null }); },
      (e) => { if (live) setGot((g) => ({ path, data: g.path === path ? g.data : undefined, error: (e as Error).message })); });
    return () => { live = false; };
  }, [path, refresh, tries]);
  return { data: got.path === path ? got.data : peek<T>(path), error: got.path === path ? got.error : null, reload: () => setTries((t) => t + 1) };
}

export function ReleasePage({ flagKey, envKey }: { flagKey: string; envKey?: string }) {
  const { meta, revisionTick } = useApp();
  const env = envKey && meta.environments.some((e) => e.key === envKey) ? envKey : pageEnv(meta);
  useEffect(() => { if (env) writePersistent('env', env); }, [env]);
  // the tab stays when you switch environment; another release opens on its rollout
  const [tabOf, setTabOf] = useState<{ flag: string; tab: Tab }>({ flag: flagKey, tab: 'rollout' });
  const tab = tabOf.flag === flagKey ? tabOf.tab : 'rollout';
  const flag = useGet<FlagDetail>(flagPath(flagKey), revisionTick);
  const requests = useGet<Request[]>(flagRequestsPath(flagKey), revisionTick);
  if (!flag.data) {
    return flag.error
      ? <div className="px-6 py-10 max-sm:px-4"><Empty action={<Button variant="secondary" onClick={flag.reload}>Try again</Button>}>Couldn’t open {flagKey}: {flag.error}</Empty></div>
      // the page's own shape while the flag loads (loading.tsx): its bar, its tabs and the rollout card, with bones
      : <div aria-busy className="flex min-h-full flex-1 flex-col">
        <DetailBarSkeleton back={`#/releases/${encodeURIComponent(env)}`} backLabel="Back to releases" env={<EnvChip meta={meta} env={env} to={(v) => `release/${flagKey}/${v}`} />} />
        <TabsSkeleton widths={RELEASE_TABS} />
        {tab === 'rollout' && <RolloutSkeleton />}
      </div>;
  }
  const changed = () => { flag.reload(); requests.reload(); };
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <ReleaseView key={`${flagKey}:${env}`} flag={flag.data} env={env} requests={requests.data ?? []} onChanged={changed}
        tab={tab} setTab={(t) => setTabOf({ flag: flagKey, tab: t })} />
    </div>
  );
}

function ReleaseView({ flag, env, requests, onChanged, tab, setTab }: {
  flag: FlagDetail; env: string; requests: Request[]; onChanged: () => void; tab: Tab; setTab: (t: Tab) => void;
}) {
  const { meta, toast, ask, reload } = useApp();
  const { envName, isProtected } = useEnvs();
  const { session: drafts, summary } = useDraft(env);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const variants = flag.variations;
  const versioned = isVersionRelease(variants);
  const base = flag.layers[env]?.base;
  const stateOf = (e: string) => releaseState(variants, flag.layers[e].base);
  const where = envName(env).toLowerCase();
  const mayChange = roleInfo(meta.me.role).changes;
  const open = requests.filter((r) => OPEN.has(r.status));
  const waiting = open.find((r) => r.environment === env);
  const keyPath = encodeURIComponent(flag.key);

  const bar = (
    <PageBar
      title={<span className="flex min-w-0 items-center gap-1.5">
        <Tooltip content="Back to releases">
          <a href={`#/releases/${encodeURIComponent(env)}`} aria-label="Back to releases" className="-ml-2 inline-grid size-8 shrink-0 place-items-center text-ink-2 no-underline transition-colors duration-150 hover:bg-wash hover:text-ink"><ArrowLeftIcon className="size-4" /></a>
        </Tooltip>
        <span className={cn('truncate', !flag.name && 'font-mono')}>{flag.name ?? flag.key}</span>
      </span>}
      actions={base ? <>
        {versioned && !flag.archivedAt && <Button variant="secondary" disabled={!mayChange} onClick={() => setAdding(true)}>+ New version</Button>}
        <OnOff on={!!base.enabled} />
        <PowerSwitch flag={flag} env={env} onSaved={onChanged} />
      </> : undefined}>
      {flag.name && <span className="truncate font-mono text-13 text-ink-3">{flag.key}</span>}
      {/* the environment, picked as on the list and the flag page; the menu shows where the release is in each */}
      <FilterSelect label="Environment" value={env} display={envName(env)} onChange={(v) => go(`release/${flag.key}/${v}`)}
        options={meta.environments.map((e) => [e.key, flag.layers[e.key]?.base ? `${envName(e.key)} · ${stepText(stateOf(e.key))}` : envName(e.key)] as [string, string])} />
    </PageBar>
  );
  if (flag.archivedAt || flag.kind !== 'release' || !base) {
    return <>{bar}<div className="px-6 py-6 max-sm:px-4"><Callout>
      {flag.archivedAt ? 'This release is archived: it’s in no service any more.' : `${flag.key} isn’t a release (its purpose is ${flag.kind.replace('_', ' ')}).`}{' '}
      <Button variant="link" onClick={() => go(flag.archivedAt ? `releases/${env}` : `flag/${flag.key}/${env}`)}>{flag.archivedAt ? 'Back to releases' : 'Open the flag'}</Button>
    </Callout></div></>;
  }

  const state = stateOf(env);
  const name = (k: string) => entityLabel(meta.entities, k);
  // a version release's rollback, by those who may break glass, can go live at once where changes are reviewed (logged)
  const rollsBackNow = (c: Change) => isProtected(env) && canBreakGlassRollback(flag.kind, meta.me.role)
    && isRollback(state, c, flag.versions?.[env]?.served ?? []);

  /** One step: the defaults after it, saved now (Undo) or sent for review where the environment needs it. */
  const save = async (change: Change) => {
    let layer: Layer;
    try { layer = applyChange(variants, base, change, flag.key); } catch (e) { toast(e as Error); return; }
    const words = changeText(state, releaseState(variants, layer)) ?? stepText(releaseState(variants, layer));
    // a step is never drafted (like the switch): unpublished edits of this flag here are discarded first
    const drafted = summary.has(flag.key);
    if (drafted) {
      const d = await ask({
        title: `Discard your changes to ${flag.key}?`, body: <p>You have unpublished changes to this flag in {where}. They’re discarded first, then: {words}.</p>,
        actions: [{ id: 'keep', label: 'Keep editing' }, { id: 'go', label: 'Discard and continue', tone: 'primary' }],
      });
      if (d.action !== 'go') return;
    }
    let note = '';
    let bypass = '';
    if (rollsBackNow(change)) {
      const target = change.kind === 'everyone' && change.version ? change.version : state.versions?.current ?? 'the built-in version';
      const r = await ask({
        title: `Roll back ${where} to ${target}?`,
        body: <><p>Every device in {where} gets {target} at its next fetch.{change.kind === 'pause' ? ` The rollout keeps its ${state.step === 'percent' ? `${state.percent}%` : 'early access'}, so you can resume it.` : ''}</p>
          <p className="text-ink-3">You can use break-glass, so you can do this right away. It’s logged for review.</p></>,
        reason: { label: 'Why? (required)', placeholder: `INC-123: ${state.versions?.target ?? state.versions?.current ?? 'this version'} crashes on start` },
        actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'now', label: 'Roll back now', tone: 'danger', needsReason: true },
          { id: 'request', label: 'Request review', needsReason: true }],
      });
      if (r.action !== 'now' && r.action !== 'request') return;
      note = r.reason;
      if (r.action === 'now') bypass = r.reason;
    } else if (isProtected(env)) {
      const r = await ask({
        title: `Request: ${words}`, body: <p>{envName(env)} needs approval, so this goes to an approver first. It applies once approved.</p>,
        reason: { label: 'Note for the reviewer (optional)', placeholder: 'Error rates look normal at 5%' },
        actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'request', label: 'Request review', tone: 'primary' }],
      });
      if (r.action !== 'request') return;
      note = r.reason;
    }
    if (drafted) drafts.discard([flag.key]);
    setBusy(true);
    try {
      const reason = `${flag.key} in ${envName(env)}: ${words}${note ? `. ${note}` : ''}`;
      const res = await api<SaveResult>('PUT', `/flags/${keyPath}/layers/${encodeURIComponent(env)}/base`,
        { layer, expectedVersion: base.version, reason, ...(bypass ? { bypassReason: bypass } : {}) });
      if (res.applied && bypass) {
        // break-glass: logged for review; undoing it is an ordinary step (a request here)
        void drafts.noteChanged([flag.key]);
        toast(`${words} in ${where} by break-glass (logged)`);
      } else if (res.applied) {
        void drafts.noteChanged([flag.key]);
        toast(`${words} in ${where}`, 'ok', { label: 'Undo', onClick: () => void undo(base) });
      } else {
        toast(`Sent for review: request #${res.changeSetId}`, 'ok', { label: 'View', onClick: () => go(`approvals/${res.changeSetId}`) });
      }
      reload().catch(() => {});
      onChanged();
    } catch (e) { toast(e as Error); }
    finally { setBusy(false); }
  };
  const undo = async (before: Layer) => {
    try {
      const now = await api<FlagDetail>('GET', flagPath(flag.key));
      await api('PUT', `/flags/${keyPath}/layers/${encodeURIComponent(env)}/base`, { layer: before, expectedVersion: now.layers[env].base.version, reason: 'Undo' });
      void drafts.noteChanged([flag.key]);
      toast(`Undone in ${where}`);
      reload().catch(() => {});
      onChanged();
    } catch (e) { toast(e as Error); }
  };

  const envStates = meta.environments.map((e) => ({ env: e.key, state: stateOf(e.key), sent: (flag.delivery[e.key] ?? []).length > 0 }));
  // a version release stays: archiving it, when whatever it versions is retired, is on the flag page
  const cleaning = !versioned && (readyToCleanUp(envStates) || envStates.every((e) => !e.sent));

  return (
    <>
      {bar}
      {/* tabs right under the header, as on a flag's page */}
      <div className="border-b border-rule px-6 max-sm:px-4">
        <Tabs<Tab> label="Release sections" value={tab} onChange={setTab} className="border-b-0"
          items={[{ value: 'rollout', label: 'Rollout' }, { value: 'history', label: 'History' }]} />
      </div>
      {tab === 'history' ? (
        <div className="mt-2">
          <Suspense fallback={<FlagHistorySkeleton />}><FlagHistory flagKey={flag.key} /></Suspense>
        </div>
      ) : <>
        <div className="px-6 max-sm:px-4">
          <FlagFacts flag={flag} className="mt-4" />
          {state.versions ? (
            <VersionCard flag={flag} env={env} state={state} waiting={waiting} disabled={!mayChange || busy} onChange={save} name={name}
              onNewVersion={() => setAdding(true)} rollsBackNow={rollsBackNow}
              elsewhere={meta.environments.filter((e) => e.key !== env && flag.layers[e.key]?.base).map((e) => `${envName(e.key)}: ${stepText(stateOf(e.key))}`)}
              onEditRules={() => document.getElementById('release-rules')?.scrollIntoView({ behavior: 'smooth', block: 'start' })} />
          ) : (
            <RolloutCard flag={flag} env={env} state={state} waiting={waiting} disabled={!mayChange || busy} onChange={save} name={name}
              onEditRules={() => document.getElementById('release-rules')?.scrollIntoView({ behavior: 'smooth', block: 'start' })} />
          )}
          {cleaning && <CleanUp flag={flag} envStates={envStates} open={open} disabled={!mayChange} onChanged={onChanged} />}
          <SectionLabel className="mb-0 scroll-mt-24" ><span id="release-rules">Rules in {where}</span></SectionLabel>
          <p className="m-0 mt-2 max-w-[780px] text-13 text-ink-3">
            Every rule on this flag, the rollout’s own included (its % and its early access). Edits go into your draft until you publish them, as on the flag page.
          </p>
        </div>
        {/* the flag page's rules editor: overrides, own settings, rules for everyone and the default, with its draft bar */}
        <Suspense fallback={<FlagRulesSkeleton />}>
          <FlagRules flagKey={flag.key} env={env} />
        </Suspense>
      </>}
      {adding && <NewVersion flag={flag} onClose={() => setAdding(false)} onAdded={onChanged} />}
    </>
  );
}

/** A version release's versions, lowest first (values typed in for one entity aren't among them). */
const versionsIn = (flag: FlagDetail) => releaseState(flag.variations, Object.values(flag.layers).find((l) => l.base)!.base).versions?.all ?? [];

/** + New version: the next version of a version release, added in every environment; nobody gets it until a step serves
 *  it. Filled with the next patch; Patch, Minor and Major set it as `npm version` would. */
function NewVersion({ flag, onClose, onAdded }: { flag: FlagDetail; onClose: () => void; onAdded: () => void }) {
  const { toast } = useApp();
  const versions = versionsIn(flag);
  const newest = versions.at(-1) ?? null;
  const [version, setVersion] = useState(() => (newest ? bumpVersion(newest, 'patch') : '1.0.0'));
  const problem = newVersionProblem(version, versions);
  const { busy, error, run } = useAsync();
  const parts = ['patch', 'minor', 'major'] as const;
  const picked = newest ? parts.find((p) => bumpVersion(newest, p) === version) ?? '' : '';
  const add = async () => {
    if (problem || busy) return;
    const r = await run(() => api('POST', `/flags/${encodeURIComponent(flag.key)}/versions`, { version }));
    if (r) { toast(`Added ${version}: nobody has it yet`); onAdded(); onClose(); }
  };
  return (
    <Modal title={`New version of ${flag.name ?? flag.key}`} onClose={onClose} footer={
      <Actions>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button disabled={!!problem || busy} onClick={() => void add()}>{busy ? 'Adding…' : 'Add version'}</Button>
      </Actions>
    }>
      {newest && <Segmented<(typeof parts)[number] | ''> label="Next version" value={picked} onChange={(p) => { if (p) setVersion(bumpVersion(newest, p)); }}
        options={parts.map((p) => ({ value: p, label: `${p} ${bumpVersion(newest, p)}` }))} />}
      <Field label="Version" required hint={problem ? <span className="text-live">{problem}</span>
        : <>Higher than {newest ?? 'every other'}{newest ? ', the newest' : ''}. A prerelease is typed by hand, like {bumpVersion(newest ?? '1.0.0', 'minor')}-rc.1.</>}>
        <Input data-autofocus className="font-mono" value={version} spellCheck={false} aria-invalid={!!problem}
          onChange={(e) => setVersion(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} />
      </Field>
      <p className="m-0 text-13 text-ink-3">It’s added in every environment, and nobody gets it yet: each environment starts it on its own page, step by step.</p>
      <ErrorList error={error} />
    </Modal>
  );
}

/** Early access: entities that get the new value on every device, whatever the % (a rule on `entity` the release
 *  keeps first, server/release.ts). Added one at a time; each is a step like any other (now, or a request). */
function EarlyAccess({ state, disabled, onChange, name }: { state: ReleaseState; disabled: boolean; onChange: (c: Change) => void; name: (k: string) => string }) {
  const { meta } = useApp();
  const [pick, setPick] = useState('');
  if (!meta.dimensions.length) return null;
  const add = () => { if (pick && !state.entities.includes(pick)) { onChange({ kind: 'entities', entities: [...state.entities, pick] }); setPick(''); } };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-grid px-5 py-2.5 text-13">
      <span className="font-medium text-ink">Early access</span>
      {state.entities.length === 0 && <span className="text-ink-3">None yet.</span>}
      {state.entities.map((k) => (
        <span key={k} className="inline-flex items-center gap-1 border border-grid px-1.5 py-0.5 text-ink-2">{name(k)}
          <button type="button" disabled={disabled} aria-label={`Remove ${name(k)} from early access`} title="Remove"
            onClick={() => onChange({ kind: 'entities', entities: state.entities.filter((x) => x !== k) })}
            className="cursor-default border-0 bg-transparent p-0 text-ink-3 hover:text-ink">×</button>
        </span>
      ))}
      <span className="flex-1" />
      <span className="flex items-center gap-2">
        <span className="w-[200px]"><EntityPicker value={pick} onChange={setPick} placeholder="Give early access…" /></span>
        <Button variant="outline" disabled={disabled || !pick || state.entities.includes(pick)} onClick={add}>Add</Button>
      </span>
    </div>
  );
}

/**
 * Where the release is in this environment, as one card: its status, how much of it has the feature (big), who that
 * is in a sentence, the % stages, and the next step. A request waiting for review takes the buttons' place.
 */
function RolloutCard({ flag, env, state, waiting, disabled, onChange, name, onEditRules }: {
  flag: FlagDetail; env: string; state: ReleaseState; waiting: Request | undefined; disabled: boolean; onChange: (c: Change) => void; name: (k: string) => string;
  onEditRules: () => void;
}) {
  const { envName, isProtected } = useEnvs();
  const where = envName(env).toLowerCase();
  const prot = isProtected(env);
  const apps = flag.delivery[env] ?? [];
  const off = !state.on && state.step !== 'not_started';
  const [status, tone]: [string, 'ok' | 'warn' | 'off'] = state.step === 'custom' ? ['Custom rules', 'off'] : off ? ['Off', 'off'] : state.paused ? ['Paused', 'warn']
    : state.step === 'everyone' ? ['Released to everyone', 'ok'] : state.step === 'not_started' ? ['Not started', 'off'] : ['Rolling out', 'ok'];
  const headline = state.step === 'percent' ? `${state.percent}% of devices` : state.step === 'everyone' ? 'Everyone'
    : state.step === 'early' ? `${state.entities.length.toLocaleString()} in early access` : state.step === 'not_started' ? 'Nobody yet' : 'Custom rules';
  const list = (xs: string[]) => (xs.length <= 3 ? xs.join(', ') : `${xs.slice(0, 3).join(', ')} and ${xs.length - 3} more`);
  const targeted = state.entities.length ? `${list(state.entities.map(name))} on every device` : '';
  const who = !apps.length ? 'It isn’t in any service here.'
    : off ? 'The flag is off here: nobody gets a value, and every app uses the default in its code. Turn it on (top right) to continue where it was.'
    : state.step === 'custom' ? 'Its rules don’t follow the stages (for example two % rules, or a % that doesn’t start at 0), so they’re edited on the flag page.'
    : state.paused ? 'Nobody new gets it: everyone gets the old value until you resume.'
    : state.step === 'not_started' ? 'Everyone gets the old value.'
    : state.step === 'everyone' ? 'Every device has it, with a device ID or without.'
    : state.step === 'early' ? `${targeted}. Everyone else gets the old value.`
    : `${targeted ? `Also ${targeted}. ` : ''}Devices outside the % get the old value.`;
  const next = nextChange(state);
  const back = backChange(state);
  const say = (c: Change) => {
    const words = c.kind === 'everyone' ? 'Release to everyone'
      : c.kind === 'percent' ? (state.step === 'percent' ? `Increase to ${c.percent}%` : `Start at ${c.percent}%`) : '';
    return prot ? `Request: ${words.charAt(0).toLowerCase()}${words.slice(1)}` : words;
  };
  const sayBack = (c: Change) => (c.kind === 'percent'
    ? `Roll back to ${c.percent > 0 ? `${c.percent}%` : state.entities.length ? 'early access' : 'not started'}` : '');
  return (
    <section aria-label="Rollout" className="mt-5 max-w-[860px] border border-grid bg-panel">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4 px-5 pt-4">
        <div className="min-w-0 flex-1 basis-[320px]">
          <span className="flex items-center gap-2 text-13 text-ink-2"><StatusMark tone={tone} />{status} in {where}</span>
          <p className="m-0 mt-1.5 text-[26px] leading-tight font-semibold text-ink">
            {headline}{state.step === 'percent' && state.apps && <span className="ml-2 text-base font-normal text-ink-3">on {state.apps.join(', ')}</span>}
          </p>
          <p className="m-0 mt-1.5 text-13 text-ink-2">{who}</p>
        </div>
        {!waiting && !off && state.step !== 'custom' && (
          <div className="flex flex-wrap items-center gap-2">
            {state.paused ? <Button disabled={disabled} onClick={() => onChange({ kind: 'resume' })}>{prot ? 'Request: resume' : 'Resume'}</Button> : <>
              {next && <Button disabled={disabled} onClick={() => onChange(next)}>{say(next)}</Button>}
              {back && <Button variant="outline" disabled={disabled} onClick={() => onChange(back)}>{sayBack(back)}</Button>}
              {(state.step === 'early' || state.step === 'percent') && <Button variant="outline" disabled={disabled} onClick={() => onChange({ kind: 'pause' })}>Pause</Button>}
            </>}
          </div>
        )}
        {state.step === 'custom' && <Button variant="outline" onClick={onEditRules}>Edit rules</Button>}
      </div>
      <div className="px-5 pt-5 pb-4"><Stages state={state} /></div>
      {!waiting && !off && !state.paused && (state.step === 'not_started' || state.step === 'early' || state.step === 'percent') && (
        <EarlyAccess state={state} disabled={disabled} onChange={onChange} name={name} />
      )}
      {waiting ? (
        <div role="status" className="flex flex-wrap items-center gap-x-2 border-t border-grid bg-flag-bg px-5 py-2.5 text-13 text-flag">
          Request #{waiting.id} is {STATUS[waiting.status] ?? waiting.status}{waiting.reason ? `: ${waiting.reason}` : ''}. The next step waits for it.
          <Button variant="link" onClick={() => go(`approvals/${waiting.id}`)}>View request</Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-grid px-5 py-2.5 text-13 text-ink-3">
          {prot && <span className="inline-flex items-center gap-1.5 text-flag"><LockSimpleIcon aria-hidden className="size-3.5" />{envName(env)} needs approval: each step is a request</span>}
          {apps.length > 0 && <span>Services: {apps.join(', ')}</span>}
          {state.step === 'percent' && <span>Devices without a device ID get it at everyone</span>}
        </div>
      )}
    </section>
  );
}

/**
 * A version release's card: the version everyone is on, the one moving to it and how far, who that is, and the next
 * step (docs/design/release-versions.md). Rolling back mid-way keeps the % (the release's rules, switched off), so resume
 * puts the same devices back; from everyone it goes back to the version this environment had before (its history).
 */
function VersionCard({ flag, env, state, waiting, disabled, onChange, name, onEditRules, onNewVersion, elsewhere, rollsBackNow }: {
  flag: FlagDetail; env: string; state: ReleaseState; waiting: Request | undefined; disabled: boolean; onChange: (c: Change) => void; name: (k: string) => string;
  onEditRules: () => void; onNewVersion: () => void; elsewhere: string[];
  /** this rollback can go live at once here (break-glass, by on call), so its button isn't worded as a request */
  rollsBackNow: (c: Change) => boolean;
}) {
  const { ask, meta } = useApp();
  const { envName, isProtected } = useEnvs();
  const where = envName(env).toLowerCase();
  const prot = isProtected(env);
  const req = (w: string, c?: Change) => (prot && !(c && rollsBackNow(c)) ? `Request: ${w.charAt(0).toLowerCase()}${w.slice(1)}` : w);
  const v = state.versions!;
  const apps = flag.delivery[env] ?? [];
  // off sends nothing: apps use the version built into them. A version that's ready can still be started: its first step
  // turns the flag on (as an on/off release's does: a new flag starts off where changes are reviewed)
  const off = !state.on && state.step !== 'not_started';
  const dark = !state.on;
  const moving = state.step === 'early' || state.step === 'percent';
  const cur = v.current ?? 'the built-in version';
  const newest = v.all.at(-1) ?? null;
  // a version above the one moving: the hotfix
  const higher = moving && newest && v.target && compareVersions(newest, v.target) > 0 ? newest : null;
  const lower = v.current ? v.all.filter((x) => compareVersions(x, v.current!) < 0).reverse() : [];
  const before = flag.versions?.[env];
  // the version this environment had before (its history), else the one below
  const previous = before?.previous && lower.includes(before.previous) ? before.previous : lower[0] ?? null;
  const share = state.step === 'percent' ? `${state.percent}% of devices` : `${state.entities.length.toLocaleString()} in early access`;
  const [status, tone]: [string, 'ok' | 'warn' | 'off'] = state.step === 'custom' ? ['Custom rules', 'off'] : off ? ['Off', 'off']
    : state.paused ? ['Rolled back', 'warn'] : moving ? [`Rolling out ${v.target}`, 'ok'] : state.step === 'not_started' ? [`${v.target} is ready${dark ? ' (off)' : ''}`, 'off'] : [`On ${cur}`, 'ok'];
  const headline = state.step === 'custom' ? 'Custom rules' : dark && !moving ? 'Everyone on the built-in version'
    : state.paused ? `Rolled back to ${cur}` : state.step === 'percent' ? `${state.percent}% of devices`
    : state.step === 'early' ? `${state.entities.length.toLocaleString()} in early access` : `Everyone on ${cur}`;
  const list = (xs: string[]) => (xs.length <= 3 ? xs.join(', ') : `${xs.slice(0, 3).join(', ')} and ${xs.length - 3} more`);
  const targeted = state.entities.length ? `${list(state.entities.map(name))} on every device` : '';
  const who = !apps.length ? 'It isn’t in any service here.'
    : off ? 'The flag is off here: nobody gets a value, and every app uses the version built into it. Turn it on (top right) to continue where it was.'
    : state.step === 'custom' ? 'Its rules don’t follow the steps (for example two versions moving at once), so they’re edited in the rules below.'
    : state.paused ? `Everyone is on ${cur}. Resume puts the same ${share} back on ${v.target}.`
    : state.step === 'everyone' ? `${before?.since ? `Since ${fmtDate(before.since)}. ` : ''}${previous ? `Before: ${previous}. ` : ''}Add a new version to move everyone to the next one.`
    : state.step === 'not_started' && dark ? `The flag is off here, so every app uses the version built into it. Starting ${v.target} turns it on: everyone else gets ${cur}.`
    : state.step === 'not_started' ? `${v.target} is ready: nobody has it yet. Everyone is on ${cur}.`
    : state.step === 'early' ? `${targeted}. Everyone else stays on ${cur}.`
    : `${targeted ? `Also ${targeted}. ` : ''}The other ${100 - state.percent!}% stay on ${cur}. Devices without a device ID get ${v.target} at everyone.`;
  const next = nextChange(state);
  const back = backChange(state);
  const sayNext = (c: Change) => (c.kind === 'everyone' ? `Release ${v.target} to everyone`
    : c.kind === 'percent' ? (state.step === 'percent' ? `Increase to ${c.percent}%` : `Start ${v.target} at ${c.percent}%`) : '');
  const sayBack = (c: Change) => (c.kind === 'percent'
    ? c.percent > 0 ? `Back to ${c.percent}%` : state.entities.length ? 'Back to early access' : 'Back to not started' : '');
  // roll back to another of the lower versions
  const pickLower = async () => {
    const r = await ask({
      title: `Roll back ${where} to which version?`,
      body: <p>Everyone in {where} gets it{prot ? ' once the request is approved' : ''}. {v.current} stays among the versions, so it can be started again.</p>,
      actions: [{ id: '', label: 'Cancel' }, ...lower.slice(0, 5).map((x) => ({ id: x, label: x, tone: x === previous ? 'primary' as const : 'default' as const }))],
    });
    if (r.action) onChange({ kind: 'everyone', version: r.action });
  };
  const holds = holdBacks(flag.variations, flag.layers[env].base);
  const byKey = new Map(flag.variations.map((x) => [x.key, x.value]));
  const own = (flag.layers[env].entities ?? []).map(({ entity, layer }) => {
    const mine = layer.defaultVariation ? byKey.get(layer.defaultVariation) : undefined;
    return `${name(entity)}${typeof mine === 'string' ? ` (its own default: ${mine})` : ''}`;
  });
  return (
    <section aria-label="Rollout" className="mt-5 max-w-[860px] border border-grid bg-panel">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4 px-5 pt-4">
        <div className="min-w-0 flex-1 basis-[320px]">
          <span className="flex items-center gap-2 text-13 text-ink-2"><StatusMark tone={tone} />{status} in {where}</span>
          <p className="m-0 mt-1.5 text-[26px] leading-tight font-semibold text-ink">
            {headline}
            {moving && !state.paused && <span className="ml-2 text-base font-normal text-ink-3">on {v.target}{state.step === 'percent' && state.apps ? ` · ${state.apps.join(', ')}` : ''}</span>}
          </p>
          <p className="m-0 mt-1.5 text-13 text-ink-2">{who}</p>
        </div>
        {!waiting && !off && state.step !== 'custom' && (
          <div className="flex flex-wrap items-center gap-2">
            {state.paused ? <>
              <Button disabled={disabled} onClick={() => onChange({ kind: 'resume' })}>{req(`Resume ${v.target} at ${state.step === 'percent' ? `${state.percent}%` : 'early access'}`)}</Button>
              {higher && <Button variant="outline" disabled={disabled} onClick={() => onChange({ kind: 'resume', version: higher })}>{req(`Resume with ${higher}`)}</Button>}
            </> : state.step === 'everyone' ? <>
              <Button disabled={disabled} onClick={onNewVersion}>+ New version</Button>
              {previous && <Button variant="outline" disabled={disabled} onClick={() => onChange({ kind: 'everyone', version: previous })}>{req(`Roll back to ${previous}`, { kind: 'everyone', version: previous })}</Button>}
            </> : <>
              {next && <Button disabled={disabled} onClick={() => onChange(next)}>{req(sayNext(next))}</Button>}
              {back && <Button variant="outline" disabled={disabled} onClick={() => onChange(back)}>{req(sayBack(back))}</Button>}
              {moving && <Button variant="outline" disabled={disabled} onClick={() => onChange({ kind: 'pause' })}>{req(`Roll back to ${cur}`, { kind: 'pause' })}</Button>}
              {higher && <Button variant="outline" disabled={disabled} onClick={() => onChange({ kind: 'replace', version: higher })}>{req(`Replace with ${higher}`)}</Button>}
              {next?.kind !== 'everyone' && <Button variant="outline" disabled={disabled} onClick={() => onChange({ kind: 'everyone' })}>{req(`Release ${v.target} to everyone`)}</Button>}
              {state.step === 'not_started' && !dark && previous && <Button variant="outline" disabled={disabled} onClick={() => onChange({ kind: 'everyone', version: previous })}>{req(`Roll back to ${previous}`, { kind: 'everyone', version: previous })}</Button>}
            </>}
            {!state.paused && !moving && !dark && lower.length > 1 && <Button variant="link" disabled={disabled} onClick={() => void pickLower()}>Another version…</Button>}
          </div>
        )}
        {state.step === 'custom' && <Button variant="outline" onClick={onEditRules}>Edit rules</Button>}
      </div>
      <div className="px-5 pt-5 pb-4"><Stages state={state} /></div>
      {!waiting && !off && !state.paused && (state.step === 'not_started' || state.step === 'early' || state.step === 'percent') && (
        <EarlyAccess state={state} disabled={disabled} onChange={onChange} name={name} />
      )}
      {(holds.length > 0 || own.length > 0) && (
        <ul className="m-0 grid list-none gap-1 border-t border-grid px-5 py-2.5 text-13 text-ink-2">
          {holds.map((h) => <li key={h}>{h} <span className="text-ink-3">(a rule of its own: the steps leave it alone)</span></li>)}
          {own.length > 0 && <li>Those with their own settings decide first: {list(own)}</li>}
        </ul>
      )}
      {waiting ? (
        <div role="status" className="flex flex-wrap items-center gap-x-2 border-t border-grid bg-flag-bg px-5 py-2.5 text-13 text-flag">
          Request #{waiting.id} is {STATUS[waiting.status] ?? waiting.status}{waiting.reason ? `: ${waiting.reason}` : ''}. The next step waits for it.
          <Button variant="link" onClick={() => go(`approvals/${waiting.id}`)}>View request</Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-grid px-5 py-2.5 text-13 text-ink-3">
          {prot && <span className="inline-flex items-center gap-1.5 text-flag"><LockSimpleIcon aria-hidden className="size-3.5" />{envName(env)} needs approval: each step is a request{canBreakGlassRollback(flag.kind, meta.me.role) ? ', but you can roll back at once (logged)' : ''}</span>}
          {apps.length > 0 && <span>Services: {apps.join(', ')}</span>}
          {elsewhere.map((e) => <span key={e}>{e}</span>)}
        </div>
      )}
    </section>
  );
}

/** The % stages and everyone (LaunchDarkly's progressive rollout): one line, green up to the current stage, with a
 *  square on each, filled where it has been. A % set on the flag page is shown where it falls. */
function Stages({ state }: { state: ReleaseState }) {
  if (state.step === 'custom') return null;
  const ladder: readonly number[] = LADDER;
  const percents = [...ladder, ...(state.percent !== null && !ladder.includes(state.percent) ? [state.percent] : [])].sort((a, b) => a - b);
  const stops = [...percents.map((p) => ({ id: `p${p}`, label: `${p}%` })), { id: 'everyone', label: 'Everyone' }];
  const at = state.step === 'percent' ? stops.findIndex((s) => s.id === `p${state.percent}`) : state.step === 'everyone' ? stops.length - 1 : -1;
  const held = state.paused || !state.on;
  const now = !state.on ? 'Off' : state.paused ? 'Paused' : 'Now';
  return (
    <ol aria-label="Stages" className="m-0 grid list-none p-0" style={{ gridTemplateColumns: `repeat(${stops.length}, minmax(0, 1fr))` }}>
      {stops.map((s, i) => {
        const current = i === at;
        return (
          <li key={s.id} aria-current={current ? 'step' : undefined} className="relative grid min-w-0 gap-1.5 pr-1 text-13">
            <span aria-hidden className="relative flex h-3 items-center">
              {i < stops.length - 1 && <span className={cn('absolute top-1/2 left-1.5 h-0.5 w-full -translate-y-1/2', i < at ? 'bg-ok' : 'bg-rule')} />}
              <span className={cn('relative size-3 border-2', current ? (held ? 'border-flag bg-flag' : 'border-ink bg-ink') : i < at ? 'border-ok bg-ok' : 'border-rule-2 bg-panel')} />
            </span>
            <span className={cn('truncate', current ? 'font-medium text-ink' : i < at ? 'text-ink-2' : 'text-ink-3')}>{s.label}</span>
            <span className={cn('h-4 truncate text-xs', held ? 'text-flag' : 'text-ink-3')}>{current ? now : ''}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Done rolling out: remove it from the code, stop sending it where changes are reviewed, then archive it. */
function CleanUp({ flag, envStates, open, disabled, onChanged }: {
  flag: FlagDetail; envStates: { env: string; state: ReleaseState; sent: boolean }[]; open: Request[]; disabled: boolean; onChanged: () => void;
}) {
  const { toast, ask, reload } = useApp();
  const { envName, isProtected } = useEnvs();
  const [busy, setBusy] = useState(false);
  // where changes are reviewed, archiving needs the flag off and sent to no app first (server/control.ts archiveFlag)
  const toStop = envStates.filter((e) => isProtected(e.env) && (e.sent || e.state.on));
  const stop = async (env: string) => {
    const base = flag.layers[env].base;
    setBusy(true);
    try {
      const reason = `${flag.key} in ${envName(env)}: clean up (stop sending it and turn it off)`;
      const r = await api<{ id: number }>('POST', '/change-sets', { environment: env, reason, items: [
        { flag: flag.key, entity: null, expectedLayerVersion: base.version, proposed: { ...base, enabled: false } },
        { kind: 'delivery', flag: flag.key, entity: null, expectedLayerVersion: null, proposed: null, delivery: { before: flag.delivery[env] ?? [], projects: [] } },
      ] });
      toast(`Sent for review: request #${r.id}`, 'ok', { label: 'View', onClick: () => go(`approvals/${r.id}`) });
      onChanged();
    } catch (e) { toast(e as Error); }
    finally { setBusy(false); }
  };
  const archive = async () => {
    const r = await ask({
      title: `Archive ${flag.key}?`, body: <p>It leaves every service in every environment, right away. Apps that still read it get the default in their code. Its history is kept.</p>,
      actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'go', label: 'Archive', tone: 'danger' }],
    });
    if (r.action !== 'go') return;
    setBusy(true);
    try {
      await api('POST', `/flags/${encodeURIComponent(flag.key)}/archive`);
      toast(`Archived ${flag.key}`);
      reload().catch(() => {});
      go('releases');
    } catch (e) { toast(e as Error); setBusy(false); }
  };
  return (
    <>
      <SectionLabel>Clean up</SectionLabel>
      <ol className="m-0 grid max-w-[780px] gap-3 pl-5 text-13 text-ink-2">
        <li><b className="font-medium text-ink">Remove {flag.key} from your code</b> and ship it. On mobile, old app versions still read it: keep sending it until they’re gone, or they go back to the default in their code.</li>
        {toStop.length > 0 && (
          <li>
            <b className="font-medium text-ink">Stop sending it</b> where changes are reviewed. One request per environment turns it off and takes it out of every service.
            <span className="mt-2 flex flex-wrap gap-2">
              {toStop.map((e) => {
                const w = open.find((r) => r.environment === e.env);
                return <Button key={e.env} variant="secondary" disabled={disabled || busy || !!w} onClick={() => void stop(e.env)}>
                  {w ? `${envName(e.env)}: request #${w.id} waiting` : `Request: stop sending in ${envName(e.env).toLowerCase()}`}
                </Button>;
              })}
            </span>
          </li>
        )}
        <li>
          <b className="font-medium text-ink">Archive it.</b> It leaves every environment and this list; its history stays.
          <span className="mt-2 flex"><Button variant="stop" disabled={disabled || busy || toStop.length > 0} onClick={() => void archive()}>Archive {flag.key}</Button></span>
        </li>
      </ol>
    </>
  );
}
