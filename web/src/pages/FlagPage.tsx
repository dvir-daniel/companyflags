// One flag on its own page, in the order it's checked: Overrides, then each entity's own settings, then the rules for everyone
// and the default. Each layer is a list of "condition → value" rows; the first row that matches wins.
import {
  createContext, lazy, memo, Suspense, use, useCallback, useDeferredValue, useEffect, useImperativeHandle, useMemo, useRef, useState,
  type ReactNode, type Ref,
} from 'react';
import { ArrowLeftIcon, ArrowsClockwiseIcon, CaretDownIcon, CaretRightIcon, CaretUpIcon, CopyIcon, XIcon } from '@phosphor-icons/react';
import { Badge as UIBadge, StatusMark } from '@companyflags/ui/components/badge';
import { Button } from '@companyflags/ui/components/button';
import { NativeSelect } from '@companyflags/ui/components/native-select';
import { SectionLabel } from '@companyflags/ui/components/page';
import { BAR_CONTROLS, FilterSelect, PageBar } from '@companyflags/ui/components/page-bar';
import { useBottomReserve } from '@companyflags/ui/components/toast';
import { Tooltip } from '@companyflags/ui/components/tooltip';
import { Panel } from '@companyflags/ui/components/panel';
import { SearchField } from '@companyflags/ui/components/search-field';
import { Tabs } from '@companyflags/ui/components/tabs';
import { cn } from '@companyflags/ui/lib/utils';
import {
  api, capital, CODE_DEFAULT, dimensionOf, entityIndex, entityLabel, entityWordsOf, KIND_INFO, fieldLabel, fmtValue, getsWithoutOwn, groupLabel, levelOf,
  noValueOp, OPS_BY_TYPE, sameAs, sourceText, title as titleOf, uuid, vocabOf, whenText, withoutOwn, type Condition, type FlagDetail, type Meta, type Split,
} from '../api.ts';
import { followingText, listWords, perWho, settledAt } from '../dimWords.ts';
import { HowItWorks } from '../howItWorks.tsx';
import { DetailBarSkeleton, EnvChip, FlagHistorySkeleton, FlagRulesSkeleton, LinesSkeleton, TabsSkeleton } from '../loading.tsx';
import { FLAG_TABS } from '../loadingKit.ts';
import { go, useApp } from '../app.ts';
import { plural } from '../text.ts';
import { Actions, Badge, ChipInput, Empty, ErrorList, Field, InAppDefault, Modal, OnOff, Pager, ReasonBadge, Switch, Val } from '../ui.tsx';
import { copyText, denseField, fmtDate, monoLabel, textareaField, useAsync, usePersistentState } from '../uiKit.ts';
import { draftEntities, entityCount, entityInfos, isCatchAll, isHidden, lineProblem, preview, removeEntity, setOwnValues, type Draft, type Line } from '../lines.ts';
import { canUsePercent, cleanTags, conditionProblem, flagNameProblem, isVersionFlag, needsRemoveBy, normalizeTag, type FieldFacts } from '../../../server/checks.ts';
import { groupFields, reportedByApp, suggestedValues } from '../../../server/fields.ts';
import { searchHit } from '../../../server/listing.ts';
import type { Section } from '../../../server/evaluator.ts';
import { EntityPicker, DeliveryPanel, GetsText, PowerSwitch, ValueChip, ValueSelect, ValuesPanel } from './flagParts.tsx';
import { useEnvs } from './envs.ts';
import { readSchemaText, schemaText } from './flagTemplates.ts';
import { firstMismatch } from '../../../server/jsonSchema.ts';
import { ReviewDraft } from './draftReview.tsx';
import { releaseState, stepText } from '../../../server/release.ts';
import { useDraft, useDraftFlag } from '../useDraft.ts';

// the History and Debug tabs load their code (History, and through it Approvals; Playground) the first time they open,
// or when the tabs are pointed at
const FlagHistory = lazy(() => import('./History.tsx').then((m) => ({ default: m.FlagHistory })));
const TraceView = lazy(() => import('./Playground.tsx').then((m) => ({ default: m.TraceView })));
const warmTabs = () => { import('./History.tsx').catch(() => {}); import('./Playground.tsx').catch(() => {}); };

const PAGE = 50;

/* ---------------------------------------------------------------- class recipes for this page */

/** A dense text field in an editor row. */
const dense = cn(denseField, 'h-[34px] w-full rounded-none text-13');
/** A rule row: the move buttons, the cells, the remove button; the editor opens under the cells. */
const ROW = 'grid grid-cols-[24px_minmax(0,1fr)_32px] items-start gap-x-3 border-b border-grid py-3 last:border-b-0';
/** "When" and "Serves" side by side; stacked in a narrow window. */
const CELLS = 'grid min-w-0 grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] items-start gap-x-4 gap-y-2 max-sm:grid-cols-1';
/** A small square with a step number (layers, the steps of adding own settings). */
const stepNum = 'inline-grid size-5 shrink-0 place-items-center border border-rule-2 font-mono text-11 font-normal text-ink-2';
/** A plain <button> that reads as a row: no box of its own. */
const rowButton = 'cursor-default rounded-none border-0 bg-transparent p-0 text-left font-normal whitespace-normal text-ink';
const TYPE_NAME: Record<string, string> = { bool: 'Boolean', string: 'String', number: 'Number', json: 'JSON' };
const typeName = (t: string) => TYPE_NAME[t] ?? t;

