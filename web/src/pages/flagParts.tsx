// Shared pieces of the flag editor (values, delivery, on/off, entity search, the change summary).
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '@companyflags/ui/components/button';
import { Input } from '@companyflags/ui/components/input';
import { NativeSelect } from '@companyflags/ui/components/native-select';
import { Switch as UISwitch } from '@companyflags/ui/components/switch';
import { cn } from '@companyflags/ui/lib/utils';
import { api, capital, CODE_DEFAULT, dimensionOf, entityIndex, entityLabel, fmtValue, joined, one, type Entity, type FlagDetail } from '../api.ts';
import { go, useApp } from '../app.ts';
import { Actions, ErrorList, Field, InAppDefault, Modal, Switch, Val } from '../ui.tsx';
import { denseField, monoLabel, useAsync } from '../uiKit.ts';
import { useEnvs } from './envs.ts';
import { pathIn, switchPlan } from '../../../server/policy.ts';
import { isVersionFlag } from '../../../server/checks.ts';
import { blankRow, fromText, nameError, rowError, toText, valueError, ValueInput, ValuesEditor, type ValueRow } from '../values.tsx';
import { plural } from '../text.ts';
import { hiddenKey, isHidden, valueOf, type Draft, type Line } from '../lines.ts';
import { useDraft } from '../useDraft.ts';

export type SaveResult = { applied: boolean; revision?: number; changeSetId?: number; bypass?: boolean };

const pct = (n: number) => `${+(n / 100).toFixed(2)}%`;

/** What a rule serves: one value, or values with their share of devices. */
export function GetsText({ line, flag, draft }: { line: Line; flag: FlagDetail; draft: Draft }) {
  const share = (t: string) => <span className="text-13 text-ink-3">{t}</span>;
  if (line.split) {
    const r = line.split.ranges;
    if (r.length === 1 && r[0].from === 0) {
      return <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1"><ValueChip v={r[0].variation} flag={flag} draft={draft} />{share(`for ${pct(r[0].to)}`)}</span>;
    }
    return (
      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
        {r.map((x, i) => <span key={i} className="inline-flex items-center gap-1.5"><ValueChip v={x.variation} flag={flag} draft={draft} />{share(pct(x.to - x.from))}</span>)}
      </span>
    );
  }
  return <span className="inline-flex items-center"><ValueChip v={line.serveVariation} flag={flag} draft={draft} /></span>;
}


/** A variant as the app gets it, in a mono box; the in-app default is dashed. */
export function ValueChip({ v, flag, draft }: { v: string | null; flag: FlagDetail; draft: Draft }) {
  if (!v || v === CODE_DEFAULT) return <InAppDefault />;
  const val = valueOf(flag, draft, v);
  const show = flag.valueType === 'bool' || flag.valueType === 'number' || isHidden(v) ? fmtValue(val) : v;
  return <Val title={val !== undefined ? fmtValue(val) : undefined}>{show}</Val>;
}

type ValuePickProps = {
  flag: FlagDetail; draft: Draft; value: string | null; onChange: (v: string) => void; onNewValue: () => void; withDefaultSwitch?: boolean;
};

// Value picker. For default values (withDefaultSwitch) a Firebase-style "Use in-app default"
// switch sits beside it; in rules the in-app default is just one of the options. A flag with free values (no named
// variants) types its value in instead (FreeValue).
export function ValueSelect(props: ValuePickProps) {
  return props.flag.freeValues && props.flag.valueType !== 'bool' ? <FreeValue {...props} /> : <VariantSelect {...props} />;
}

/**
 * A value typed in, on a flag with free values: stored as a hidden, content-addressed variant (evaluator.ts hiddenKey),
 * made on the server the first time it's used (that changes nothing anyone gets, and writes no history: the save that
 * serves it does). It's taken when the field is left or Enter is pressed. In a rule, an empty field is the in-app
 * default; for a default, the switch under it is.
 */
