import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowSquareOutIcon, CopyIcon } from '@phosphor-icons/react';
import { Button } from '@companyflags/ui/components/button';
import { Callout } from '@companyflags/ui/components/callout';
import { BulkBar, ColumnHead, KeyHints, RowCheck, tableHeadClass, tableRowClass, useListKeys, useSelection } from '@companyflags/ui/components/data-table';
import { Drawer, DrawerRow, DrawerSection } from '@companyflags/ui/components/drawer';
import { Input } from '@companyflags/ui/components/input';
import { NativeSelect } from '@companyflags/ui/components/native-select';
import { BAR_CONTROLS, barTextButton, crumbLink, FilterSelect, PageBar } from '@companyflags/ui/components/page-bar';
import { SearchField } from '@companyflags/ui/components/search-field';
import { cn } from '@companyflags/ui/lib/utils';
import {
  above as dimAbove, api, capital, CHOICE_NAME, choiceText, CODE_DEFAULT, entityIndex, entityWordsOf, fmtValue, getsWithoutOwn, levelOf, one, sameAs,
  sourceText, whenText, type AnswerPick, type Dimension, type EntityWords,
} from '../api.ts';
import { Bone, SkeletonRows } from '../loading.tsx';
import { pagerRow } from '../loadingKit.ts';
import { entityFlagsPath, entityHref, entityPath } from '../paths.ts';
import { go, useApp, useVocab } from '../app.ts';
import { downloadCsv } from '../csv.ts';
import { plural } from '../text.ts';
import { Actions, Empty, ErrorList, Field, InAppDefault, Modal, OnOff, Pager, Val, When } from '../ui.tsx';
import { copyText, useAsync, usePersistentState, useServerPage, useSlashFocus } from '../uiKit.ts';
import { entityKeyProblem } from '../../../server/checks.ts';
import { useEnvs } from './envs.ts';
import { useDraftSession } from '../useDraft.ts';
import { roleInfo } from '../../../server/policy.ts';
import { EnvTile } from './flagHeader.tsx';
import { EntityPicker } from './flagParts.tsx';
import { HowItWorks } from '../howItWorks.tsx';
import {
  cellButton, followsFrom, isMine, kindName, MD, selectedRow, tag, toTop, typeName, useLast,
  type EntityFlag, type EntityView, type Level, type Who,
} from './entityKit.ts';

/* The parts of an entity's page (Entities.tsx): its header, its flags, one flag's drawer with "why it gets this", its
   app link, and the dialog that adds an entity or edits one (its name, and the entity above it). */

/** A load error and the way out: Try again (it says so while the list reloads). `line` keeps it to one line over old rows. */
export function LoadError({ children, busy, onRetry, line, className }: { children: ReactNode; busy: boolean; onRetry: () => void; line?: boolean; className?: string }) {
  return (
    <Callout tone="error" role="alert" className={cn('flex items-center gap-x-4 gap-y-2', !line && 'flex-wrap', className)}>
      <span className={cn('min-w-0 flex-1', line ? 'truncate' : '[overflow-wrap:anywhere]')}>{children}</span>
      <span className={BAR_CONTROLS}><Button variant="secondary" disabled={busy} onClick={onRetry}>{busy ? 'Trying…' : 'Try again'}</Button></span>
    </Callout>
  );
}

/** "2 in development, 1 in production" (flags with own settings, per environment), or with none "Same as everyone"
 *  ("Same as Acme" for an entity under Acme). */
export function OwnCounts({ counts, who }: { counts: Record<string, number>; who: EntityWords }) {
  const { meta } = useApp();
  const { envName } = useEnvs();
  const per = meta.environments.map((e) => ({ env: e.key, n: counts[e.key] ?? 0 }));
  if (per.every((p) => p.n === 0)) return <span className="text-13 text-ink-3">{sameAs(who)}</span>;
  return (
    <span className="text-13 text-ink-2" title={per.map((p) => `${plural(p.n, 'flag')} in ${envName(p.env).toLowerCase()}`).join(', ')}>
      {per.map((p, i) => (
        <Fragment key={p.env}>
          {i > 0 && <span className="text-ink-3">, </span>}
          <span className={p.n ? 'text-ink' : 'text-ink-3'}>{p.n.toLocaleString()} in {envName(p.env).toLowerCase()}</span>
        </Fragment>
      ))}
    </span>
  );
}

/* ---------------------------------------------------------------- add or edit */

/** Adds an entity to `dimension`, or edits `entity`: its name, and the entity above it (in the dimension right above).
 *  Moving one changes what it, and every entity under it, gets: where an environment needs approval only admins may. */