export function FlagPage({ flagKey, envKey }: { flagKey: string; envKey?: string }) {
  const { meta } = useApp();
  // memory: the environment you last worked in, shared with the flag list and the entity pages
  const [lastEnv, setLastEnv] = usePersistentState('env', '');
  const known = (k?: string) => !!k && meta.environments.some((e) => e.key === k);
  const env = known(envKey) ? envKey! : known(lastEnv) ? lastEnv : meta.environments[0]?.key ?? '';
  useEffect(() => { if (known(envKey) && envKey !== lastEnv) setLastEnv(envKey!); }, [envKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // the tab and the checked entity stay when you switch environment; a flag opens straight on its rules (Google
  // opens the editor, no overview). "Check who gets what" is kept across tabs, so Debug opens on the same entity.
  const [tabOf, setTabOf] = useState<{ flag: string; tab: FlagTab }>({ flag: flagKey, tab: 'targeting' });
  const tab = tabOf.flag === flagKey ? tabOf.tab : 'targeting';
  const [check, setCheck] = useState<Check>({ entity: '', project: '' });
  // one flag, full width (Google's detail pages): the back arrow returns to the list as you left it. The editor is
  // keyed by flag and environment, so another one opens fresh (useDraft.ts useDraftFlag).
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <FlagEditor key={`${flagKey}:${env}`} flagKey={flagKey} env={env} tab={tab} setTab={(t) => setTabOf({ flag: flagKey, tab: t })} check={check} setCheck={setCheck} />
    </div>
  );
}

/** The flag's rules on their own, for a page with its own header and tabs (a release's Rules tab, ReleasePage.tsx):
 *  the same editor, draft, review and publish as on the flag's page. Its other tabs are on the flag's page. */
export function FlagRules({ flagKey, env }: { flagKey: string; env: string }) {
  const [check, setCheck] = useState<Check>({ entity: '', project: '' });
  return <FlagEditor key={`${flagKey}:${env}`} flagKey={flagKey} env={env} tab="targeting" setTab={() => go(`flag/${flagKey}/${env}`)}
    check={check} setCheck={setCheck} embedded />;
}

// `embedded`: only the rules and the draft bar, without the flag's header and tabs (FlagRules)
function FlagEditor({ flagKey, env, tab, setTab, check, setCheck, embedded = false }: {
  flagKey: string; env: string; tab: FlagTab; setTab: (t: FlagTab) => void; check: Check; setCheck: (c: Check) => void; embedded?: boolean;
}) {
  const { meta, toast } = useApp();
  const { envName } = useEnvs();
  // your edits live in the draft session (Google style): leaving the page keeps them until you publish or discard
  const { view, session, reload, edit } = useDraftFlag(env, flagKey);
  const { summary: drafts } = useDraft(env);
  const [reviewing, setReviewing] = useState(false);
  const [publishTried, setPublishTried] = useState(false);
  const [rebasing, setRebasing] = useState(false);
  const reserve = useBottomReserve();
  if (!view.changed && publishTried) setPublishTried(false);           // discarded or published: start quiet again
  // functions that never change, for the memoized rule rows: an edit re-renders only the row it changed
  const reloadFlag = useCallback(() => { void reload(); }, [reload]);
  const lineActions = useMemo<LineActions>(() => ({
    update: (l) => edit((d) => ({ ...d, lines: d.lines.map((x) => (x.id === l.id ? l : x)) })),     // the session keeps them in order
    remove: (id) => edit((d) => ({ ...d, lines: d.lines.filter((x) => x.id !== id) })),
    move: (l, dir) => edit((d) => moveLine(d, l, dir)),
  }), [edit]);

  if (view.status === 'error') {
    return (
      <div className="px-6 py-10 max-sm:px-4">
        <Empty action={<Button variant="secondary" onClick={() => void reload()}>Try again</Button>}>Couldn’t open {flagKey}: {view.error}</Empty>
      </div>
    );
  }
  // the page's own shape while the flag loads (loading.tsx): its bar, its tabs and the rules' layers, with bones
  if (!view.flag || !view.draft) {
    const rules = tab === 'targeting' || tab === 'values' ? <FlagRulesSkeleton /> : null;
    return embedded ? rules : <>
      <DetailBarSkeleton back={`#/flags/${env}`} backLabel="Back to flags" copy env={<EnvChip meta={meta} env={env} to={(v) => `flag/${flagKey}/${v}`} />} />
      <TabsSkeleton widths={FLAG_TABS} />
      {rules}
    </>;
  }
  const { flag, draft, stale } = view;
  const dirty = view.changed;
  const needsApproval = drafts.needsReview;
  const setDraft = (d: Draft) => edit(() => d);
  const setLines = (lines: Line[]) => edit((d) => ({ ...d, lines }));        // the session keeps them in order
  const changeCount = view.sentences.length;
  const incomplete = view.problems.length;
  const tryPublish = () => { if (incomplete) setPublishTried(true); else setReviewing(true); };
  const where = envName(env).toLowerCase();
  const now = view.live ?? flag;                                  // the switch and the state always show the live settings
  const others = drafts.flags.filter((g) => g.key !== flagKey);
  const otherChanges = others.reduce((n, g) => n + Math.max(g.sentences.length, 1), 0);
  // forgiveness: discarding keeps the edits for Undo
  const discard = () => {
    const undo = session.discard([flagKey]);
    toast(`Discarded ${plural(changeCount, 'change')} to ${flag.key} in ${where}`, 'ok', { label: 'Undo', onClick: undo });
  };
  const keepMine = async () => {
    setRebasing(true);
    try { await session.rebase([flagKey]); toast(`Your changes to ${flag.key} are now on the newest version`); }
    catch (e) { toast(e as Error, 'err'); }
    finally { setRebasing(false); }
  };
  return (
    <>
      {!embedded && <>
      {/* the one bar: which flag, which environment, whether it's on, and the switch */}
      <PageBar
        title={<span className="flex min-w-0 items-center gap-1.5">
          <Tooltip content="Back to flags">
            <a href={`#/flags/${env}`} aria-label="Back to flags" className="-ml-2 inline-grid size-8 shrink-0 place-items-center text-ink-2 no-underline transition-colors duration-150 hover:bg-wash hover:text-ink"><ArrowLeftIcon className="size-4" /></a>
          </Tooltip>
          {flag.name ? <span className="truncate">{flag.name}</span> : <span className="truncate font-mono">{flag.key}</span>}
        </span>}
        actions={<>
          <OnOff on={!!now.layers[env].base.enabled} />
          <PowerSwitch flag={now} env={env} onSaved={reloadFlag} />
        </>}>
        {flag.name && <span className="-mr-1 truncate font-mono text-13 text-ink-3 max-sm:max-w-[160px]">{flag.key}</span>}
        <Tooltip content="Copy the key your code reads">
          <button type="button" onClick={() => copyText(flag.key, flag.key, toast)} aria-label={`Copy key ${flag.key}`}
            className="-ml-2 inline-grid size-8 shrink-0 cursor-default place-items-center border-0 bg-transparent text-ink-3 outline-none transition-colors duration-150 hover:bg-wash hover:text-ink focus-visible:outline-1 focus-visible:outline-ink">
            <CopyIcon aria-hidden className="size-4" />
          </button>
        </Tooltip>
        {/* the menu shows every environment's state; the chip names the open one */}
        <FilterSelect label="Environment" value={env} display={envName(env)} onChange={(v) => go(`flag/${flag.key}/${v}`)}
          options={meta.environments.map((e) => [e.key, `${envName(e.key)} · ${now.layers[e.key]?.base.enabled ? 'On' : 'Off'}`] as [string, string])} />
      </PageBar>

      {/* a release has its own page, built around its steps (ReleasePage.tsx); its rules are edited here too */}
      {flag.kind === 'release' && (
        <div className="flex flex-wrap items-center gap-x-2 border-b border-grid px-6 py-2 text-13 text-ink-2 max-sm:px-4">
          <span>This flag is a release: {stepText(releaseState(flag.variations, now.layers[env].base)).toLowerCase()} in {where}.</span>
          <a href={`#/release/${encodeURIComponent(flag.key)}/${encodeURIComponent(env)}`}>Open release →</a>
        </div>
      )}

      {/* tabs right under the header; the page opens on the rules. Pointing at them starts loading the History and
          Debug tabs' code, so they open without a placeholder */}
      <div className="border-b border-rule px-6 max-sm:px-4" onPointerEnter={warmTabs} onFocus={warmTabs}>
        <Tabs<FlagTab> label="Flag sections" value={tab === 'values' && flag.valueType === 'bool' ? 'targeting' : tab} onChange={setTab}
          className="overflow-x-auto border-b-0 [scrollbar-width:none] [&>button]:shrink-0 [&>button]:whitespace-nowrap"
          items={([['targeting', 'Rules'], ['values', flag.freeValues ? 'Variants · off' : `Variants · ${flag.variations.filter((v) => !isHidden(v.key)).length}`], ['history', 'History'], ['settings', 'Settings'], ['debug', 'Debug']] as const)
            .filter(([k]) => !(k === 'values' && flag.valueType === 'bool')).map(([k, label]) => ({ value: k, label }))} />
      </div>
      </>}

      <div className="px-6 pb-10 max-sm:px-4">
        {(tab === 'targeting' || (tab === 'values' && flag.valueType === 'bool')) && (
          <RulesTab flag={flag} env={env} draft={draft} dirty={dirty} setDraft={setDraft} setLines={setLines} actions={lineActions} onFlagChanged={reloadFlag}
            check={check} setCheck={setCheck} onDebug={() => setTab('debug')} />
        )}
        {/* Variants and Settings stay mounted, so switching tabs never drops what you typed there; the editor is keyed by
            flag and environment (FlagPage), so nothing typed carries over into another flag */}
        {flag.valueType !== 'bool' && <div hidden={tab !== 'values'} className="mt-6"><ValuesPanel flag={flag} onSaved={reloadFlag} /></div>}
        <div hidden={tab !== 'settings'}><SettingsTab flag={flag} onSaved={reload} /></div>
        {tab === 'debug' && <DebugTab flag={flag} env={env} draft={draft} dirty={dirty} initialEntity={check.entity || undefined} initialProject={check.project || undefined} />}
        {/* the history table runs edge to edge like every other list (cancels this column's gutter) */}
        {tab === 'history' && (
          <div className="-mx-6 mt-2 max-sm:-mx-4">
            <Suspense fallback={<FlagHistorySkeleton />}><FlagHistory flagKey={flag.key} /></Suspense>
          </div>
        )}
      </div>

      {dirty && (
        // sticks to the bottom of the flag column; toasts stay above it
        <div ref={reserve} role="region" aria-label="Your draft"
          className={cn('sticky bottom-0 z-30 mt-auto flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-rule-2 bg-panel px-6 py-2.5 max-sm:px-4', BAR_CONTROLS)}>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5">
              <StatusMark tone="warn" />
              <span className="text-sm font-semibold text-ink">{plural(changeCount, 'change')} to {flag.key} in your draft</span>
              <span className="text-13 text-ink-3">Saved here until you publish{others.length ? `; ${otherChanges} more in ${plural(others.length, 'other flag')}` : ''}.</span>
            </span>
            {stale && <span role="status" className="flex flex-wrap items-center gap-x-2 text-13 text-live">
              Someone changed {flag.key} in {where} since you started this draft, so publishing it would be refused.
              <Button variant="link" disabled={rebasing} onClick={() => void keepMine()}>{rebasing ? 'Moving your edits…' : 'Keep my edits on the new version'}</Button>
            </span>}
            {publishTried && incomplete > 0 && <span role="status" className="text-13 text-live">Finish {plural(incomplete, 'incomplete rule')} to publish</span>}
          </span>
          <span className="flex items-center gap-2">
            <Button variant="secondary" onClick={discard}>Discard</Button>
            <Button onClick={tryPublish}>{needsApproval ? 'Request review' : 'Publish changes'} ({drafts.changes})</Button>
          </span>
        </div>
      )}

      {reviewing && <ReviewDraft env={env} onClose={() => setReviewing(false)} />}
    </>
  );
}

type FlagTab = 'targeting' | 'values' | 'history' | 'settings' | 'debug';

// ---------------------------------------------------------------- the Rules tab: check who gets what, then the cascade
// Pick an entity and an app to see what they get and which row decides it (Stripe-style "test it").
// It runs the real evaluator on this page's rules, unpublished edits included, with no version or device:
// the Debug tab tests those.

type Check = { entity: string; project: string };
type Win = { ruleKey: string | null; section: Section; owner: string | null };
/** The row that decides for the checked entity, if one is checked. `owner`: the entity whose settings decided (it, or
 *  one above it). */
const WinContext = createContext<Win | null>(null);
/** An entity's own settings decided (its own, or those of one above it), not a rule for everyone. */
const byEntity = (s: Section) => levelOf(s) === 'entity';
/** The deciding row: tinted, with a mark at its left edge. */
const winRow = '-mx-2 bg-ok/[0.06] px-2 shadow-[inset_2px_0_0_var(--ok)]';
const WinsBadge = () => <UIBadge variant="ok" title="This decides what the one checked gets">decides</UIBadge>;

/** The rules as one snapshot (flag, environment, draft), so a deferred copy never mixes two flags. */
type Rules = { flag: FlagDetail; env: string; draft: Draft };
const previewOf = (r: Rules, meta: Meta, ctx: { project: string; entity: string | null; attrs: Record<string, unknown> }) =>
  preview(r.flag, r.env, r.draft, !!r.flag.layers[r.env].base.enabled, meta, ctx);

/** The functions a rule row calls; they never change (FlagEditor makes them once). */
type LineActions = { update: (l: Line) => void; remove: (id: string) => void; move: (l: Line, d: -1 | 1) => void };

function RulesTab({ flag, env, draft, dirty, setDraft, setLines, actions, onFlagChanged, check, setCheck, onDebug }: {
  flag: FlagDetail; env: string; draft: Draft; dirty: boolean; setDraft: (d: Draft) => void; setLines: (l: Line[]) => void; actions: LineActions;
  onFlagChanged: () => void; check: Check; setCheck: (c: Check) => void; onDebug: () => void;
}) {
  const { meta } = useApp();
  const projectOf = (p: string) => (meta.projects.some((x) => x.key === p) ? p : (flag.delivery[env] ?? [])[0] ?? meta.projects[0]?.key ?? '');
  const project = projectOf(check.project);
  // the check runs on a deferred copy of the rules, so typing in a row never waits for it
  const rules = useMemo<Rules>(() => ({ flag, env, draft }), [flag, env, draft]);
  const checked = useDeferredValue(rules);
  const result = useMemo(() => (check.entity ? previewOf(checked, meta, { project, entity: check.entity, attrs: {} }) : null),
    [checked, meta, project, check.entity]);
  // the same object while the same row decides, so the memoized rows don't all re-render on every edit
  const ruleKey = result?.decidedBy.ruleKey ?? null;
  const section = result?.decidedBy.section ?? null;
  const owner = result?.decidedBy.owner ?? null;
  const win = useMemo<Win | null>(() => (section ? { ruleKey, section, owner } : null), [ruleKey, section, owner]);
  const name = (k: string) => entityLabel(meta.entities, k);
  // an entity's own value is stored as a rule with no conditions, or under "Own settings only" as its own default;
  // on this page it's that entity's default either way
  const wonLine = result?.decidedBy.ruleKey ? checked.draft.lines.find((l) => l.id === result.decidedBy.ruleKey) : undefined;
  const from = result && (wonLine && isCatchAll(wonLine) ? `${name(wonLine.entity!)}’s default`
    : sourceText(result.decidedBy, { entity: entityWordsOf(meta.entities, check.entity), nameOf: (k) => entityIndex(meta.entities).get(k)?.name, project, byDevice: result.reason === 'SPLIT' }));
  // rules on a version, a device or a % can't match without those details: the check knows only what the server
  // works out itself (the app, the environment, the entity and those above it, server/fields.ts)
  const known = new Set(meta.fields.filter((f) => !reportedByApp(f.name, f)).map((f) => f.name));
  const needsDevice = draft.lines.some((l) => !l.paused && (!!l.split || l.conditions.some((c) => !known.has(c.field))));
  // what a rule row reads from the draft (the values typed for entities): the same object until those change
  const values = useMemo(() => valuesOnly(draft.newValues), [draft.newValues]);
  // checking an entity whose own settings (or those of one above it) decide opens whose they are, so the deciding row shows
  const layers = useRef<EntityLayersHandle>(null);
  const checkEntity = (next: Check) => {
    setCheck(next);
    if (!next.entity) return;
    const d = previewOf(rules, meta, { project: projectOf(next.project), entity: next.entity, attrs: {} }).decidedBy;
    if (byEntity(d.section) && d.owner) layers.current?.show(d.owner);
  };
  return (
    <WinContext value={win}>
      <section aria-label="Check who gets what" className="mt-6 border border-grid bg-panel px-5 py-3 max-sm:px-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="m-0 min-w-0 flex-1 basis-[260px] text-13 text-ink-2">Checked from the top. The first row that matches decides. <HowItWorks compact /></p>
          <span className="flex flex-wrap items-center gap-2 max-sm:w-full">
            <span className="w-[240px] max-sm:min-w-0 max-sm:flex-1">
              <EntityPicker value={check.entity} onChange={(c) => checkEntity({ ...check, entity: c })} allowNone placeholder="Check who gets what…" />
            </span>
            {meta.projects.length > 1 && (
              <NativeSelect size="sm" aria-label="Service" value={project} onChange={(e) => checkEntity({ ...check, project: e.target.value })}>
                {meta.projects.map((p) => <option key={p.key} value={p.key}>{p.key}</option>)}
              </NativeSelect>
            )}
            {check.entity && <Button variant="ghost" size="icon" className="text-ink-3" title="Stop checking" aria-label="Stop checking" onClick={() => setCheck({ ...check, entity: '' })}><XIcon /></Button>}
          </span>
        </div>
        {result && (
          <div role="status" className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-grid pt-3 text-13 text-ink-2">
            <span><b className="font-semibold text-ink">{name(check.entity)}</b> on <span className="font-mono text-ink">{project}</span> gets</span>
            {result.errorCode || result.codeDefault ? <InAppDefault /> : <Val>{fmtValue(result.value)}</Val>}
            <span className="text-ink-3">· {from}{dirty ? ' · includes your unpublished changes' : ''}</span>
            <span className="flex-1" />
            {needsDevice && <span className="text-ink-3">Rules on a version, device or % need those details.</span>}
            <Button variant="link" onClick={onDebug}>Test a device</Button>
          </div>
        )}
      </section>
      <AlwaysLayer flag={flag} draft={draft} values={values} setLines={setLines} actions={actions} onFlagChanged={onFlagChanged} />
      <EntityLayers ref={layers} flag={flag} env={env} draft={draft} values={values} setDraft={setDraft} setLines={setLines} actions={actions} onFlagChanged={onFlagChanged} />
      <EveryoneLayer flag={flag} draft={draft} values={values} setDraft={setDraft} setLines={setLines} actions={actions} onFlagChanged={onFlagChanged} />
    </WinContext>
  );
}

// ---------------------------------------------------------------- the cascade, strongest → weakest
// The page shows rules in the order they're checked, as storage keeps them: overrides → own settings →
// rules for everyone → the default. The first row that matches wins, so a row beats every row below it.

const groups = (draft: Draft) => ({
  always: draft.lines.filter((l) => !l.entity && l.locked),
  everyone: draft.lines.filter((l) => !l.entity && !l.locked),
  entities: draft.lines.filter((l) => l.entity),
});
/** Moves a row up (-1: stronger, checked earlier) or down among the rows of its own list: the overrides, the rules for
 *  everyone, or one entity's rules (its own value, the group's last catch-all line, stays last). The two rows swap
 *  places; nothing else moves. */
function moveLine(d: Draft, l: Line, dir: -1 | 1): Draft {
  const group = d.lines.filter((x) => (l.entity ? x.entity === l.entity : !x.entity && x.locked === l.locked));
  const last = group[group.length - 1];
  const list = l.entity && last && isCatchAll(last) ? group.slice(0, -1) : group;
  const i = list.findIndex((x) => x.id === l.id);
  const self = list[i];
  const other = list[i + dir];
  if (!self || !other) return d;
  return { ...d, lines: d.lines.map((x) => (x === self ? other : x === other ? self : x)) };
}
/** The draft as a rule row reads it: only the values typed for entities (the value pickers and checks use them). */
const valuesOnly = (newValues: Draft['newValues']): Draft => ({ fallback: CODE_DEFAULT, lines: [], afterEveryone: {}, newValues });

// A layer is a framed panel (shared Panel): its number, name and one sentence, its rows, and a footer for adding.
// An empty layer is just its header: one sentence and the add button, no body.

/** A default ("Default", "Everyone else") with what it applies to, and its value picker, in the row's cells. */
function DefaultRow({ title = 'Default', label, wins, children }: { title?: ReactNode; label: ReactNode; wins?: boolean; children: ReactNode }) {
  return (
    <div className={cn(ROW, wins && winRow)}>
      <span />
      <div className={CELLS}>
        <div className="flex min-h-[34px] flex-wrap items-center gap-x-1.5 text-13"><b className="font-semibold text-ink">{title}</b><span className="text-ink-3">{label}</span></div>
        <div className="flex min-w-0 items-start gap-2"><div className="min-w-0 flex-1">{children}</div>{wins && <span className="flex min-h-[34px] items-center"><WinsBadge /></span>}</div>
      </div>
      <span />
    </div>
  );
}

/** The column heads over a list of rules. */
function RuleHead() {
  return (
    <div aria-hidden className={cn(ROW, 'border-rule py-3', monoLabel)}>
      <span />
      <div className={CELLS}><span>When</span><span className="max-sm:hidden">Serves</span></div>
      <span />
    </div>
  );
}

function AlwaysLayer({ flag, draft, values, setLines, actions, onFlagChanged }: {
  flag: FlagDetail; draft: Draft; values: Draft; setLines: (l: Line[]) => void; actions: LineActions; onFlagChanged: () => void;
}) {
  const { always, everyone, entities } = groups(draft);
  const [fresh, setFresh] = useState<string | null>(null);
  // a new override goes last, so it never quietly beats the ones already there
  const add = () => { const l = { ...newLine(flag, null), locked: true }; setLines([...always, l, ...everyone, ...entities]); setFresh(l.id); };
  const addButton = <Button variant="outline" onClick={add}>+ Add override</Button>;
  if (always.length === 0) {
    return <Panel n={1} title="Overrides" aria-label="Overrides" desc="None. Add one to force a value for everyone, even those with their own settings." actions={addButton} />;
  }
  return (
    <Panel n={1} title="Overrides" aria-label="Overrides" count={always.length} desc="Checked first. They beat everyone’s own settings and every rule below." footer={addButton}>
      <div>
        <RuleHead />
        {always.map((l, i) => <RowEdit key={l.id} line={l} flag={flag} values={values} canUp={i > 0} canDown={i < always.length - 1} onChange={actions.update}
          onRemove={actions.remove} onMove={actions.move} onFlagChanged={onFlagChanged} autoOpen={fresh === l.id} />)}
      </div>
    </Panel>
  );
}

function EveryoneLayer({ flag, draft, values, setDraft, setLines, actions, onFlagChanged }: {
  flag: FlagDetail; draft: Draft; values: Draft; setDraft: (d: Draft) => void; setLines: (l: Line[]) => void; actions: LineActions; onFlagChanged: () => void;
}) {
  const win = use(WinContext);
  const { always, everyone, entities } = groups(draft);
  const [fresh, setFresh] = useState<string | null>(null);
  // a new rule goes last, right above the default and next to the button
  const add = () => { const l = newLine(flag, null); setLines([...always, ...everyone, l, ...entities]); setFresh(l.id); };
  const anything = draft.lines.length > 0 || Object.keys(draft.afterEveryone).length > 0;
  return (
    <Panel n={3} title="Rules for everyone" aria-label="Rules for everyone" count={everyone.length || undefined}
      desc={everyone.length ? 'Checked last, then the default.' : 'No rules, so the default below applies.'}
      footer={<Button variant="outline" onClick={add}>+ Add rule</Button>}>
      <div>
        {everyone.length > 0 && <RuleHead />}
        {everyone.map((l, i) => <RowEdit key={l.id} line={l} flag={flag} values={values} canUp={i > 0} canDown={i < everyone.length - 1} onChange={actions.update}
          onRemove={actions.remove} onMove={actions.move} onFlagChanged={onFlagChanged} autoOpen={fresh === l.id} />)}
        <DefaultRow title={anything ? 'Everyone else' : 'Everyone'} label={anything ? 'when nothing above matches' : 'gets'} wins={win?.section === 'default'}>
          <ValueSelect flag={flag} draft={draft} value={draft.fallback} onChange={(v) => setDraft({ ...draft, fallback: v })} onNewValue={onFlagChanged} withDefaultSwitch />
        </DefaultRow>
      </div>
    </Panel>
  );
}

const newLine = (flag: FlagDetail, entity: string | null): Line => ({
  id: uuid(), entity, locked: false, paused: false, name: null, conditions: [{ field: 'project', op: 'in', values: [] }],
  serveVariation: flag.variations.find((v) => !isHidden(v.key))?.key ?? CODE_DEFAULT, split: null,
});

// ---------------------------------------------------------------- entities' own settings

/** What the Rules tab can ask of the list: open an entity's settings (on its page, the search cleared) if it's listed. */
type EntityLayersHandle = { show: (entity: string) => void };
const NO_LINES: Line[] = [];
const collate = new Intl.Collator().compare;

function EntityLayers({ flag, env, draft, values, setDraft, setLines, actions, onFlagChanged, ref }: {
  flag: FlagDetail; env: string; draft: Draft; values: Draft; setDraft: (d: Draft) => void; setLines: (l: Line[]) => void; actions: LineActions;
  onFlagChanged: () => void; ref?: Ref<EntityLayersHandle>;
}) {
  const { meta } = useApp();
  const [q, setQ] = useState('');
  const [dim, setDim] = useState('');
  const [page, setPage] = useState(0);
  const [adding, setAdding] = useState(false);
  const [focusLine, setFocusLine] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  // shown as "Acme 12 (Acme)" and sorted under those above it: by the names down the chain from the top, so a parent
  // comes right before the entities under it (the list and "jump to" use this one order)
  const infos = entityInfos(meta.entities);
  const names = useMemo(() => new Map(meta.entities.map((c) => [c.key, entityLabel(meta.entities, c.key)])), [meta.entities]);
  const byPlace = useMemo(() => {
    const placeOf = (k: string) => [...(infos[k]?.path ?? [k])].reverse().map((x) => infos[x]?.name ?? x);
    return (a: string, b: string) => {
      const x = placeOf(a); const y = placeOf(b);
      for (let i = 0; i < Math.min(x.length, y.length); i++) { const c = collate(x[i], y[i]); if (c) return c; }
      return x.length - y.length || collate(a, b);
    };
  }, [infos]);
  // sorted again only when the entities in the draft change, not on every edit (keys never hold a newline)
  const inDraft = draftEntities(draft).join('\n');
  const keys = useMemo(() => (inDraft ? inDraft.split('\n') : []).sort(byPlace), [inDraft, byPlace]);
  // each entity's lines, in one pass over the draft
  const linesOf = useMemo(() => {
    const m = new Map<string, Line[]>();
    for (const l of draft.lines) if (l.entity) { const a = m.get(l.entity); if (a) a.push(l); else m.set(l.entity, [l]); }
    return m;
  }, [draft.lines]);
  // the dimensions with own settings here: a filter once there are several
  const dimOf = (k: string) => infos[k]?.dimension ?? '';
  const dimsHere = meta.dimensions.filter((d) => keys.some((k) => dimOf(k) === d.key));
  const inDim = dim && dimsHere.some((d) => d.key === dim) ? dim : '';
  const needle = q.trim().toLowerCase();
  const filtered = keys.filter((c) => (!inDim || dimOf(c) === inDim) && searchHit(needle, names.get(c), c));
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const p = Math.min(page, pages - 1);
  const shown = filtered.slice(p * PAGE, p * PAGE + PAGE);
  const pageOf = (c: string, list: string[]) => Math.floor(Math.max(0, list.indexOf(c)) / PAGE);

  // after adding (or finding) one: clear the search, turn to its page, open it, and scroll to it once it shows
  const scrollTo = useRef<string | null>(null);
  const reveal = (c: string) => {
    setQ(''); setDim(''); setPage(pageOf(c, keys.includes(c) ? keys : [...keys, c].sort(byPlace)));
    setOpen(c);
    scrollTo.current = c;
  };
  useEffect(() => {
    const c = scrollTo.current;
    if (!c || open !== c) return;
    scrollTo.current = null;
    document.getElementById(`own-${c}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
  // "Check who gets what": when an entity's own settings decide, the Rules tab opens them so the deciding row shows
  useImperativeHandle(ref, () => ({
    show: (c: string) => { if (keys.includes(c)) { setQ(''); setDim(''); setPage(pageOf(c, keys)); setOpen(c); } },
  }));
  const empty = keys.length === 0;
  const who = listWords(meta.dimensions);
  const noun = dimsHere.length === 1 ? dimsHere[0].plural : 'entries';

  return (
    <Panel n={2} title={perWho(meta.dimensions)} aria-label={perWho(meta.dimensions)} id="own-settings" count={empty ? undefined : keys.length.toLocaleString()}
      desc={!meta.dimensions.length ? 'Nothing to set: add dimensions in Settings first.'
        : empty ? 'None. Everyone gets the rules below.' : 'Checked next, for those listed here and those under them.'} actions={
        <span className="flex flex-wrap items-center gap-2 max-sm:w-full">
          {dimsHere.length > 1 && (
            <NativeSelect size="sm" aria-label="Dimension" value={inDim} onChange={(e) => { setDim(e.target.value); setPage(0); }}>
              <option value="">All</option>
              {dimsHere.map((d) => <option key={d.key} value={d.key}>{titleOf(d)}</option>)}
            </NativeSelect>
          )}
          {keys.length > 0 && <SearchField size="sm" className="w-[240px] max-sm:w-auto max-sm:flex-1" placeholder={`Search ${entityCount(keys, meta)}`}
            value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} aria-label="Search own settings" />}
          {meta.dimensions.length > 0 && <Button variant="outline" onClick={() => setAdding(true)}>+ Add {who}</Button>}
        </span>
      }>
      {(adding || !empty) && <>
      {adding && <AddOwnDialog flag={flag} draft={draft} existing={new Set(keys)} onClose={() => setAdding(false)} onNewValue={onFlagChanged}
        onExisting={(c) => { setAdding(false); reveal(c); }}
        onAdd={(c, choice) => {
          if (choice.kind === 'value') setDraft(setOwnValues(draft, [c], choice.value));
          else { const l = newLine(flag, c); setLines([...draft.lines.filter((x) => x.entity !== c), l, ...draft.lines.filter((x) => x.entity === c)]); setFocusLine(l.id); }
          setAdding(false); reveal(c);
        }} />}
      {!empty && <div>
        {(q || inDim) && <p className="m-0 border-b border-grid py-2 font-mono text-11 tracking-[0.55px] text-ink-3 uppercase">{filtered.length.toLocaleString()} of {keys.length.toLocaleString()}{q ? ` match “${q}”` : ''}</p>}
        {q && filtered.length === 0 && <p className="m-0 border-b border-grid py-3 text-13 text-ink-3">Nothing matches “{q}”.</p>}
        {shown.map((c) => (
          <EntityLayer key={c} entity={c} env={env} name={names.get(c) ?? c} lines={linesOf.get(c) ?? NO_LINES} flag={flag} draft={draft} values={values}
            setDraft={setDraft} setLines={setLines} actions={actions} open={open === c} onToggle={() => setOpen(open === c ? null : c)}
            onFlagChanged={onFlagChanged} focusLine={focusLine} />
        ))}
      </div>}
      {filtered.length > PAGE && <Pager page={p} size={PAGE} matched={filtered.length} noun={noun} onPage={setPage} />}
      </>}
    </Panel>
  );
}

/** One entity's own settings: a header row that opens its rules (memoized rows) and its default. `lines`: this
 *  entity's lines, in order. */
function EntityLayer({ entity, env, name, lines, flag, draft, values, setDraft, setLines, actions, open, onToggle, onFlagChanged, focusLine }: {
  entity: string; env: string; name: string; lines: Line[]; flag: FlagDetail; draft: Draft; values: Draft; setDraft: (d: Draft) => void; setLines: (l: Line[]) => void;
  actions: LineActions; open: boolean; onToggle: () => void; onFlagChanged: () => void; focusLine?: string | null;
}) {
  const { toast, meta } = useApp();
  // with nothing of its own here, it gets what its parent gets, or at the top the same as everyone
  const who = entityWordsOf(meta.entities, entity);
  const dimension = entityIndex(meta.entities).get(entity)?.dimension ?? '';
  // the entity's own value is its group's last line when that line has no conditions (as in toLayers);
  // every other line of the group, condition-free or not, is a rule
  const group = lines;
  const last = group[group.length - 1];
  const own = last && isCatchAll(last) ? last : undefined;
  const rules = own ? group.slice(0, -1) : group;
  // a default that comes after the rules for everyone (they win over it)
  const later = draft.afterEveryone[entity] as string | undefined;
  const setLater = (v: string | null) => setDraft({ ...draft, afterEveryone: Object.fromEntries([...Object.entries(draft.afterEveryone).filter(([c]) => c !== entity), ...(v ? [[entity, v]] : [])]) });
  const [fresh, setFresh] = useState<string | null>(null);
  // how many entities under it follow its settings on this flag: saving them changes what those get too
  const [following, setFollowing] = useState<number | null>(null);
  const hasBelow = meta.dimensions.findIndex((d) => d.key === dimension) < meta.dimensions.length - 1;
  useEffect(() => {
    if (!open || !hasBelow) return;
    let live = true;
    api<{ following?: number }>('GET', `/flags/${encodeURIComponent(flag.key)}/impact/${encodeURIComponent(env)}?entity=${encodeURIComponent(entity)}`)
      .then((r) => { if (live) setFollowing(r.following ?? 0); }, () => {});
    return () => { live = false; };
  }, [open, hasBelow, flag.key, env, entity]);
  const alsoChanges = following ? followingText(meta.dimensions, dimension, following, name) : null;
  // a new rule goes last among the entity's rules, right above its default and next to the button
  const add = () => {
    const l = newLine(flag, entity);
    setLines([...draft.lines.filter((x) => x.entity !== entity), ...rules, l, ...(own ? [own] : [])]);
    setFresh(l.id);
  };
  const removeAll = () => {
    const before = draft;
    setDraft(removeEntity(draft, entity));
    toast(`Removed ${name}'s settings from your changes; ${name} ${getsWithoutOwn(who)} once you publish`, 'ok', { label: 'Undo', onClick: () => setDraft(before) });
  };
  // "Check who gets what": this entity's settings decide (its header is marked, its deciding row tinted)
  const win = use(WinContext);
  const decides = !!win && win.owner === entity && byEntity(win.section);
  // under "Own settings only" the own value is saved as its own default, so it decides as `entity_default`
  const defaultWins = decides && (own ? win!.ruleKey === own.id || win!.section === 'entity_default' : !!later && win!.section === 'entity_default');
  const ownText = own?.serveVariation ? <GetsText line={own} flag={flag} draft={draft} />
    : later ? <span className="inline-flex flex-wrap items-center gap-x-1.5"><ValueChip v={later} flag={flag} draft={draft} /><span className="text-13 text-ink-3">after the rules for everyone</span></span>
    : <span className="text-13 text-ink-3">{sameAs(who)}</span>;
  const sameAsDefaults = <Button variant="ghost" size="icon" className="text-ink-3" title={sameAs(who)} aria-label={`Use ${withoutOwn(who)}`} onClick={() => (own ? actions.remove(own.id) : setLater(null))}><XIcon /></Button>;
  const d = dimensionOf(meta.dimensions, dimension);
  return (
    <div id={`own-${entity}`} className="border-b border-grid last:border-b-0">
      <button type="button" onClick={onToggle} aria-expanded={open}
        className={cn(rowButton, '-mx-5 flex min-h-12 w-[calc(100%+2.5rem)] flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 text-13 hover:bg-wash aria-expanded:bg-wash focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-ink max-sm:-mx-4 max-sm:w-[calc(100%+2rem)] max-sm:px-4')}>
        {open ? <CaretDownIcon aria-hidden className="size-3.5 shrink-0 text-ink-3" /> : <CaretRightIcon aria-hidden className="size-3.5 shrink-0 text-ink-3" />}
        <b className="min-w-0 truncate text-sm font-semibold">{name}</b>
        {d && meta.dimensions.length > 1 && <span className="font-mono text-11 tracking-[0.55px] text-ink-3 uppercase">{capital(d.singular)}</span>}
        {rules.length > 0 && <span className="font-mono text-11 tracking-[0.55px] text-ink-3 uppercase">{plural(rules.length, 'rule')}</span>}
        {decides && <WinsBadge />}
        <span className="ml-auto flex min-w-0 items-center max-sm:ml-[26px] max-sm:basis-full">{ownText}</span>
      </button>
      {open && (
        <div className="mb-3 ml-[11px] border-l border-rule pl-4 max-sm:ml-0 max-sm:pl-2.5">
          {alsoChanges && <p role="note" className="m-0 border-b border-grid py-2 text-13 text-ink-2">{alsoChanges}</p>}
          {rules.map((l, i) => <RowEdit key={l.id} line={l} flag={flag} values={values} canUp={i > 0} canDown={i < rules.length - 1} onChange={actions.update}
            onRemove={actions.remove} onMove={actions.move} onFlagChanged={onFlagChanged} autoOpen={fresh === l.id || focusLine === l.id} />)}
          <DefaultRow wins={defaultWins} label={<>for {name}{!own && later ? ', when no rule above or for everyone matches' : rules.length ? ', when no rule above matches' : ''}</>}>
            {own
              ? <div className="flex min-w-0 items-start gap-1"><div className="min-w-0 flex-1"><ValueSelect flag={flag} draft={draft} value={own.serveVariation} onChange={(v) => actions.update({ ...own, serveVariation: v })} onNewValue={onFlagChanged} withDefaultSwitch /></div>{sameAsDefaults}</div>
              : later
                ? <div className="flex min-w-0 items-start gap-1"><div className="min-w-0 flex-1"><ValueSelect flag={flag} draft={draft} value={later} onChange={setLater} onNewValue={onFlagChanged} withDefaultSwitch /></div>{sameAsDefaults}</div>
                : <div className="flex min-h-8 flex-wrap items-center gap-x-2 text-13 text-ink-3">{sameAs(who)}
                    <Button variant="link" onClick={() => setDraft(setOwnValues(draft, [entity], flag.variations.find((v) => !isHidden(v.key))?.key ?? CODE_DEFAULT))}>Set a default</Button></div>}
          </DefaultRow>
          <div className="flex flex-wrap items-center gap-2 pt-3">
            <Button variant="secondary" onClick={add}>+ Add rule</Button>
            <span className="flex-1" />
            <Button variant="secondary" className="text-live hover:text-live" onClick={removeAll}>Remove its own settings</Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- settings

/** One setting: a name and a sentence on the left, its control on the right (CompanyMemory's settings rows). */
function SettingRow({ name, desc, children, top }: { name: ReactNode; desc?: ReactNode; children: ReactNode; top?: boolean }) {
  return (
    <div className={cn('grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-6 border-b border-grid py-3 max-sm:grid-cols-1 max-sm:gap-2', top && 'items-start')}>
      <div className="min-w-0">
        <div className="text-sm font-medium text-ink">{name}</div>
        {desc && <p className="m-0 text-13 text-ink-2">{desc}</p>}
      </div>
      <div className="min-w-0 max-sm:w-full">{children}</div>
    </div>
  );
}
const settingField = 'w-[320px] max-sm:w-full';

/** jsonSchema: as typed in its textarea (empty: none) */
type SettingsForm = { name: string; tags: string[]; description: string; owner: string; kind: string; removeBy: string; freeValues: boolean; jsonSchema: string };

function SettingsTab({ flag, onSaved }: { flag: FlagDetail; onSaved: () => Promise<unknown> }) {
  const { toast, ask, reload, setDirty } = useApp();
  const init: SettingsForm = { name: flag.name ?? '', tags: flag.tags, description: flag.description ?? '', owner: flag.owner ?? '', kind: flag.kind, removeBy: flag.removeBy ?? '', freeValues: !!flag.freeValues,
    jsonSchema: schemaText(flag.jsonSchema) };
  // a version release's values are its versions: always typed in
  const versionRelease = flag.kind === 'release' && isVersionFlag({ valueType: flag.valueType, variants: flag.variations });
  // only what you changed is kept: the rest always shows the saved settings (someone else's save too), and after a
  // save the form is the server's copy again (it trims names), so it isn't left looking unsaved
  const [edits, setEdits] = useState<Partial<SettingsForm>>({});
  const f: SettingsForm = { ...init, ...edits };
  const setF = (patch: Partial<SettingsForm>) => setEdits((e) => ({ ...e, ...patch }));
  const { busy, error, run } = useAsync();
  const dirty = JSON.stringify(f) !== JSON.stringify(init);
  useEffect(() => { setDirty(`settings:${flag.key}`, dirty); return () => setDirty(`settings:${flag.key}`, false); }, [dirty, flag.key, setDirty]);
  // a version release (its values are versions) stays, so it has no remove-by date
  const removeByRequired = needsRemoveBy(f.kind, { valueType: flag.valueType, variants: flag.variations });
  const nameError = flagNameProblem(f.name);
  const tagError = cleanTags(f.tags).problem;
  const isJson = flag.valueType === 'json';
  const typedSchema = readSchemaText(isJson ? f.jsonSchema : '');
  // the named variants that don't match (the server also checks the typed values the rules serve)
  const schemaError = typedSchema.error ?? (typedSchema.schema ? firstMismatch(typedSchema.schema, flag.variations.filter((v) => !isHidden(v.key))) : null);
  const save = async () => {
    // the reload is part of saving: the edits are dropped once the saved settings are back, so nothing flickers
    const saved = await run(async () => {
      await api('PUT', `/flags/${flag.key}/meta`, { ...f, tags: cleanTags(f.tags).tags, removeBy: f.removeBy || null,
        jsonSchema: isJson && f.jsonSchema !== init.jsonSchema ? typedSchema.schema : undefined });
      await onSaved();
      return true;
    });
    if (saved) { setEdits({}); toast(`Saved the settings of ${f.name.trim() || flag.key}`); }
  };
  const archive = async () => {
    const r = await ask({ title: `Archive ${flag.key}?`, body: <><p>The flag leaves every service in every environment, right away and without a review. Apps and backends fall back to the default in their code.</p><p className="text-ink-3">Its history is kept.</p></>,
      actions: [{ id: 'c', label: 'Cancel' }, { id: 'a', label: 'Archive flag', tone: 'danger' }] });
    if (r.action !== 'a') return;
    try {
      await api('POST', `/flags/${flag.key}/archive`); toast(`Archived ${flag.key}`); go('flags');
      reload().catch((e: Error) => toast(`Archived ${flag.key}, but the console couldn’t refresh: ${e.message}`, 'err'));
    } catch (e) { toast(e as Error); }
  };
  const label = 'max-w-none font-normal tracking-normal';
  return (
    <div className="max-w-[780px]">
      <SectionLabel className={cn('mt-8 mb-1', label)}>General</SectionLabel>
      <p className="m-0 mb-1 text-13 text-ink-3">Applies to every environment.</p>
      <SettingRow name="Key" desc="Can’t be changed.">
        <span className="flex items-center gap-3"><span className="font-mono text-13 break-all text-ink">{flag.key}</span>
          <Button variant="link" onClick={() => copyText(flag.key, flag.key, toast)}>Copy</Button></span>
      </SettingRow>
      <SettingRow name="Type"><span className="text-13 text-ink-2">{typeName(flag.valueType)}</span></SettingRow>
      {flag.valueType !== 'bool' && (
        <SettingRow name="Variants" desc={versionRelease ? 'A version release’s values are its versions, typed in when each one starts.'
          : f.freeValues ? 'Off: type any value into the rules and the default.' : 'On: rules and the default pick from the named values on the Variants tab.'}>
          <Switch label="Variants" checked={!f.freeValues} disabled={versionRelease} onChange={(on) => setF({ freeValues: !on })}>
            <span className="text-13 text-ink-2">{f.freeValues ? 'Off · free values' : 'On · named values'}</span>
          </Switch>
        </SettingRow>
      )}
      {flag.createdAt && <SettingRow name="Created"><span className="text-13 text-ink-2">{fmtDate(flag.createdAt)}</span></SettingRow>}
      <SettingRow name="Name" desc="What people see in the list. The key stays what code reads.">
        <input aria-label="Name" value={f.name} onChange={(e) => setF({ name: e.target.value })} placeholder="New checkout flow" aria-invalid={!!nameError} className={cn(dense, settingField)} />
        {nameError && <span className="mt-1 block text-13 text-live">{nameError}</span>}
      </SettingRow>
      <SettingRow top name="Description">
        <textarea rows={3} aria-label="Description" value={f.description} onChange={(e) => setF({ description: e.target.value })} placeholder="New checkout flow for Android and iOS"
          className={cn(textareaField, 'rounded-none text-13', settingField)} />
      </SettingRow>
      <SettingRow name="Owner" desc="The team responsible for it.">
        <input aria-label="Owner" value={f.owner} onChange={(e) => setF({ owner: e.target.value })} placeholder="payments-team" className={cn(dense, settingField)} />
      </SettingRow>
      <SettingRow name="Tags" desc="To group flags by team or area. Press Enter after each.">
        <div className={settingField}><ChipInput label="Tags" values={f.tags} onChange={(v) => setF({ tags: v.map(normalizeTag) })} placeholder="checkout, web" invalid={!!tagError} /></div>
        {tagError && <span className="mt-1 block text-13 text-live">{tagError}</span>}
      </SettingRow>
      <SettingRow name="Purpose" desc={KIND_INFO[f.kind]}>
        <NativeSelect size="sm" aria-label="Purpose" className={settingField} value={f.kind} onChange={(e) => setF({ kind: e.target.value })}>
          {Object.keys(KIND_INFO).map((k) => <option key={k} value={k}>{(KIND_INFO[k] ?? k).split(' — ')[0]}</option>)}
        </NativeSelect>
      </SettingRow>
      <SettingRow name={<>Remove by{removeByRequired && <span className="font-normal text-ink-3"> (required)</span>}</>} >
        <input type="date" aria-label="Remove by" value={f.removeBy} onChange={(e) => setF({ removeBy: e.target.value })} aria-invalid={removeByRequired && !f.removeBy}
          className={cn(dense, 'font-mono', settingField)} />
      </SettingRow>
      {isJson && (
        <SettingRow top name="JSON Schema" desc="Every value must match it: the variants, and the values typed into the rules. Empty: no schema.">
          <textarea rows={8} spellCheck={false} aria-label="JSON Schema" value={f.jsonSchema} onChange={(e) => setF({ jsonSchema: e.target.value })}
            placeholder={'{ "type": "object", "required": ["model"] }'} aria-invalid={!!schemaError}
            className={cn(textareaField, 'rounded-none font-mono text-13', settingField)} />
          {schemaError && <span className="mt-1 block text-13 text-live">{schemaError}</span>}
        </SettingRow>
      )}
      <div className="grid gap-3 pt-4">
        <ErrorList error={error} />
        <Actions className="justify-start">
          <Button disabled={!dirty || busy || !!nameError || !!tagError || !!schemaError || (removeByRequired && !f.removeBy)} onClick={save}>{busy ? 'Saving…' : 'Save'}</Button>
          {dirty && <Button variant="secondary" onClick={() => setEdits({})}>Cancel</Button>}
        </Actions>
      </div>

      <SectionLabel className={cn('mb-2', label)}>Services</SectionLabel>
      <DeliveryPanel flag={flag} onSaved={() => void onSaved()} />

      <SectionLabel className={cn('mb-1', label)}>Archive</SectionLabel>
      <SettingRow name="Archive this flag" desc="Takes it out of every service in every environment.">
        <Button variant="stop" onClick={archive}>Archive flag</Button>
      </SettingRow>
    </div>
  );
}

// ---------------------------------------------------------------- add own settings (find → decide → add)

type Choice = { kind: 'value'; value: string } | { kind: 'conditions' };

function Step({ n, title, disabled, children }: { n: number; title: ReactNode; disabled?: boolean; children: ReactNode }) {
  return (
    <section aria-disabled={disabled || undefined} className={cn('grid gap-2.5', disabled && 'opacity-50')}>
      <h3 className="m-0 flex items-center gap-2.5 text-sm font-medium tracking-normal text-ink"><span className={stepNum}>{n}</span>{title}</h3>
      {children}
    </section>
  );
}

/** One choice as a cell: a square radio, a name and a sentence; what the choice needs opens under it. */
function Option({ checked, disabled, onSelect, title, desc, children }: { checked: boolean; disabled: boolean; onSelect: () => void; title: string; desc: string; children?: ReactNode }) {
  return (
    <div className={cn('relative -mt-px border p-3.5', checked && !disabled ? 'z-[1] border-ink' : 'border-grid')}>
      <label className="flex cursor-default items-start gap-3">
        <input type="radio" name="ac-kind" checked={checked} disabled={disabled} onChange={onSelect}
          className="mt-[3px] size-3.5 shrink-0 cursor-default appearance-none rounded-none border border-rule-2 bg-background p-0 outline-none checked:border-tint checked:bg-tint checked:shadow-[inset_0_0_0_3px_var(--page)] focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-ink" />
        <span className="grid gap-0.5"><b className="text-sm font-medium text-ink">{title}</b><span className="text-13 text-ink-2">{desc}</span></span>
      </label>
      {children && <div className="mt-3 pl-[26px]">{children}</div>}
    </div>
  );
}

function AddOwnDialog({ flag, draft, existing, onClose, onExisting, onAdd, onNewValue }: {
  flag: FlagDetail; draft: Draft; existing: Set<string>; onClose: () => void; onExisting: (c: string) => void; onAdd: (c: string, choice: Choice) => void;
  /** A variant made from the dialog's value picker: reload the flag, so the picker lists it. */
  onNewValue: () => void;
}) {
  const { meta } = useApp();
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [kind, setKind] = useState<'value' | 'conditions'>('value');
  const [value, setValue] = useState(flag.variations.find((v) => !isHidden(v.key))?.key ?? CODE_DEFAULT);
  const matches = useMemo(() => {
    const n = q.trim().toLowerCase();
    return meta.entities.filter((c) => !n || c.name.toLowerCase().includes(n) || c.key.includes(n)).slice(0, 8);
  }, [meta.entities, q]);
  const ent = picked ? entityIndex(meta.entities).get(picked) : null;
  const who = entityWordsOf(meta.entities, picked);
  const baseGets = draft.fallback === CODE_DEFAULT ? 'the in-app default' : fmtValue(flag.variations.find((v) => v.key === draft.fallback)?.value ?? draft.fallback);
  const result = cn(rowButton, 'flex min-h-10 w-full items-center justify-between gap-3 px-2 py-2 text-13 hover:bg-wash focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-ink');
  const hint = 'shrink-0 font-mono text-11 tracking-[0.55px] text-ink-3 uppercase';
  // what each match is: "Store · Acme"
  const whatIs = (c: { dimension: string; parent?: string | null }) => {
    const d = dimensionOf(meta.dimensions, c.dimension);
    return [meta.dimensions.length > 1 && d ? capital(d.singular) : null, c.parent ? entityLabel(meta.entities, c.parent) : null].filter(Boolean).join(' · ');
  };
  return (
    <Modal title={`Add ${listWords(meta.dimensions)}`} wide onClose={onClose} footer={
      <Actions>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button disabled={!picked} onClick={() => picked && onAdd(picked, kind === 'value' ? { kind, value } : { kind })}>Add</Button>
      </Actions>
    }>
      <Step n={1} title="Who">
        {ent ? (
          <div className="flex items-center justify-between gap-3 border border-rule bg-panel px-3 py-2">
            <span className="min-w-0 truncate text-13"><b className="font-medium text-ink">{ent.name}</b> <span className="font-mono text-xs text-ink-3">{ent.key}</span>
              {whatIs(ent) && <span className="text-ink-3"> · {whatIs(ent)}</span>}</span>
            <Button variant="link" onClick={() => setPicked(null)}>Change</Button>
          </div>
        ) : (
          <div className="grid gap-2">
            <SearchField data-autofocus placeholder={`Search ${entityCount(meta.entities.map((e) => e.key), meta)} by name`} value={q} onChange={(e) => setQ(e.target.value)} aria-label={`Search: ${listWords(meta.dimensions)}`} />
            {/* a plain list of buttons: Tab moves through them, Enter or Space picks one */}
            <ul aria-label="Matches" className="m-0 list-none border-t border-rule p-0">
              {matches.map((c) => (
                <li key={c.key} className="border-b border-grid">
                  {existing.has(c.key)
                    ? <button type="button" className={result} onClick={() => onExisting(c.key)}><span className="min-w-0 truncate"><b className="font-medium">{c.name}</b></span><span className={hint}>Already set up · open</span></button>
                    : <button type="button" className={result} onClick={() => setPicked(c.key)}>
                        <span className="min-w-0 truncate"><b className="font-medium">{c.name}</b> <span className="font-mono text-xs text-ink-3">{c.key}</span>
                          {whatIs(c) && <span className="text-ink-3"> · {whatIs(c)}</span>}</span><span className={hint}>Select</span>
                      </button>}
                </li>
              ))}
              {matches.length === 0 && <li className="border-b border-grid px-2 py-2.5 text-13 text-ink-3">Nothing matches “{q}”.</li>}
            </ul>
          </div>
        )}
      </Step>

      <Step n={2} title={`What should ${ent?.name ?? 'it'} get?`} disabled={!ent}>
        <p className="m-0 text-13 text-ink-2">Right now it gets {withoutOwn(who)}{!who?.above.length && draft.fallback ? `: ${baseGets}${draft.lines.some((l) => !l.entity) ? ' when no rule matches' : ''}` : ''}.</p>
        <div role="radiogroup" aria-label="What it gets" className="grid pt-px">
          <Option checked={kind === 'value'} disabled={!ent} onSelect={() => setKind('value')} title="One variant" desc="The same variant on every app and version.">
            {kind === 'value' && ent && <ValueSelect flag={flag} draft={draft} value={value} onChange={setValue} onNewValue={onNewValue} withDefaultSwitch />}
          </Option>
          <Option checked={kind === 'conditions'} disabled={!ent} onSelect={() => setKind('conditions')} title="Rules" desc="For example a different variant on Android. You’ll set up the rule next." />
        </div>
      </Step>
    </Modal>
  );
}

// ---------------------------------------------------------------- a row: condition → value

// Memoized: its props are the row's own line, functions that never change (LineActions, the flag's reload), and
// `values` (the draft's typed values only), so an edit re-renders the row it changed, not every row.
const RowEdit = memo(function RowEdit({ line, flag, values, canUp, canDown, onChange, onRemove, onMove, onFlagChanged, autoOpen }: {
  line: Line; flag: FlagDetail; values: Draft; canUp: boolean; canDown: boolean; onChange: (l: Line) => void; onRemove: (id: string) => void;
  onMove: (l: Line, d: -1 | 1) => void; onFlagChanged: () => void; autoOpen?: boolean;
}) {
  const { meta } = useApp();
  const [editCond, setEditCond] = useState(!!autoOpen);
  // a rollout is just another condition ("20% of devices"); the value cell only picks the value
  const simple = !line.split || (line.split.ranges.length === 1 && line.split.ranges[0].from === 0);
  const served = line.split ? line.split.ranges[0]?.variation ?? CODE_DEFAULT : line.serveVariation;
  const pct = line.split && simple ? +((line.split.ranges[0].to - line.split.ranges[0].from) / 100).toFixed(2) : null;
  const setValue = (v: string) => onChange(line.split ? { ...line, split: { ...line.split, ranges: line.split.ranges.map((r, i) => (i === 0 ? { ...r, variation: v } : r)) } } : { ...line, serveVariation: v });
  const vocab = vocabOf(meta);
  const text = line.split && pct === null
    ? [whenText(line.conditions, { vocab, empty: '' }), 'split by device'].filter(Boolean).join(' and ')
    : whenText(line.conditions, { percent: pct, vocab, empty: 'All requests' });
  const groupNames = line.split ? [...line.split.ranges.map((r) => r.group), line.split.outsideGroup].filter((g): g is string => !!g) : [];
  // the server's own checks: null when it can be saved (lines.ts keeps each line's answer until the line changes)
  const problem = lineProblem(line, flag, values, meta.fields);
  const wins = use(WinContext)?.ruleKey === line.id;
  // errors stay quiet until someone tries to finish the rule (Done, or folding it away); a fixed rule is quiet again
  const [tried, setTried] = useState(false);
  if (tried && !problem) setTried(false);
  const finish = () => { if (problem) setTried(true); else setEditCond(false); };
  const mover = 'size-6 min-h-0 p-0 text-ink-3 hover:text-ink [&_svg]:size-3';
  return (
    <div className={cn(ROW, wins && winRow)}>
      <span className="flex flex-col">
        <Button variant="ghost" className={mover} aria-label="Move up" title="Move up: checked earlier" disabled={!canUp} onClick={() => onMove(line, -1)}><CaretUpIcon weight="bold" /></Button>
        <Button variant="ghost" className={mover} aria-label="Move down" title="Move down: checked later" disabled={!canDown} onClick={() => onMove(line, 1)}><CaretDownIcon weight="bold" /></Button>
      </span>
      <div className={CELLS}>
        <button type="button" onClick={() => (editCond ? finish() : setEditCond(true))} aria-expanded={editCond} title={`Edit condition: ${text}`}
          className={cn(rowButton, 'flex min-h-[34px] w-full min-w-0 items-center gap-2 border px-2.5 py-1 text-13 hover:border-ink-3 hover:bg-wash aria-expanded:border-ink focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-ink',
            problem && tried ? 'border-live' : 'border-rule-2')}>
          {line.locked && !line.entity && <Badge title="Override: no one’s own settings can change it">override</Badge>}
          {/* long lists of entities or versions: two lines, the rest in the tooltip and the editor */}
          <span className={cn('line-clamp-2 min-w-0 flex-1 break-words', line.paused && 'text-ink-3 line-through')}>
            {text}{groupNames.length > 0 && <span className="text-ink-3"> · groups {groupNames.join(' / ')}</span>}
          </span>
          {line.paused && <Badge>paused</Badge>}
          {problem && !editCond && <Badge kind="warn">incomplete</Badge>}
        </button>
        <div className={cn('flex min-h-[34px] min-w-0 items-center gap-2', line.paused && 'opacity-50')}>
          {simple ? <ValueSelect flag={flag} draft={values} value={served} onChange={setValue} onNewValue={onFlagChanged} /> : <GetsText line={line} flag={flag} draft={values} />}
          {wins && <WinsBadge />}
        </div>
      </div>
      <Button variant="ghost" size="icon" className="text-ink-3" aria-label="Remove" title="Remove rule" onClick={() => onRemove(line.id)}><XIcon /></Button>
      {editCond && (
        <div className="col-[2/-1] max-sm:col-[1/-1]">
          <CondEditor line={line} onChange={onChange} allowRollout={canUsePercent(flag.kind)} served={served}
            topSwitch={!line.entity && line.locked} problem={problem} showErrors={tried} onDone={finish} />
        </div>
      )}
    </div>
  );
});

const fieldFacts = (fields: Meta['fields']): FieldFacts => Object.fromEntries(fields.map((f) => [f.name, { valueType: f.valueType, canSplitBy: f.canSplitBy }]));

const ROLLOUT = '__rollout';
// A condition has no id of its own (the server stores field, op and values only), so its row is keyed by the object:
// an edit hands the key on to the object that replaces it. Nothing extra is stored in the draft or sent.
const condKeys = new WeakMap<Condition, number>();
let lastCondKey = 0;
const condKey = (c: Condition) => {
  let k = condKeys.get(c);
  if (k === undefined) { k = ++lastCondKey; condKeys.set(c, k); }
  return k;
};
const sameRow = (from: Condition, to: Condition) => { condKeys.set(to, condKey(from)); return to; };
/** One condition: attribute, comparison, values, remove. In a narrow window the values go on their own line. */
const COND = 'grid grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,1.6fr)_32px] items-start gap-2 max-sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_32px]';

function CondEditor({ line, onChange, allowRollout, served, topSwitch, problem, showErrors, onDone }: {
  line: Line; onChange: (l: Line) => void; allowRollout: boolean; served: string | null; topSwitch: boolean; problem: string | null; showErrors: boolean; onDone: () => void;
}) {
  const { meta } = useApp();
  const fields = useMemo(() => fieldFacts(meta.fields), [meta.fields]);
  const checkProblem = (c: Condition) => conditionProblem(c, fields);
  const conditions = line.conditions;
  // at an entity's own level, what's always the same there (its dimension and those above it) isn't offered
  const settled = useMemo(() => (line.entity ? settledAt(meta.dimensions, meta.entities, line.entity) : null), [line.entity, meta.dimensions, meta.entities]);
  const set = (i: number, c: Condition) => onChange({ ...line, conditions: conditions.map((x, j) => (j === i ? sameRow(x, c) : x)) });
  const simpleSplit = line.split && line.split.ranges.length === 1 && line.split.ranges[0].from === 0;
  const pct = simpleSplit ? +((line.split!.ranges[0].to) / 100).toFixed(2) : 0;
  const startRollout = (without: Condition[]) => onChange({ ...line, conditions: without, serveVariation: null,
    split: { by: 'device.id', fallbackBy: null, ranges: [{ variation: served ?? CODE_DEFAULT, from: 0, to: 1000 }] } });
  const stopRollout = (extra: Condition[] = []) => onChange({ ...line, split: null, serveVariation: served, conditions: [...conditions, ...extra] });
  const setPct = (raw: string) => {
    const p = Math.max(0, Math.min(100, Number(raw)));
    if (!Number.isFinite(p) || !line.split) return;
    onChange({ ...line, split: { ...line.split, ranges: [{ ...line.split.ranges[0], from: 0, to: Math.round(p * 100) }] } });
  };
  // the attributes' groups, labels and known values come from server/fields.ts, through /meta
  const suggestions = (field: string) => suggestedValues(meta.fields.find((f) => f.name === field), {
    apps: meta.projects.map((p) => p.key), environments: meta.environments.map((e) => e.key), entities: meta.entities });
  // at an entity's own level its own dimension and those above are decided, so checks on them aren't offered there
  // (unless one is set already)
  const attrOptions = (current: string | null, withRollout: boolean) => {
    const groups = groupFields(meta.fields, meta.dimensions).map(([g, fs]) => [g, fs.filter((f) => !settled?.has(f.name) || f.name === current)] as const)
      .filter(([, fs]) => fs.length > 0);
    // a check on an attribute taken off server/fields.ts still shows it
    const other = current && !groups.some(([, fs]) => fs.some((f) => f.name === current)) ? current : null;
    return <>
      {groups.map(([g, fs]) => <optgroup key={g} label={groupLabel(g, meta.dimensions)}>{fs.map((f) => <option key={f.name} value={f.name}>{f.label}</option>)}</optgroup>)}
      {other && <option value={other}>{fieldLabel(other, meta.dimensions)}</option>}
      {withRollout && <optgroup label="Rollout"><option value={ROLLOUT}>% of devices</option></optgroup>}
    </>;
  };
  const remove = (label: string, onClick: () => void) => <Button variant="ghost" size="icon" className="text-ink-3" aria-label={label} title={label} onClick={onClick}><XIcon /></Button>;
  return (
    <div className="mt-2 grid gap-2.5 border border-rule bg-panel p-3">
      {topSwitch && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-grid pb-2.5">
          <NativeSelect size="sm" aria-label="Rule type" value="override" onChange={(e) => onChange({ ...line, locked: e.target.value === 'override' })}>
            <option value="everyone">Rule for everyone</option>
            <option value="override">Override</option>
          </NativeSelect>
          <span className="text-13 text-ink-3">Wins over everyone’s own settings.</span>
        </div>
      )}
      {conditions.length === 0 && !line.split && <p className="m-0 text-13 text-ink-3">Matches {line.entity ? 'every request these settings apply to' : 'every request'}.</p>}
      {conditions.map((c, i) => {
        const type = meta.fields.find((f) => f.name === c.field)?.valueType ?? 'string';
        const single = type === 'semver' || (type === 'int' && !['in', 'not_in'].includes(c.op));
        const bad = showErrors && !!checkProblem(c);
        return (
          <div key={condKey(c)} className={COND}>
            <NativeSelect size="sm" className="w-full" aria-label="Attribute" value={c.field} onChange={(e) => {
              if (e.target.value === ROLLOUT) return startRollout(conditions.filter((_, j) => j !== i));
              const t = meta.fields.find((f) => f.name === e.target.value)!.valueType;
              set(i, { field: e.target.value, op: OPS_BY_TYPE[t][0].op, values: [] });
            }}>{attrOptions(c.field, allowRollout && !line.split)}</NativeSelect>
            <NativeSelect size="sm" className="w-full" aria-label="Comparison" value={c.op} onChange={(e) => set(i, { ...c, op: e.target.value, values: noValueOp(e.target.value) ? [] : c.values })}>
              {OPS_BY_TYPE[type].map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
            </NativeSelect>
            <div className="min-w-0 max-sm:col-span-2">
              {!noValueOp(c.op) && (single
                ? <input aria-label="Value" aria-invalid={bad} placeholder={type === 'semver' ? '5.0.0' : '100'} value={String(c.values?.[0] ?? '')} spellCheck={false}
                    onChange={(e) => set(i, { ...c, values: e.target.value ? [e.target.value] : [] })} className={cn(dense, 'font-mono')} />
                : <ChipInput label="Values" invalid={bad} values={(c.values ?? []).map(String)} suggestions={suggestions(c.field)} placeholder="Type and press Enter" onChange={(v) => set(i, { ...c, values: v })} />)}
            </div>
            {remove('Remove condition', () => onChange({ ...line, conditions: conditions.filter((_, j) => j !== i) }))}
          </div>
        );
      })}
      {line.split && (
        <div className={COND}>
          <NativeSelect size="sm" className="w-full" aria-label="Attribute" value={ROLLOUT} onChange={(e) => {
            if (e.target.value === ROLLOUT) return;
            const t = meta.fields.find((f) => f.name === e.target.value)!.valueType;
            stopRollout([{ field: e.target.value, op: OPS_BY_TYPE[t][0].op, values: [] }]);
          }}>{attrOptions(null, true)}</NativeSelect>
          <span className="flex min-h-8 items-center text-13 text-ink-3">Random, and each device keeps its answer</span>
          <div className="min-w-0 max-sm:col-span-2">
            {simpleSplit
              ? <span className="flex items-center gap-2 text-13 text-ink-2">
                  <input type="number" min={0} max={100} step={1} aria-label="Percent of devices" value={pct} onChange={(e) => setPct(e.target.value)} className={cn(dense, 'w-24 font-mono')} />%
                </span>
              : <span className="flex min-h-8 items-center text-13 text-ink-3">Split across several values</span>}
          </div>
          {remove('Remove rollout', () => stopRollout())}
        </div>
      )}
      {line.split && <GroupNames split={line.split} onChange={(split) => onChange({ ...line, split })} />}
      <div className="flex flex-wrap items-center gap-3 border-t border-grid pt-2.5">
        <Button variant="link" onClick={() => onChange({ ...line, conditions: [...conditions, { field: 'project', op: 'in', values: [] }] })}>+ And</Button>
        <span className="flex-1" />
        {showErrors && problem && <span role="status" className="text-13 text-live">{problem}</span>}
        {/* clicking first blurs the value box, which adds a typed-but-not-entered value, so Done then just works */}
        <Button variant="secondary" onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}

// Names for the groups of a % rule. The app gets the name of its group as metadata.group with the value,
// to add to its own analytics events; the rules for names are in server/checks.ts (GROUP_NAME).
function GroupNames({ split, onChange }: { split: Split; onChange: (s: Split) => void }) {
  const pct = (n: number) => +(n / 100).toFixed(2);
  const covered = split.ranges.reduce((n, r) => n + (r.to - r.from), 0);
  const setRange = (i: number, v: string) => onChange({ ...split, ranges: split.ranges.map((r, j) => {
    if (j !== i) return r;
    const next = { ...r };
    if (v) next.group = v; else delete next.group;
    return next;
  }) });
  const setOutside = (v: string) => {
    const next = { ...split };
    if (v) next.outsideGroup = v; else delete next.outsideGroup;
    onChange(next);
  };
  const row = 'grid grid-cols-[140px_minmax(0,1fr)] items-center gap-2 max-sm:grid-cols-1 max-sm:gap-1';
  return (
    <div className="grid gap-2 border-t border-grid pt-2.5">
      <p className="m-0 text-13 text-ink-3">Group names sent to the app, for your own analytics. Leave them empty to send none.</p>
      {split.ranges.map((r, i) => (
        <label key={r.from} className={row}>
          <span className="text-13 text-ink-2">{split.ranges.length === 1 && r.from === 0 ? `In the ${pct(r.to)}%` : `${pct(r.from)}–${pct(r.to)}%`}</span>
          <input value={r.group ?? ''} placeholder="e.g. checkout_test" spellCheck={false} onChange={(e) => setRange(i, e.target.value)} className={cn(dense, 'font-mono')} />
        </label>
      ))}
      {covered < 10000 && (
        <label className={row}>
          <span className="text-13 text-ink-2">Not in the %</span>
          <input value={split.outsideGroup ?? ''} placeholder="e.g. checkout_control" spellCheck={false} onChange={(e) => setOutside(e.target.value)} className={cn(dense, 'font-mono')} />
        </label>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- preview + publish

/** Attributes the Debug tab has its own box for; the rest of what an app reports is listed below them. */
const OWN_BOX = new Set(['app.version', 'device.id']);

// "Why does this device get this value?" — runs the real evaluator on this page's rules, unpublished edits included.
function DebugTab({ flag, env, draft, dirty, initialEntity, initialProject }: {
  flag: FlagDetail; env: string; draft: Draft; dirty: boolean; initialEntity?: string; initialProject?: string;
}) {
  const { meta } = useApp();
  // opens on the entity and app checked on the Rules tab, if any; otherwise the first of each, and no version or device
  const [entity, setEntity] = useState(initialEntity ?? meta.entities[0]?.key ?? '');
  const [project, setProject] = useState(initialProject ?? (flag.delivery[env] ?? [])[0] ?? meta.projects[0]?.key ?? '');
  const [version, setVersion] = useState('');
  const [device, setDevice] = useState('');
  const [extra, setExtra] = useState<Record<string, string>>({});
  // only what's filled in is sent, as an app leaves out what it doesn't know (an empty version or device is "not sent");
  // the app's platform is filled in the way the real app sends it (server/evaluator.ts contextFor)
  const attrs = useMemo(() => Object.fromEntries(Object.entries({ 'app.version': version, 'device.id': device, ...extra }).filter(([, v]) => v)),
    [version, device, extra]);
  // the result runs on a deferred copy of the rules, so typing never waits for it
  const rules = useMemo<Rules>(() => ({ flag, env, draft }), [flag, env, draft]);
  const tested = useDeferredValue(rules);
  const result = useMemo(() => previewOf(tested, meta, { project, entity: entity || null, attrs }), [tested, meta, project, entity, attrs]);
  const entName = (k: string) => entityLabel(meta.entities, k);
  // what the app reports about itself (server/fields.ts), in the rule editor's order
  const reported = groupFields(meta.fields, meta.dimensions).flatMap(([, fs]) => fs).filter((f) => reportedByApp(f.name, f) && !OWN_BOX.has(f.name));
  const won = result.decidedBy.ruleKey ? tested.draft.lines.find((l) => l.id === result.decidedBy.ruleKey) : undefined;
  const from = sourceText(result.decidedBy, { entity: entityWordsOf(meta.entities, entity), nameOf: (k) => entityIndex(meta.entities).get(k)?.name, project, byDevice: result.reason === 'SPLIT' })
    + (won?.conditions.length ? `: ${whenText(won.conditions, { vocab: vocabOf(meta) })}` : '');
  return (
    <div className="mt-6 grid grid-cols-[300px_minmax(0,1fr)] items-start gap-10 max-lg:grid-cols-1 max-lg:gap-8">
      <section aria-label="Test a device" className="grid gap-4">
        <div>
          <h2 className="m-0 text-15 font-medium tracking-normal text-ink">Test a device</h2>
          <p className="m-0 text-13 text-ink-2">Pick who’s asking. {dirty ? 'Your unpublished changes are included.' : 'Uses the rules on this page.'}</p>
        </div>
        {meta.dimensions.length > 0 && <Field label={listWords(meta.dimensions) ? capital(listWords(meta.dimensions)) : 'Who'}><EntityPicker value={entity} onChange={setEntity} allowNone /></Field>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Service">
            <NativeSelect size="sm" className="w-full" value={project} onChange={(e) => setProject(e.target.value)}>{meta.projects.map((p) => <option key={p.key}>{p.key}</option>)}</NativeSelect>
          </Field>
          <Field label="App version"><input value={version} placeholder="not sent" onChange={(e) => setVersion(e.target.value)} spellCheck={false} className={cn(dense, 'font-mono')} /></Field>
        </div>
        <Field label="Device ID" hint="Decides whether the device is inside a “% of devices” rule.">
          <span className="flex items-center gap-1">
            <input value={device} placeholder="not sent" onChange={(e) => setDevice(e.target.value)} spellCheck={false} className={cn(dense, 'font-mono')} />
            <Button variant="ghost" size="icon" className="text-ink-3" title="Another device" aria-label="Try another device" onClick={() => setDevice(`device-${Math.floor(Math.random() * 1e6)}`)}><ArrowsClockwiseIcon /></Button>
          </span>
        </Field>
        <div className="grid grid-cols-2 gap-3 border-t border-grid pt-4">
          {reported.map(({ name: a, label }) => (
            <Field key={a} label={label}>
              <input value={extra[a] ?? ''} placeholder={a === 'device.platform' ? project : 'not sent'} onChange={(e) => setExtra({ ...extra, [a]: e.target.value })} className={dense} />
            </Field>
          ))}
        </div>
      </section>
      <section aria-label="Result" className="grid min-w-0 gap-5">
        <div className="grid gap-2 border border-rule bg-panel p-5">
          <p className="m-0 text-13 text-ink-2">{entity ? entName(entity) : 'Before sign-in, everyone'} on <span className="font-mono text-ink">{project}</span> gets</p>
          <div className="flex flex-wrap items-center gap-2.5">
            {result.errorCode || result.codeDefault ? <InAppDefault className="px-2 text-15 leading-7" /> : <Val className="px-2 text-15 leading-7">{fmtValue(result.value)}</Val>}
            <ReasonBadge reason={result.errorCode ?? result.reason} />
          </div>
          <p className="m-0 text-13 text-ink-2">{from}</p>
          {result.group && <p className="m-0 text-13 text-ink-3">Group sent to the app: <span className="font-mono text-ink">{result.group}</span></p>}
        </div>
        <div className="grid gap-2">
          <span className={monoLabel}>How it was decided</span>
          <Suspense fallback={<LinesSkeleton className="border-t border-rule" />}><TraceView result={result} showHead={false} /></Suspense>
        </div>
      </section>
    </div>
  );
}