function FreeValue({ flag, draft, value, onChange, onNewValue, withDefaultSwitch = false }: ValuePickProps) {
  const isDefault = !value || value === CODE_DEFAULT;
  const shown = isDefault ? '' : toText(flag.valueType, valueOf(flag, draft, value));
  const [text, setText] = useState(shown);
  // the value changed elsewhere (an undo, someone else's save): show it, once the flag has it (a value just typed
  // elsewhere may still be on its way)
  const [was, setWas] = useState(value);
  if (was !== value) {
    setWas(value);
    if (isDefault || valueOf(flag, draft, value) !== undefined) setText(shown);
  }
  const [last, setLast] = useState<string | null>(isDefault ? null : value);
  // the in-app default switched off before any value was typed: the field is open for the first one
  const [typing, setTyping] = useState(false);
  if (typing && !isDefault) setTyping(false);
  const { busy, error, run } = useAsync();
  const empty = text.trim() === '';
  const problem = empty ? (withDefaultSwitch ? 'Type a value, or use the in-app default' : null) : valueError(flag.valueType, text);
  const take = async () => {
    if (busy || problem) return;
    // empty in a rule is the in-app default; for a default, only its switch is
    if (empty) { if (!withDefaultSwitch && !isDefault) onChange(CODE_DEFAULT); return; }
    const v = fromText(flag.valueType, text);
    const key = hiddenKey(v);
    if (key === value) return;
    if (!flag.variations.some((x) => x.key === key)) {
      if (!(await run(() => api('PUT', `/flags/${encodeURIComponent(flag.key)}/variations`, { variations: [{ key, value: v }] })))) return;
      onNewValue();
    }
    // the field already shows it: it isn't read back while the flag reloads
    setWas(key);
    onChange(key);
  };
  const field = (
    <span className="grid w-full min-w-0 flex-1 basis-40 gap-1"
      onBlur={() => void take()} onKeyDown={(e) => { if (e.key === 'Enter' && flag.valueType !== 'json') { e.preventDefault(); void take(); } }}>
      <ValueInput dense type={flag.valueType} label="Value" text={text} onChange={setText} invalid={!!problem}
        placeholder={withDefaultSwitch ? undefined : 'In-app default'} />
      {problem && <span className="text-xs text-live">{problem}</span>}
      <ErrorList error={error} />
    </span>
  );
  if (!withDefaultSwitch) return field;
  const inApp = isDefault && !typing;
  return (
    <span className="grid w-full min-w-0 gap-2">
      {inApp ? (
        <span role="status" title="No value is sent: the app uses the default value written in its code"
          className="flex h-[34px] min-w-0 items-center gap-2 border border-dashed border-rule-2 px-2.5 text-13 text-ink-3">
          <span className="shrink-0 italic text-ink-2">In-app default</span>
          <span className="min-w-0 truncate">· nothing is sent</span>
        </span>
      ) : field}
      <label className="inline-flex shrink-0 cursor-default items-center gap-2 justify-self-start text-13 text-ink-2" title="Send nothing: the app uses the default value written in its code">
        <UISwitch aria-label="Use in-app default" checked={inApp} onCheckedChange={(on) => {
          setTyping(false);
          if (on) { if (!isDefault) { setLast(value!); onChange(CODE_DEFAULT); } return; }
          if (last) onChange(last); else setTyping(true);
        }} />
        Use in-app default
      </label>
    </span>
  );
}