export function EntityDialog({ dimension, entity, onClose }: { dimension: Dimension; entity?: Who; onClose: () => void }) {
  const { toast, reload, meta } = useApp();
  // a failed refresh after a save says so (the lists would otherwise look as if nothing changed)
  const reloadOrSay = () => { reload().catch((e: Error) => toast(`Saved, but the console couldn’t refresh: ${e.message}`, 'err')); };
  const [key, setKey] = useState(entity?.key ?? '');
  const [name, setName] = useState(entity?.name ?? '');
  const [parent, setParent] = useState(entity?.parent ?? '');
  const { busy, error, run } = useAsync();
  const keyError = !entity && key ? entityKeyProblem(key) : null;
  const up = dimAbove(meta.dimensions, dimension.key);
  const byKey = entityIndex(meta.entities);
  const parentChanged = (entity?.parent ?? '') !== parent;
  const save = async () => {
    const body = { name, ...(up ? { parent: parent || null } : {}) };
    const r = await run(() => entity ? api('PUT', entityPath(dimension.key, entity.key), body) : api('POST', `/dimensions/${encodeURIComponent(dimension.key)}`, { key, ...body }));
    if (!r) return;
    reloadOrSay();
    onClose();
    const parentName = byKey.get(parent)?.name;
    if (entity && parentChanged) {
      toast(parent ? `${name} is now under ${parentName}. It follows ${parentName}’s settings where it has none of its own` : `${name} is no longer under ${byKey.get(entity.parent ?? '')?.name ?? 'another'}`);
    } else if (entity) {
      // a rename is reversible: no confirmation, an Undo instead
      const before = entity.name;
      const undo = () => api('PUT', entityPath(dimension.key, entity.key), { name: before })
        .then(() => { toast(`Renamed ${name} back to ${before}`); reloadOrSay(); })
        .catch((e) => toast(`Couldn’t rename ${name} back to ${before}: ${e.message}`, 'err', { label: 'Retry', onClick: undo }));
      toast(`Renamed ${before} to ${name}`, 'ok', { label: 'Undo', onClick: undo });
    } else {
      toast(parent ? `Added ${name} under ${parentName}. It follows ${parentName}’s settings until it has its own` : `Added ${name}. It ${getsWithoutOwn(null)} on every flag`);
      go(entityHref(dimension.key, key).slice(2));
    }
  };
  return (
    <Modal title={entity ? `Edit ${entity.name}` : `Add ${one(dimension)}`} onClose={onClose} footer={
      <Actions>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button disabled={busy || !name.trim() || !key || !!keyError || (!!entity && name === entity.name && !parentChanged)} onClick={save}>
          {busy ? 'Saving…' : entity ? 'Save' : `Add ${one(dimension)}`}
        </Button>
      </Actions>
    }>
      <Field label="Name" required>
        <Input data-autofocus value={name} placeholder="Contoso"
          onChange={(e) => { setName(e.target.value); if (!entity) setKey(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')); }} />
      </Field>
      <Field label="Key" required
        hint={keyError ? <span className="text-live">{keyError}</span> : entity ? 'Rules and app links use this key, so it can’t be changed.'
          : 'Rules and app links use this key. It can’t be changed later, and no two entries of any dimension share one.'}>
        <Input className="font-mono text-13" value={key} disabled={!!entity} onChange={(e) => setKey(e.target.value)} aria-invalid={!!keyError} />
      </Field>
      {up && (
        <Field label={capital(up.singular)} hint={`Where it has no settings of its own on a flag, it gets what its ${one(up)} gets.${entity ? ' Moving it changes what it, and everything under it, gets.' : ''}`}>
          <EntityPicker value={parent} onChange={setParent} dimension={up.key} allowNone placeholder="None" className="h-[34px]" />
        </Field>
      )}
      <ErrorList error={error} />
    </Modal>
  );
}

/* ---------------------------------------------------------------- one entity's flags */

/** checkbox, flag, status, what the entity gets, source */
const FLAG_COLS = 'grid grid-cols-[28px_minmax(0,1.3fr)_84px_minmax(0,1.5fr)_minmax(0,1fr)] max-md:grid-cols-[28px_minmax(0,1fr)_72px]';
const seg = encodeURIComponent;

/**
 * One entity's flags (the Flags tab): the table with its search, paging and selection, the drawer for one flag, and
 * "Use <parent>’s again". It's mounted only on that tab, so the tab of the entities under it never loads the list, and
 * its load errors stay in here instead of replacing the page. `onChanged`: after a change, so the header's counts follow.
 */
export function EntityFlags({ entity, env, keysEnabled, onChanged }: { entity: Who; env: string; keysEnabled: boolean; onChanged: () => void }) {
  const { meta, revisionTick, toast, ask } = useApp();
  const vocab = useVocab();
  const { envName, isProtected } = useEnvs();
  const drafts = useDraftSession(env);
  const [show, setShow] = usePersistentState<'all' | 'own'>('entity.own', 'all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [tries, setTries] = useState(0);   // Try again reloads the page of flags
  const retry = () => setTries((t) => t + 1);
  const search = useRef<HTMLInputElement>(null);
  const n = q.trim().toLowerCase();
  const onlyOwn = show === 'own';
  // one page of this entity's flags, searched and filtered on the server
  const paging = useServerPage<EntityView>(
    (page) => entityFlagsPath(entity.dimension, entity.key, env, onlyOwn, n, page),
    `${n}|${onlyOwn}|${env}|${entity.key}`, `${revisionTick}:${tries}`);
  const data = paging.data;
  const rows = data?.rows ?? [];
  const sel = useSelection(rows.map((r) => r.key));
  const currentFlag = rows.find((r) => r.key === open) ?? null;   // the drawer's flag (it closes if the flag leaves the page)
  const shownFlag = useLast(currentFlag);
  const keys = useListKeys({
    count: rows.length,
    onOpen: (i) => setOpen(rows[i].key),
    onToggle: (i) => sel.toggle(rows[i].key),
    onClear: () => { if (!currentFlag) sel.clear(); },
    enabled: keysEnabled && !currentFlag,
  });
  useSlashFocus(search, keysEnabled && !currentFlag);

  const who = entityWordsOf(meta.entities, entity.key) ?? { key: entity.key, name: entity.name, above: [] };
  const where = envName(data?.environment ?? env).toLowerCase();
  // a reload that failed: the old rows stay, under a line that says they may be out of date
  const stale = data && paging.error ? `Couldn’t load the latest flags for ${entity.name} in ${envName(env).toLowerCase()}: ${paging.error}` : null;
  const filtered = !!(n || onlyOwn);
  const reset = () => { setQ(''); setShow('all'); };
  const chosen = rows.filter((r) => sel.isSelected(r.key));
  const turn = (p: number) => { paging.go(p); keys.setActive(-1); toTop(search.current); };
  const openRow = (i: number, key: string) => { keys.setActive(i); setOpen(key); };
  const exportCsv = () => {
    const list = chosen.length ? chosen : rows;
    downloadCsv(`${entity.key}-${env}-flags.csv`, ['flag', 'status', 'variant', 'value', 'source', 'own_settings'], list.map((f) => {
      const g = f.answer.gets;
      const v = f.variations.find((x) => x.key === g.variant);
      return [f.key, g.section === 'not_sent' ? 'not sent' : g.section === 'off' ? 'off' : 'on', g.variant === CODE_DEFAULT ? '' : g.variant,
        g.variant === CODE_DEFAULT ? 'in-app default' : v ? fmtValue(v.value) : '', sourceText(g, { entity: who, nameOf: vocab.nameOf }), f.hasOwn ? 'yes' : 'no'];
    }));
    toast(`Exported ${plural(list.length, 'flag')} for ${entity.name} in ${where}`);
  };

  // "Use Acme's again" (Google Admin's "Inherit"): its own settings on these flags are removed, so it gets what the
  // entity above it gets again. One change; where the environment needs approval, a request with a reason.
  const parentName = who.above[0]?.name ?? null;
  const restoreParentSettings = async (flags: EntityFlag[]) => {
    const own = flags.filter((f) => f.hasOwn && f.ownVersion !== null);
    if (!own.length || !parentName) return;
    const needsReview = isProtected(env);
    const what = own.length === 1 ? own[0].key : plural(own.length, 'flag');
    const r = await ask({
      title: `Use ${parentName}’s settings for ${what} again?`,
      body: <p>{entity.name}’s own settings on {own.length === 1 ? 'this flag' : 'these flags'} in {where} are removed, so it gets what {parentName} gets.{needsReview ? ' This environment needs approval, so it goes out once a reviewer approves.' : ''}</p>,
      reason: needsReview ? { label: 'Why? (required)', placeholder: 'What this change is for; reviewers see it' } : undefined,
      actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'go', label: needsReview ? 'Send for review' : `Use ${parentName}’s`, tone: 'primary', needsReason: needsReview }],
    });
    if (r.action !== 'go') return;
    try {
      const res = await api<{ applied: boolean; changeSetId?: number }>('POST', `/environments/${seg(env)}/publish`, {
        items: own.map((f) => ({ flag: f.key, entity: entity.key, expectedVersion: f.ownVersion, layer: null })), reason: r.reason || undefined });
      // a draft of these flags made in this browser was based on the settings just removed: it's stale now
      if (res.applied) void drafts.noteChanged(own.map((f) => f.key));
      sel.clear();
      setOpen(null);
      retry();
      onChanged();
      toast(res.applied ? `${entity.name} gets ${parentName}’s settings for ${what} again` : `Sent for review: request #${res.changeSetId}`,
        'ok', res.applied ? undefined : { label: 'Open', onClick: () => go(`approvals/${res.changeSetId}`) });
    } catch (e) {
      toast(`Couldn’t change ${what}: ${(e as Error).message}`, 'err');
    }
  };

  return (
    <>
      {/* search and the filter stick over the table; the environment is chosen in the header */}
      <PageBar className="border-t">
        <SearchField ref={search} className="w-[240px] max-md:w-auto max-md:flex-1 max-md:basis-full" placeholder="Search  /" value={q}
          onChange={(e) => setQ(e.target.value)} aria-label="Search flags" />
        <FilterSelect label="Show" value={show} onChange={setShow} options={[['all', 'All flags'], ['own', 'Own settings only']]} />
        {filtered && <button type="button" onClick={reset} className={barTextButton}>Reset</button>}
        <span className="ml-auto text-13 text-ink-3 max-md:hidden">
          {data ? <>{plural(data.all, 'flag')} in {where}{data.withOwn ? <>, {data.withOwn.toLocaleString()} with own settings</> : null}</> : null}
        </span>
      </PageBar>

      {stale && <LoadError line className="mx-6 mt-3 max-sm:mx-4" busy={paging.loading} onRetry={retry}><span title={stale}>{stale}</span></LoadError>}
      <div role="table" aria-label={`Flags for ${entity.name}`} aria-busy={paging.loading} className={cn('flex-1', paging.loading && 'opacity-70')}>
        <div role="row" className={cn(FLAG_COLS, tableHeadClass)}>
          <RowCheck head checked={sel.all} indeterminate={sel.some} onChange={sel.toggleAll} label="Select all flags on this page" />
          <span role="columnheader">Flag</span>
          <span role="columnheader">Status</span>
          <span role="columnheader" className={cn(MD, 'truncate')}>What {entity.name} gets</span>
          <ColumnHead className={MD} label="Source" help={`Where the answer comes from: ${entity.name}’s own settings, those of one above it, a rule for everyone, the default, or the code’s own default when the flag is off.`} />
        </div>
        {!data ? (paging.error
            ? <LoadError className="m-6 max-sm:m-4" busy={paging.loading} onRetry={retry}>Couldn’t load the flags for {entity.name}: {paging.error}</LoadError>
            : <SkeletonRows cols={FLAG_COLS} cells={['', '', '', MD, MD]} rowClass="min-h-14 max-md:min-h-28" />)
          : rows.length === 0 ? (
            <div className="px-6 py-10 max-sm:px-4">
              <Empty action={filtered ? <Button variant="secondary" onClick={reset}>{onlyOwn ? 'Show all flags' : 'Clear search'}</Button> : undefined}>
                {onlyOwn ? `${entity.name} has no own settings${n ? ' matching this search' : ''} in ${where}.` : n ? `No flag matches “${q.trim()}”.` : 'No flags yet.'}
              </Empty>
            </div>
          ) : rows.map((f, i) => {
            const from = f.hasOwn ? null : followsFrom(f, entity.key);
            return (
              // a click anywhere on the row opens it; the flag's key is the button keyboard and screen-reader users open it with
              <div key={f.key} role="row" data-row-index={i} data-active={keys.active === i} data-selected={sel.isSelected(f.key)}
                onClick={() => openRow(i, f.key)} className={cn(FLAG_COLS, tableRowClass, selectedRow, 'cursor-default gap-y-1.5')}>
                <RowCheck checked={sel.isSelected(f.key)} onChange={() => sel.toggle(f.key)} label={`Select ${f.key}`} />
                <span role="cell" className="min-w-0">
                  <button type="button" onClick={(e) => { e.stopPropagation(); openRow(i, f.key); }} className={cn(cellButton, 'font-mono text-13 font-medium')}>{f.key}</button>
                  {f.description && <span className="block truncate text-ink-3">{f.description}</span>}
                </span>
                <span role="cell">
                  <Status flag={f} />
                  {f.hasOwn ? <span className="block text-xs font-medium text-ink-2" title={`${entity.name} has its own settings for this flag in ${where}`}>Own settings</span>
                    : from?.name && <span className="block text-xs text-ink-3" title={`${entity.name} has no settings of its own here: it follows ${from.name}`}>From {from.name}</span>}
                </span>
                {/* the answer's lines span both columns, so each value sits on the same line as its source */}
                <span role="cell" aria-colspan={2}
                  className="col-span-2 grid grid-cols-subgrid items-baseline gap-y-1 max-md:col-start-2 max-md:grid-cols-1 max-md:gap-y-0.5">
                  {answerLines(f, who, vocab).map((l, j) => (
                    <Fragment key={j}>
                      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-ink-2 [overflow-wrap:anywhere]">{l.what}</span>
                      <span className="min-w-0 max-md:mb-1">{l.source}</span>
                    </Fragment>
                  ))}
                </span>
              </div>
            );
          })}
      </div>

      <div className={cn('flex flex-wrap items-center gap-4 border-t border-rule px-6 max-sm:px-4', pagerRow)}>
        <KeyHints className="max-md:hidden" />
        <span className="flex-1" />
        {data && <Pager page={paging.page} size={paging.size} matched={data.matched} noun="flags" onPage={turn} />}
      </div>

      <BulkBar count={sel.count} onClear={sel.clear}>
        {parentName && chosen.some((f) => f.hasOwn) && (
          <Button variant="outline" onClick={() => void restoreParentSettings(chosen)}>Use {parentName}’s for {plural(chosen.filter((f) => f.hasOwn).length, 'flag')}</Button>
        )}
        <Button variant="outline" onClick={exportCsv}>Export {plural(sel.count, 'flag')} as CSV</Button>
      </BulkBar>

      <FlagDrawer open={!!currentFlag} flag={shownFlag} entity={entity} who={who} env={env} onClose={() => setOpen(null)}
        onUseParent={parentName ? (f) => void restoreParentSettings([f]) : undefined} />
    </>
  );
}

/** One flag from this entity's point of view: the whole answer, every variant, and the way to the flag's page. */
function FlagDrawer({ open, flag, entity, who, env, onClose, onUseParent }: {
  open: boolean; flag: EntityFlag | null; entity: Who; who: EntityWords; env: string; onClose: () => void;
  onUseParent?: (f: EntityFlag) => void;
}) {
  const { toast } = useApp();
  const vocab = useVocab();
  const { envName } = useEnvs();
  const where = envName(env).toLowerCase();
  const parentName = who.above[0]?.name;
  return (
    <Drawer open={open} onClose={onClose} title={<span className="font-mono">{flag?.key}</span>}
      subtitle={flag ? `${kindName(flag.kind)} · ${typeName(flag.valueType)}${flag.owner ? ` · ${flag.owner}` : ''}` : undefined}
      footer={flag && <>
        <Button onClick={() => { onClose(); go(`flag/${flag.key}/${env}`); }}>Open flag <ArrowSquareOutIcon aria-hidden className="size-3.5" /></Button>
        {onUseParent && flag.hasOwn && parentName && <Button variant="secondary" onClick={() => onUseParent(flag)}>Use {parentName}’s again</Button>}
        <Button variant="secondary" onClick={() => void copyText(flag.key, flag.key, toast)}>Copy key</Button>
      </>}>
      {flag && <>
        {flag.description && <p className="m-0 mb-5 text-sm text-ink-2 [overflow-wrap:anywhere]">{flag.description}</p>}
        <DrawerSection title={`What ${entity.name} gets in ${where}`}>
          {answerLines(flag, who, vocab).map((l, i) => (
            <div key={i} className="grid gap-1 border-b border-grid py-2.5 text-13 last:border-b-0">
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-ink-2 [overflow-wrap:anywhere]">{l.what}</span>
              <span>{l.source}</span>
            </div>
          ))}
        </DrawerSection>
        <DrawerSection title={`Why ${entity.name} gets this`}>
          <WhyChain flag={flag} who={who} env={env} />
        </DrawerSection>
        <DrawerSection title="Flag">
          <DrawerRow label="Status"><span className="inline-flex items-center gap-1.5"><OnOff on={flag.enabled} /><span className="text-ink-3">in {where}</span></span></DrawerRow>
          <DrawerRow label="Own settings">{flag.hasOwn ? `${entity.name} has its own settings here`
            : <span className="text-ink-3">None: it {getsWithoutOwn(who)}</span>}</DrawerRow>
          <DrawerRow label="Services">{flag.delivery.join(', ') || <span className="text-ink-3">none in {where}</span>}</DrawerRow>
          <DrawerRow label="Variants">
            <span className="flex flex-wrap gap-1.5">
              {flag.variations.map((v) => <FlagValue key={v.key} flag={flag} k={v.key} />)}
            </span>
          </DrawerRow>
        </DrawerSection>
      </>}
    </Drawer>
  );
}

/**
 * Why an entity gets what it gets (like Azure's "effective access"): the levels of its chain, in order, and the one that
 * decided: overrides → its own settings → those of each entity above it → everyone's. Each level links to where it's
 * edited. The order and the skipping come from the server (levels); this only draws them.
 */
function WhyChain({ flag, who, env }: { flag: EntityFlag; who: EntityWords; env: string }) {
  const { meta } = useApp();
  const g = flag.answer.gets;
  // overrides for everyone are a level only where the flag has some
  const levels = flag.levels.filter((l) => l.who !== 'override' || l.set);
  if (g.section === 'off' || g.section === 'not_sent') {
    return <p className="m-0 py-2 text-13 text-ink-3">{g.section === 'off' ? 'The flag is off, so nothing decides: every app uses the default in its own code.' : 'This flag isn’t in any service here.'}</p>;
  }
  const decider = levelOf(g.section);
  const decides = (l: Level) => l.who === decider && (l.who !== 'entity' || l.key === g.owner);
  const value = (k: string | null) => (!k || k === CODE_DEFAULT ? <InAppDefault /> : <FlagValue flag={flag} k={k} />);
  const nameOf = (k: string | null) => (k ? (k === who.key ? who.name : entityIndex(meta.entities).get(k)?.name ?? k) : '');
  // the entity a level belongs to, as the words name it (its own words: its name and those above it)
  const wordsOf = (l: Level): EntityWords => (l.key && l.key !== who.key ? entityWordsOf(meta.entities, l.key) ?? { key: l.key, name: l.name ?? l.key, above: [] } : who);
  const describe = (l: Level): ReactNode => {
    const by = nameOf(l.skippedBy);
    if (l.skipped) return l.who === 'everyone' ? `Only overrides apply: ${by} uses ${CHOICE_NAME.customer_only}.` : `Skipped: ${by} uses ${CHOICE_NAME.customer_only}.`;
    if (l.who === 'override') return `${plural(l.rules, 'override')}: own settings can’t change ${l.rules === 1 ? 'it' : 'them'}`;
    if (l.who === 'everyone') {
      const def = l.defaultWins === false ? null : <>the default {value(l.defaultVariant)}</>;
      return l.rules ? <>{plural(l.rules, 'rule')}{def && <>, then {def}</>}</> : def ? <>{'The default '}{value(l.defaultVariant)}</> : 'No rules';
    }
    if (!l.set) return `Nothing set: ${getsWithoutOwn(wordsOf(l))}.`;
    const mode = l.inherit ? <span title={choiceText(l.inherit, wordsOf(l))}>{CHOICE_NAME[l.inherit]}</span> : null;
    return <>{l.rules ? plural(l.rules, 'rule') : 'No rules'}{mode && <> · {mode}</>}{l.defaultVariant ? <>, default {value(l.defaultVariant)}</> : null}</>;
  };
  return (
    <ol className="m-0 grid list-none gap-0 p-0">
      {levels.map((l, i) => {
        const deciding = decides(l);
        const name = l.who === 'everyone' ? 'Everyone' : l.who === 'override' ? 'Overrides for everyone' : l.name;
        const href = !l.key || l.key === who.key || !l.dimension ? `#/flag/${flag.key}/${env}` : entityHref(l.dimension, l.key, env);
        const dim = l.dimension ? meta.dimensions.find((d) => d.key === l.dimension) : undefined;
        return (
          <li key={`${l.who}-${l.key ?? ''}`} className={cn('grid grid-cols-[20px_minmax(0,1fr)] gap-x-2 border-b border-grid py-2.5 text-13 last:border-b-0', l.skipped && 'opacity-60')}>
            <span className={cn('font-mono text-11 leading-5', deciding ? 'text-ink' : 'text-ink-3')}>{i + 1}</span>
            <span className="grid min-w-0 gap-0.5">
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <a href={href} className={cn('font-medium', deciding ? 'text-ink' : 'text-ink-2')}>{name}</a>
                {l.who === 'entity' && l.key !== who.key && dim && <span className="text-ink-3">its {one(dim)}</span>}
                {deciding && <span className="inline-flex items-baseline gap-1.5 text-ink"><span className="text-ink-3">decides →</span>{value(g.variant)}</span>}
              </span>
              <span className="min-w-0 text-ink-3 [overflow-wrap:anywhere]">{describe(l)}</span>
            </span>
          </li>
        );
      })}
      {flag.answer.exceptions.length > 0 && <li className="py-2 text-xs text-ink-3">Some requests get other values; they’re listed above.</li>}
    </ol>
  );
}

/* ---------------------------------------------------------------- the answer */

/** On, Off, or Not sent (in no service), as this entity sees the flag. */
function Status({ flag }: { flag: EntityFlag }) {
  if (flag.answer.gets.section === 'not_sent') {
    return <span className="inline-flex items-center gap-1.5 text-13 font-medium text-ink-3"><span aria-hidden className="size-[7px] border-[1.5px] border-ink-3" />Not sent</span>;
  }
  return <OnOff on={flag.answer.gets.section !== 'off'} />;
}

/** A variant's value, mono in a box; its name beside it when the name says something the value doesn't. */
function FlagValue({ flag, k, main }: { flag: Pick<EntityFlag, 'valueType' | 'variations'>; k: string; main?: boolean }) {
  if (k === CODE_DEFAULT) return <InAppDefault />;
  const v = flag.variations.find((x) => x.key === k);
  if (!v) return <span className="font-mono text-ink">{k}</span>;
  const text = fmtValue(v.value);
  return (
    <span className="inline-flex min-w-0 max-w-full items-baseline gap-2">
      <Val title={text} className={cn('min-w-0', main ? 'font-medium' : 'text-ink-2')}>{text}</Val>
      {flag.valueType !== 'bool' && !v.own && text !== k && <span className={tag}>{k}</span>}
    </span>
  );
}

/** The answer's lines: what the entity gets, the exceptions that depend on the request, and what everyone else gets. */
function answerLines(flag: EntityFlag, who: EntityWords, vocab: ReturnType<typeof useVocab>): { what: ReactNode; source: ReactNode }[] {
  const { gets, exceptions } = flag.answer;
  const source = (p: AnswerPick, text = sourceText(p, { entity: who, nameOf: vocab.nameOf })) => (
    <span className={cn('text-13', isMine(p, who) ? 'font-medium text-ink' : 'text-ink-3')}>{text}</span>
  );
  if (gets.section === 'not_sent') return [{ what: <span className="text-ink-3">Nothing</span>, source: <span className="text-13 text-ink-3">In no service</span> }];
  if (gets.section === 'off') return [{ what: <InAppDefault />, source: source(gets, 'The flag is off') }];
  return [
    { what: <FlagValue flag={flag} k={gets.variant} main />, source: source(gets) },
    ...exceptions.map((e) => ({
      what: <><span><span className="text-ink-3">when</span> {whenText(e.when, { percent: e.percent, vocab })} <span className="text-ink-3">→</span></span><FlagValue flag={flag} k={e.variant} /></>,
      source: source(e),
    })),
    ...(flag.everyone.variant !== gets.variant
      ? [{ what: <><span className="text-ink-3">Everyone else</span><FlagValue flag={flag} k={flag.everyone.variant} /></>, source: source(flag.everyone, sourceText(flag.everyone)) }]
      : []),
  ];
}

/* ---------------------------------------------------------------- the header */

/**
 * An entity's page header, the same shape as a flag's: the way back up its chain (its dimension's page, then each entity
 * above it), the name with its key, one sentence of facts, and the environments as places (each with its own-settings
 * count). `countsFailed`: the counts couldn't be loaded, so the places say so instead of waiting ("…") forever.
 */
export function EntityHeader({ entity, dimension, above, under, childDimension, env, view, counts, countsFailed, addedAt, onEdit }: {
  entity: Who; dimension: Dimension; above: Who[]; under: Who[]; childDimension: Dimension | null; env: string; view?: string;
  counts?: Record<string, number>; countsFailed?: boolean; addedAt?: string; onEdit?: () => void;
}) {
  const { meta, toast } = useApp();
  const { envName } = useEnvs();
  const [linkOpen, setLinkOpen] = useState(false);
  // viewers can't see app links (the server refuses them: only roles that change things may), so they aren't offered one
  const canSeeLink = roleInfo(meta.me.role).changes;
  const per = meta.environments.map((e) => ({ env: e.key, n: counts?.[e.key] ?? 0 }));
  const withOwn = per.filter((p) => p.n > 0);
  const listed = withOwn.map((p) => `${plural(p.n, 'flag')} in ${envName(p.env).toLowerCase()}`);
  const who = entityWordsOf(meta.entities, entity.key) ?? { key: entity.key, name: entity.name, above: [] };
  const parent = above[0];
  const sentence = !counts ? null : withOwn.length === 0
    ? `No own settings yet: ${getsWithoutOwn(who)}.`
    : `Has its own settings for ${listed.length > 1 ? `${listed.slice(0, -1).join(', ')} and ${listed[listed.length - 1]}` : listed[0]}.`;
  const chain = [...above].reverse();
  return (
    <header className="px-6 pt-4 pb-5 max-sm:px-4">
      {/* up the chain, as the page bar's crumbs: the dimension's page, then each entity above this one, the top first */}
      <nav aria-label="Up the chain" className="-ml-1 flex min-w-0 flex-wrap items-center gap-x-1 text-13 text-ink-3">
        <a href={`#/dimensions/${seg(dimension.key)}`} className={crumbLink}>
          {capital(dimension.plural)}
        </a>
        {chain.map((a) => (
          <Fragment key={a.key}>
            <span aria-hidden className="text-ink-4">/</span>
            <a href={entityHref(a.dimension, a.key, env)} className="truncate text-ink-3 no-underline hover:text-ink hover:no-underline">{a.name}</a>
          </Fragment>
        ))}
      </nav>
      <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="m-0 min-w-0 truncate text-22 leading-8 font-semibold tracking-[-0.01em] text-ink">{entity.name}</h1>
        <span className="inline-flex min-w-0 items-center gap-0.5 font-mono text-13 text-ink-3">
          <span className="truncate">{entity.key}</span>
          <button type="button" onClick={() => void copyText(entity.key, `key ${entity.key}`, toast)} aria-label={`Copy key ${entity.key}`} title="Copy the key rules and app links use"
            className="inline-grid size-7 shrink-0 cursor-default place-items-center border-0 bg-transparent text-ink-3 outline-none transition-colors duration-150 hover:bg-wash hover:text-ink focus-visible:outline-1 focus-visible:outline-ink">
            <CopyIcon aria-hidden className="size-3.5" />
          </button>
        </span>
        <span className="text-13 text-ink-3">{capital(dimension.singular)}</span>
        <span className="flex-1" />
        <span className={cn(BAR_CONTROLS, 'flex gap-2')}>
          <HowItWorks />
          {canSeeLink && <Button variant="secondary" onClick={() => setLinkOpen(true)}>App link</Button>}
          {/* there from the start, so the buttons before it don't move when the entity's row arrives */}
          <Button variant="secondary" disabled={!onEdit} onClick={onEdit}>Edit</Button>
        </span>
      </div>
      {canSeeLink && <AppLink open={linkOpen} onClose={() => setLinkOpen(false)} entity={entity} env={env} />}
      {(parent || (childDimension && under.length > 0)) && (
        <p className="m-0 mt-1 max-w-[72ch] text-13 leading-6 text-ink-2">
          {parent && <>Under <a href={entityHref(parent.dimension, parent.key, env)}>{parent.name}</a>: where it has no settings of its own, it gets what {parent.name} gets. </>}
          {childDimension && under.length > 0 && <>
            {capital(childDimension.plural)}: {under.slice(0, 8).map((b, i) => <span key={b.key}>{i > 0 && ', '}<a href={entityHref(b.dimension, b.key, env)}>{b.name}</a></span>)}
            {under.length > 8 && <> and {under.length - 8} more</>}. They follow {entity.name}’s settings where they have none of their own.
          </>}
        </p>
      )}
      {(sentence || addedAt) ? (
        <p className="m-0 mt-1 max-w-[72ch] text-13 leading-6 text-ink-3">
          {sentence}{addedAt && <> Added <When iso={addedAt} className="text-ink-3" />.</>}
        </p>
      ) : !countsFailed && (
        <p aria-hidden className="m-0 mt-1 grid h-6 content-center gap-3.5 max-sm:h-12">
          <Bone className="w-96 max-w-full" /><Bone className="hidden w-48 max-sm:inline-block" />
        </p>
      )}
      <div role="group" aria-label="Environments" className="mt-4 flex flex-wrap gap-2 max-sm:flex-col">
        {meta.environments.map((e) => {
          const n = counts?.[e.key] ?? 0;
          return (
            <EnvTile key={e.key} name={envName(e.key)} current={e.key === env} href={entityHref(entity.dimension, entity.key, e.key, view)}>
              <span className={n ? 'text-ink-2' : 'text-ink-3'}>{!counts ? (countsFailed ? '—' : '…') : n ? `Own settings for ${plural(n, 'flag')}` : 'No own settings'}</span>
            </EnvTile>
          );
        })}
      </div>
    </header>
  );
}

/** Where this entity's apps read their flags: one secret link per environment, given to the app at login, as the app
 *  file's address and as a token for OpenFeature's OFREP providers (one per app service). */
function AppLink({ open, onClose, entity, env }: { open: boolean; onClose: () => void; entity: Who; env: string }) {
  const { ask, toast, meta } = useApp();
  const { envName } = useEnvs();
  const clientApps = meta.services.filter((p) => p.kind === 'client').map((p) => p.key);
  const [chosen, setApp] = useState<string | null>(null);
  const app = chosen && clientApps.includes(chosen) ? chosen : clientApps[0] ?? null;
  // the answer is kept with the entity, environment and app it's for, so another one's link (or error) never shows
  // here; each time the drawer opens it's asked for again
  const asked = `${entity.key}\n${env}\n${app}`;
  type Link = { path?: string; token?: string };
  // what this server serves (server/plugin.ts): the token is for OFREP, the address for CDN files
  const ofrep = meta.plugins.includes('ofrep');
  const files = meta.plugins.includes('cdn-files');
  const [got, setGot] = useState<{ asked: string; link: Link | null; error: string | null } | null>(null);
  const link = got?.asked === asked ? got.link : null;
  const error = got?.asked === asked ? got.error : null;
  const [busy, setBusy] = useState(false);
  const linkPath = `${entityPath(entity.dimension, entity.key)}/link?environment=${seg(env)}${app ? `&service=${seg(app)}` : ''}`;
  useEffect(() => {
    if (!open || !app) return;
    let live = true;
    api<Link>('GET', linkPath)
      .then((r) => { if (live) setGot({ asked, link: r, error: null }); }, (e: Error) => { if (live) setGot({ asked, link: null, error: e.message }); });
    return () => { live = false; };
  }, [open, asked, linkPath, app]);
  const url = link?.path ? `${location.origin}${link.path}` : '';
  const replace = async () => {
    const r = await ask({ title: `Replace ${entity.name}’s app link?`,
      body: <><p>The current link and its token stop working in every environment within a minute. Apps keep their saved flags until they log in again and get the new link from your backend. The links of the entries under {entity.name} stay as they are.</p></>,
      actions: [{ id: 'keep', label: 'Keep the link' }, { id: 'replace', label: 'Replace link', tone: 'danger' }] });
    if (r.action !== 'replace') return;
    setBusy(true);
    try {
      await api('POST', `${entityPath(entity.dimension, entity.key)}/link/rotate?environment=${seg(env)}`);
      setGot({ asked, link: await api<Link>('GET', linkPath), error: null });
      toast(`Replaced ${entity.name}’s app link`);
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  };
  return (
    <Drawer open={open} onClose={onClose} title="App link" subtitle={`${entity.name} · ${envName(env)}`}
      footer={<>
        {files && <Button disabled={!url} onClick={() => void copyText(url, 'the app link', toast)}>Copy link</Button>}
        {ofrep && <Button variant={files ? 'secondary' : undefined} disabled={!link?.token} onClick={() => void copyText(link?.token ?? '', 'the OpenFeature token', toast)}>Copy token</Button>}
        <Button variant="secondary" disabled={!link || busy} onClick={replace}>{busy ? 'Replacing…' : 'Replace link'}</Button>
      </>}>
      <div className="grid gap-4 text-13 text-ink-2">
        <p className="m-0">Your backend gives this to the app when someone from {entity.name} logs in (or asks for it with an API key: <span className="font-mono text-ink-2">GET /sdk/v1/links</span>). It is the only key the app needs.</p>
        {!app ? <Callout>Add a app service in Settings → Services first: each one has its own link.</Callout> : <>
          <Field label="Service">
            <NativeSelect className="h-[34px]" value={app} onChange={(e) => setApp(e.target.value)} aria-label="Service">
              {clientApps.map((k) => <option key={k} value={k}>{k}</option>)}
            </NativeSelect>
          </Field>
          {error ? <Callout tone="error">{error}</Callout> : <>
            {ofrep && <Field label="OpenFeature token" hint="For OpenFeature’s OFREP providers (web, Android, iOS): send it as Authorization: Bearer <token>.">
              <Input readOnly value={link?.token ?? ''} placeholder="Loading…" onFocus={(e) => e.target.select()} className="h-[34px] font-mono text-13" aria-label="OpenFeature token" />
            </Field>}
            {files && <Field label="CDN file" hint="The same link as an address: this entity’s flagd JSON, with only the checks the device makes, cached by your CDN.">
              <Input readOnly value={url} placeholder="Loading…" onFocus={(e) => e.target.select()} className="h-[34px] font-mono text-13" aria-label="CDN file link" />
            </Field>}
          </>}
        </>}
        <p className="m-0 text-ink-3">Each environment has its own link.</p>
      </div>
    </Drawer>
  );
}