function VariantSelect({ flag, draft, value, onChange, onNewValue, withDefaultSwitch = false }: ValuePickProps) {
  const [creating, setCreating] = useState(false);
  const visible = flag.variations.filter((v) => !isHidden(v.key));
  const isDefault = !value || value === CODE_DEFAULT;
  // the value to go back to when the in-app default is switched off again: kept when it's switched on
  const [last, setLast] = useState<string>(!isDefault ? value! : visible[0]?.key ?? '');
  const select = (
    <NativeSelect aria-label="Value" value={value ?? CODE_DEFAULT} className="w-full min-w-0 flex-1 basis-40 [&_select]:h-[34px] [&_select]:text-13"
      onChange={(e) => (e.target.value === '__new' ? setCreating(true) : onChange(e.target.value))}>
      {value && isHidden(value) && <option value={value}>{fmtValue(valueOf(flag, draft, value))} (custom)</option>}
      {visible.map((v) => <option key={v.key} value={v.key}>{flag.valueType === 'bool' || flag.valueType === 'number' ? fmtValue(v.value) : v.key}{flag.valueType === 'string' ? ` — ${fmtValue(v.value)}` : ''}</option>)}
      {(!withDefaultSwitch || isDefault) && <option value={CODE_DEFAULT}>In-app default</option>}
      {flag.valueType !== 'bool' && <option value="__new">+ New variant…</option>}
    </NativeSelect>
  );
  const dialog = creating && <NewValue flag={flag} onClose={() => setCreating(false)} onCreated={(k) => { setCreating(false); onNewValue(); onChange(k); }} />;
  if (!withDefaultSwitch) return <>{select}{dialog}</>;
  // The value's place is kept: with the switch on, a box of the same size says what's sent (nothing) where the picker
  // was, and the switch keeps its own line under it, so flipping it moves nothing on the page.
  return (
    <span className="grid w-full min-w-0 gap-2">
      {isDefault ? (
        <span role="status" title="No value is sent: the app uses the default value written in its code"
          className="flex h-[34px] min-w-0 items-center gap-2 border border-dashed border-rule-2 px-2.5 text-13 text-ink-3">
          <span className="shrink-0 italic text-ink-2">In-app default</span>
          <span className="min-w-0 truncate">· nothing is sent</span>
        </span>
      ) : select}
      <label className="inline-flex shrink-0 cursor-default items-center gap-2 justify-self-start text-13 text-ink-2" title="Send nothing: the app uses the default value written in its code">
        <UISwitch aria-label="Use in-app default" checked={isDefault} onCheckedChange={(on) => {
          if (on && !isDefault) setLast(value!);
          onChange(on ? CODE_DEFAULT : (last || visible[0]?.key || CODE_DEFAULT));
        }} />
        Use in-app default
      </label>
      {dialog}
    </span>
  );
}

export function NewValue({ flag, onClose, onCreated }: { flag: FlagDetail; onClose: () => void; onCreated: (key: string) => void }) {
  const existing: ValueRow[] = flag.variations.map((v) => ({ key: v.key, text: toText(flag.valueType, v.value), isNew: false }));
  const [row, setRow] = useState<ValueRow>(() => blankRow(flag.valueType, existing));
  const { busy, error, run } = useAsync();
  const problem = rowError(flag.valueType, row, [...existing, row]);
  // the message is tied to the field it's about
  const problemId = useId();
  const keyProblem = !!row.key && !!nameError(row, [...existing, row]);
  const valueProblem = !!row.key && !keyProblem && !!valueError(flag.valueType, row.text);
  const save = async () => {
    if (await run(() => api('PUT', `/flags/${flag.key}/variations`, { variations: [...flag.variations, { key: row.key, value: fromText(flag.valueType, row.text) }] }))) onCreated(row.key);
  };
  return (
    <Modal title="New variant" onClose={onClose} footer={
      <Actions><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!!problem || busy} onClick={save}>{busy ? 'Adding…' : 'Add variant'}</Button></Actions>
    }>
      <Field label="Name" hint="A short label, like eu-host or on.">
        <Input className="font-mono" data-autofocus spellCheck={false} value={row.key} onChange={(e) => setRow({ ...row, key: e.target.value.toLowerCase().replace(/\s+/g, '_') })}
          aria-invalid={keyProblem || undefined} aria-describedby={keyProblem ? problemId : undefined} />
      </Field>
      <div className="grid gap-1.5">
        <span className={monoLabel}>Value</span>
        <ValueInput type={flag.valueType} label="Value" text={row.text} onChange={(t) => setRow({ ...row, text: t })}
          invalid={valueProblem} describedBy={valueProblem ? problemId : undefined} />
      </div>
      {row.key && problem && <p id={problemId} role="status" className="m-0 text-13 text-live">{problem}</p>}
      <ErrorList error={error} />
    </Modal>
  );
}

/**
 * Turn the flag on or off in one environment, as policy.ts switchPlan says (the Flags page's bulk bar asks the same):
 * where nothing is reviewed it acts at once with Undo; in a protected environment it asks first and sends the change
 * for review or, for on call turning a kill switch or ops flag off, offers break-glass. The switch is never drafted
 * (README M7): with a saved draft of this flag it offers "Discard and turn off" instead of a dead end, and it tells
 * the draft session what it changed, so a draft made since is known to be stale.
 */
export function PowerSwitch({ flag, env, onSaved }: { flag: FlagDetail; env: string; onSaved: () => void }) {
  const { meta, ask, toast, reload } = useApp();
  const { envName, envOf } = useEnvs();
  const { session: drafts, summary } = useDraft(env);
  const base = flag.layers[env].base;
  // optimistic (Doherty): the switch moves the moment it's clicked and moves back if the server says no. It's
  // for the layer as it was when clicked: once the flag reloads (a new version, or another environment) it's dropped
  const stamp = `${env}:${base.version}:${base.enabled}`;
  const [optimistic, setOptimisticFor] = useState<{ on: boolean; stamp: string } | null>(null);
  const setOptimistic = (v: boolean | null) => setOptimisticFor(v === null ? null : { on: v, stamp });
  const inFlight = useRef(false);
  const on = optimistic?.stamp === stamp ? optimistic.on : !!base.enabled;
  const plan = switchPlan(meta.me, [{ key: flag.key, kind: flag.kind, enabled: on }], envOf(env), !on, summary.has);
  const path = pathIn(plan, flag.key);
  const flip = async () => {
    if (inFlight.current || !path) return;
    if (plan.drafted.length) {
      // on call, the switch must never be a dead end: offer to drop the edits and flip in one step
      const verb = on ? 'turn off' : 'turn on';
      const d = await ask({
        title: `Discard your changes and ${verb} ${flag.key}?`,
        body: `You have unpublished changes to this flag in ${envName(env).toLowerCase()}. They’re discarded first, then the flag is ${on ? 'turned off' : 'turned on'}.`,
        actions: [{ id: 'keep', label: 'Keep editing' }, { id: 'go', label: `Discard and ${verb}`, tone: on ? 'danger' : 'primary' }],
      });
      if (d.action !== 'go') return;
    }
    const off = on;
    const emergency = path === 'break-glass';
    // forgiveness: where nothing is reviewed, act at once and offer Undo
    const r = path === 'now' ? { action: 'now', reason: '' } : await ask({
      title: `${off ? 'Turn off' : 'Turn on'} ${flag.key} in ${envName(env).toLowerCase()}?`,
      body: off ? <><p><b>Nobody will get a value.</b> Every app uses the default in its own code.</p>{emergency && <p className="text-ink-3">You can use break-glass, so you can do this right away. It’s logged for review.</p>}</>
        : <p>Apps get values from the rules again.</p>,
      reason: { label: 'Why? (required)', placeholder: off ? 'INC-123: payment provider outage' : 'Issue resolved' },
      actions: [{ id: 'cancel', label: 'Cancel' },
        ...(emergency ? [{ id: 'now', label: 'Turn off now', tone: 'danger' as const, needsReason: true }] : []),
        { id: 'request', label: 'Request review', tone: emergency ? 'default' as const : 'primary' as const, needsReason: true }],
    });
    if (!r.action || r.action === 'cancel') return;
    // the edits go only once the switch does: cancelling above keeps them
    if (plan.drafted.length) drafts.discard(plan.drafted);
    inFlight.current = true;
    if (r.action === 'now') setOptimistic(!on);
    try {
      const res = await api<SaveResult>('PUT', `/flags/${flag.key}/layers/${env}/base`, {
        layer: { ...base, enabled: !on }, expectedVersion: base.version, reason: r.reason || undefined,
        bypassReason: r.action === 'now' && emergency ? r.reason : undefined,
      });
      const where = `in ${envName(env).toLowerCase()}`;
      // forgiveness: what went live at once can be undone; a review request can be withdrawn on its page
      const undo = res.applied && path === 'now' ? {
        label: 'Undo', onClick: async () => {
          try {
            const d = await api<FlagDetail>('GET', `/flags/${flag.key}`);
            const b = d.layers[env].base;
            await api('PUT', `/flags/${flag.key}/layers/${env}/base`, { layer: { ...b, enabled: on }, expectedVersion: b.version, reason: 'Undo' });
            void drafts.noteChanged([flag.key]);
            toast(`${flag.key} is ${on ? 'on' : 'off'} again ${where}`); reload().catch(() => {}); onSaved();
          } catch (e) { toast(e as Error); }
        },
      } : res.applied ? undefined : { label: 'View', onClick: () => go(`approvals/${res.changeSetId}`) };
      if (res.applied) void drafts.noteChanged([flag.key]); else setOptimistic(null);
      toast(res.applied ? `Turned ${off ? 'off' : 'on'} ${flag.key} ${where}` : `Sent for review: request #${res.changeSetId}`, 'ok', undo);
      reload().catch(() => {});
      onSaved();
    } catch (e) { setOptimistic(null); toast(e as Error); }
    finally { inFlight.current = false; }
  };
  return (
    <Button variant={on ? 'stop' : 'default'} onClick={flip} disabled={!path} title={path ? undefined : 'Viewers can look but not change anything'}
      aria-label={`${on ? 'Turn off' : 'Turn on'} in ${envName(env).toLowerCase()}`}>
      {on ? 'Turn off' : 'Turn on'}
    </Button>
  );
}

/** The Variants tab: the values a flag can send, and editing them. */
export function ValuesPanel({ flag, onSaved }: { flag: FlagDetail; onSaved: () => void }) {
  const { toast, setDirty } = useApp();
  const toRows = (): ValueRow[] => flag.variations.filter((v) => !isHidden(v.key)).map((v) => ({ key: v.key, text: toText(flag.valueType, v.value), isNew: false }));
  const [editing, setEditing] = useState(false);
  // the rows being edited, taken from the flag when editing starts
  const [rows, setRows] = useState(toRows);
  const { busy, error, run } = useAsync();
  const startEditing = () => { setRows(toRows()); setEditing(true); };
  const dirty = editing && JSON.stringify(rows) !== JSON.stringify(toRows());
  useEffect(() => { setDirty(`values:${flag.key}`, dirty); return () => setDirty(`values:${flag.key}`, false); }, [dirty, flag.key, setDirty]);
  const invalid = rows.some((r) => rowError(flag.valueType, r, rows));
  const save = async () => {
    if (await run(() => api('PUT', `/flags/${flag.key}/variations`, { variations: rows.map((r) => ({ key: r.key, value: fromText(flag.valueType, r.text) })) }))) {
      toast(`Saved ${plural(rows.length, 'variant')} for ${flag.key}`); setEditing(false); onSaved();
    }
  };
  const row = 'grid grid-cols-[minmax(0,220px)_minmax(0,1fr)] items-baseline gap-6 border-b border-grid py-3 max-sm:grid-cols-1 max-sm:gap-1.5';
  // a version release's values are its versions, typed in (free values): each is added on its release page
  const versions = flag.kind === 'release' && isVersionFlag({ valueType: flag.valueType, variants: flag.variations });
  // free values: any value is typed into the rules and the default; named variants from before still work
  const free = !!flag.freeValues && !versions;
  return (
    <section aria-label="Variants">
      <div className="flex min-h-[39px] flex-wrap items-center justify-between gap-3 border-b border-rule pb-3">
        {versions ? (
          <p className="m-0 max-w-[640px] text-13 text-ink-2">
            A version release has no variants: each version is typed in. Add the next one on <a href={`#/release/${encodeURIComponent(flag.key)}`}>its release page</a> (+ New version).
          </p>
        ) : free ? (
          <p className="m-0 max-w-[640px] text-13 text-ink-2">
            Variants are off: type any value into the rules and the default. Turn them on in Settings to pick from named values instead.
            {flag.variations.some((v) => !isHidden(v.key)) && ' The named values below are from before, and still work where rules use them.'}
          </p>
        ) : <p className="m-0 max-w-[640px] text-13 text-ink-2">The values this flag can send. Rules pick from this list, so changing a variant here changes it everywhere it’s used.</p>}
        {!editing && !versions && !free && <Button variant="secondary" onClick={startEditing}>Edit variants</Button>}
      </div>
      {!editing ? (
        <ul className="m-0 list-none p-0">
          {flag.variations.filter((v) => !isHidden(v.key)).map((v) => (
            <li key={v.key} className={row}>
              <span className="truncate font-mono text-13 text-ink" title={v.key}>{v.key}</span>
              <span className="min-w-0"><ValuePreview type={flag.valueType} value={v.value} /></span>
            </li>
          ))}
          <li className={row}>
            <span><InAppDefault /></span>
            <span className="text-13 text-ink-2">Always there. Sends nothing, so the app uses the default written in its code.</span>
          </li>
        </ul>
      ) : (
        <div className="grid gap-3">
          <ValuesEditor type={flag.valueType} rows={rows} onChange={setRows} />
          <div><Button variant="link" onClick={() => setRows([...rows, blankRow(flag.valueType, rows)])}>+ Add variant</Button></div>
          <p className="m-0 text-13 text-ink-3">Existing variant names can’t change, because rules may already use them.</p>
          <ErrorList error={error} />
          <Actions className="justify-start">
            <Button disabled={busy || invalid || !dirty} onClick={save}>{busy ? 'Saving…' : 'Save variants'}</Button>
            <Button variant="secondary" onClick={() => setEditing(false)}>Cancel</Button>
          </Actions>
        </div>
      )}
    </section>
  );
}

function ValuePreview({ type, value }: { type: string; value: unknown }) {
  if (type === 'json') {
    return <span className="inline-block max-h-40 max-w-full overflow-auto border border-rule bg-panel px-1.5 py-0.5 font-mono text-13 break-all whitespace-pre-wrap text-ink select-text">{JSON.stringify(value)}</span>;
  }
  return <Val title={String(value)}>{String(value)}</Val>;
}

/** What PUT /flags/:key/delivery answers: `applied: false` (HTTP 202) where the environment needs approval. */
type DeliveryResult = { applied?: boolean; changeSetId?: number };

/** Which services the flag is in, per environment. Changes in environments that need approval are confirmed first. */
export function DeliveryPanel({ flag, onSaved }: { flag: FlagDetail; onSaved: () => void }) {
  const { meta, toast, ask } = useApp();
  const { envName, isProtected } = useEnvs();
  const { error, run } = useAsync();
  const envs = meta.environments;
  // Per environment, the services saved while the flag hasn't reloaded with them yet (`basis`: its list when they were
  // sent). The switches show them, and the next toggle builds on them, so two quick toggles never undo each other;
  // while one is on its way, that environment's switches wait.
  const [sent, setSent] = useState<Record<string, { basis: string; list: string[]; busy: boolean }>>({});
  const stored = (env: string) => flag.delivery[env] ?? [];
  const pending = (env: string) => { const p = sent[env]; return p && p.basis === JSON.stringify(stored(env)) ? p : null; };
  const listIn = (env: string) => pending(env)?.list ?? stored(env);
  const forget = (env: string) => setSent((s) => { const rest = { ...s }; delete rest[env]; return rest; });
  const toggle = async (env: string, project: string, on: boolean) => {
    const where = envName(env).toLowerCase();
    const reviewed = isProtected(env);
    if (reviewed) {
      const r = await ask({
        title: on ? `Put ${flag.key} in ${project} in ${where}?` : `Take ${flag.key} out of ${project} in ${where}?`,
        body: <p>{on ? `Everything that reads ${project} gets this flag, for everyone,` : `Everything that reads ${project} stops getting this flag and uses the default in its own code,`} once an approver approves the change.</p>,
        actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'Request review', tone: on ? 'primary' : 'danger' }],
      });
      if (r.action !== 'ok') return;
    }
    const basis = JSON.stringify(stored(env));
    const now = listIn(env).filter((p) => p !== project);
    const next = on ? [...now, project] : now;
    setSent((s) => ({ ...s, [env]: { basis, list: next, busy: true } }));
    const res = await run(async () => (await api<DeliveryResult | null>('PUT', `/flags/${flag.key}/delivery`, { environment: env, projects: next })) ?? {});
    if (!res) { forget(env); return; }                      // refused: the switches show what the server has
    if (res.applied === false) {
      // nothing changed yet: an approver reviews it first
      forget(env);
      toast(`Sent for review: request #${res.changeSetId}`, 'ok', res.changeSetId ? { label: 'View', onClick: () => go(`approvals/${res.changeSetId}`) } : undefined);
    } else {
      setSent((s) => ({ ...s, [env]: { basis, list: next, busy: false } }));   // shown until the flag reloads with it
      toast(`${flag.key} is ${on ? 'now in' : 'no longer in'} ${project} in ${where}`);
    }
    onSaved();
  };
  const groups = useMemo(() => [
    { title: 'Apps', sub: 'Apps get their values and the checks only the device makes. The rest of your rules stays on the server.', list: meta.projects.filter((p) => p.kind === 'client') },
    { title: 'Backends', sub: 'Your own backends, which get the rules.', list: meta.projects.filter((p) => p.kind === 'server') },
  ], [meta.projects]);
  return (
    <section aria-label="Services" className="grid gap-3">
      <p className="m-0 text-13 text-ink-2">Which services this flag is in, per environment. An app or backend whose service doesn’t have it uses the default in its code.</p>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-13">
          <thead>
            <tr className="border-b border-rule">
              <th className={cn(monoLabel, 'py-2 pr-4 text-left')}>Service</th>
              {envs.map((e) => <th key={e.key} className={cn(monoLabel, 'w-[120px] py-2 pr-4 text-left max-sm:w-auto')}>{envName(e.key)}</th>)}
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g.title}>
              <tr>
                <th colSpan={envs.length + 1} className="pt-5 pb-2 text-left font-normal">
                  <span className="text-sm font-medium text-ink">{g.title}</span> <span className="text-13 text-ink-3">{g.sub}</span>
                </th>
              </tr>
              {g.list.map((p) => (
                <tr key={p.key} className="border-b border-grid">
                  <td className="py-2.5 pr-4 font-mono text-ink">{p.key}</td>
                  {envs.map((e) => (
                    <td key={e.key} className="py-2.5 pr-4">
                      <Switch label={`${p.key} in ${e.key}`} checked={listIn(e.key).includes(p.key)} disabled={!!pending(e.key)?.busy}
                        onChange={(on) => void toggle(e.key, p.key, on)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
      <ErrorList error={error} />
    </section>
  );
}

/**
 * Find an entity by name (a text field with suggestions), in any dimension or only in `dimension`. Dense (32px) unless
 * `className` says otherwise. `id` goes to the text field (a Field passes it, so its label points there).
 */
export function EntityPicker({ value, onChange, allowNone, placeholder, className, id, dimension }: {
  value: string; onChange: (key: string) => void; allowNone?: boolean; placeholder?: string; className?: string; id?: string; dimension?: string;
}) {
  const { meta } = useApp();
  const list = useMemo(() => (dimension ? meta.entities.filter((e) => e.dimension === dimension) : meta.entities), [meta.entities, dimension]);
  // what's typed matches an entity by name (any case) or by key: one lookup per keystroke, not a scan of every entity
  const byName = useMemo(() => {
    const m = new Map<string, Entity>();
    for (const c of list) { const k = c.name.toLowerCase(); if (!m.has(k)) m.set(k, c); }
    return m;
  }, [list]);
  const inList = (e: Entity | undefined) => (e && (!dimension || e.dimension === dimension) ? e : undefined);
  const match = (t: string) => byName.get(t.toLowerCase()) ?? inList(entityIndex(meta.entities).get(t));
  const name = (k: string) => entityIndex(meta.entities).get(k)?.name ?? '';
  // what's typed, for the entity it was typed against; another one chosen (or swapped in) shows its name
  const [typed, setTyped] = useState<{ text: string; for: string } | null>(null);
  const text = typed && typed.for === value ? typed.text : name(value);
  const listId = useId();
  // each suggestion says what it is: "Store · Acme" (its dimension, and its parent)
  const options = useMemo(() => list.map((c) => {
    const d = dimensionOf(meta.dimensions, c.dimension);
    const hint = [d ? capital(one(d)) : null, c.parent ? entityLabel(meta.entities, c.parent) : null].filter(Boolean).join(' · ');
    return <option key={c.key} value={c.name} label={hint || undefined} />;
  }), [list, meta.entities, meta.dimensions]);
  const only = dimension ? dimensionOf(meta.dimensions, dimension) : undefined;
  const what = only ? capital(one(only)) : joined(meta.dimensions, 'or') || 'Who';
  return (
    <>
      <input id={id} list={listId} aria-label={what} value={text} placeholder={placeholder ?? (allowNone ? 'Everyone (none picked)' : `Find: ${what.toLowerCase()}`)}
        className={cn(denseField, 'w-full rounded-none', className)}
        onChange={(e) => {
          const t = e.target.value;
          setTyped({ text: t, for: value });
          const hit = match(t);
          if (hit) onChange(hit.key); else if (!t && allowNone) onChange('');
        }}
        onBlur={() => { if (text && !match(text)) setTyped(null); }}
        aria-invalid={!!text && !match(text)} />
      <datalist id={listId}>{options}</datalist>
    </>
  );
}
