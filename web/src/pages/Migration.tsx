import { useRef, useState } from 'react';
import { Button } from '@companyflags/ui/components/button';
import { Callout } from '@companyflags/ui/components/callout';
import { Checkbox } from '@companyflags/ui/components/checkbox';
import { Input } from '@companyflags/ui/components/input';
import { NativeSelect } from '@companyflags/ui/components/native-select';
import { PageBar } from '@companyflags/ui/components/page-bar';
import { cn } from '@companyflags/ui/lib/utils';
import { api } from '../api.ts';
import { useApp } from '../app.ts';
import { ErrorList, Field, Heading } from '../ui.tsx';
import { copyText, textareaField, useAsync } from '../uiKit.ts';
import { roleInfo } from '../../../server/policy.ts';
import { download, FORMAT_HINT, FORMATS_IN, SAMPLE_IN, SIDE_BY_SIDE, type Imported, type Plan } from './migrationKit.ts';

/*
 * Migration: moving to CompanyFlags from another config system, with both running side by side until the last flag
 * has moved (docs/guide/migration.md). Import the old system's values (server/values.ts), export these, and keep
 * both the same with webhooks out and in (their own page: Webhooks.tsx). Everyone can see it and export (with JSONata:
 * admins only); admins import.
 */

const selectField = 'w-full [&_select]:h-[34px] [&_select]:text-13';
const code = 'm-0 max-h-[320px] overflow-auto border border-grid bg-panel p-3 font-mono text-xs leading-relaxed text-ink-1 whitespace-pre';

export function Migration() {
  const { meta } = useApp();
  const admin = roleInfo(meta.me.role).changesSettings;
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <PageBar title="Migration" count={admin ? undefined : 'Only admins import'} />
      <div className="grid gap-10 px-6 py-6 max-sm:px-4">
        <SideBySide />
        {admin && <ImportSection />}
        <ExportSection admin={admin} />
      </div>
    </div>
  );
}

function SideBySide() {
  const { meta, toast } = useApp();
  return (
    <section aria-labelledby="m-side" className="grid gap-3">
      <Heading id="m-side" title="Run both side by side">
        Move one flag at a time. Apps ask CompanyFlags first and the old system for everything not moved yet, so nothing changes for anyone on the day you start.
      </Heading>
      <ol className="m-0 grid max-w-[760px] list-decimal gap-2 pl-5 text-13 text-ink-2 marker:text-ink-3">
        <li><b className="font-medium text-ink">Import</b> the old system’s flags below, with “Create missing flags” on. They’re in no service yet, so apps still read the old system.</li>
        <li><b className="font-medium text-ink">Put OpenFeature’s Multi-Provider</b> in each app: CompanyFlags first, the old system second. A flag that isn’t in the app’s service is “not found” here, so the old system answers.</li>
        <li><b className="font-medium text-ink">Move a flag</b> by adding it to the app’s service, on the flag’s page. From then on the app reads it here.</li>
        <li><b className="font-medium text-ink">Keep both the same</b> meanwhile: a webhook out tells the old system each change made here, and a webhook in takes the old system’s changes{meta.plugins.includes('webhooks') ? <> (<a href="#/webhooks">Webhooks</a>)</> : null}.</li>
      </ol>
      <div className="grid gap-2">
        <pre className={code}>{SIDE_BY_SIDE}</pre>
        <div><Button variant="secondary" onClick={() => void copyText(SIDE_BY_SIDE, 'the code', toast)}>Copy code</Button></div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- import

function ImportSection() {
  const { meta, toast } = useApp();
  const [env, setEnv] = useState(meta.environments[0]?.key ?? '');
  const [format, setFormat] = useState('kv');
  const [text, setText] = useState('');
  const [expression, setExpression] = useState(SAMPLE_IN);
  const [createFlags, setCreateFlags] = useState(true);
  const [sets, setSets] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null);
  const { busy, error, setError, run } = useAsync();
  const file = useRef<HTMLInputElement>(null);
  const body = () => ({ environment: env, format, text, expression: format === 'jsonata' ? expression : undefined, createFlags, services: sets, reason });
  // anything changed after a preview: preview again before importing
  const edit = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPlan(null); };

  const preview = async () => {
    setError(null);
    const r = await run(() => api<{ plan: Plan }>('POST', '/migration/preview', body()));
    if (r) setPlan(r.plan);
  };
  const doImport = async () => {
    const r = await run(() => api<Imported>('POST', '/migration/import', body()));
    if (!r) return;
    setPlan(null);
    const what = `${r.created ? `${r.created} new ${r.created === 1 ? 'flag' : 'flags'}, ` : ''}${r.changed} ${r.changed === 1 ? 'change' : 'changes'}`;
    toast(r.applied ? `Imported: ${what}` : `Imported ${what} as request #${r.request}: it goes out once it’s approved`);
  };
  const readFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 5_000_000) { setError({ message: 'That file is larger than 5 MB: import it in parts.' }); return; }
    setText(await f.text());
    setPlan(null);
  };
  const envName = meta.environments.find((e) => e.key === env)?.name ?? env;
  const ready = !!plan && !plan.problems.length && (plan.changes.length > 0 || plan.create.length > 0);

  return (
    <section aria-labelledby="m-import" className="grid gap-3">
      <Heading id="m-import" title="Import">
        Brings another system’s values into one environment: each flag’s value for everyone, on/off, and entities’ own values. Rules and % stay as they are.
        You see every change before anything is saved.
      </Heading>
      <div className="grid gap-4 border border-grid p-4">
        <div className="grid grid-cols-3 gap-4 max-md:grid-cols-1">
          <Field label="Environment">
            <NativeSelect className={selectField} value={env} onChange={(e) => edit(setEnv)(e.target.value)}>
              {meta.environments.map((e) => <option key={e.key} value={e.key}>{e.name}</option>)}
            </NativeSelect>
          </Field>
          <Field label="Format" hint={FORMAT_HINT[format]} className="col-span-2 max-md:col-span-1">
            <NativeSelect className={selectField} value={format} onChange={(e) => edit(setFormat)(e.target.value)}>
              {FORMATS_IN.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
            </NativeSelect>
          </Field>
        </div>
        <Field label="The old system’s JSON" hint={<>Paste it, or <button type="button" className="underline" onClick={() => file.current?.click()}>choose a file</button>.</>}>
          <textarea rows={8} value={text} onChange={(e) => edit(setText)(e.target.value)} spellCheck={false} placeholder='{ "max_upload_mb": 100 }'
            className={cn(textareaField, 'font-mono text-xs')} />
        </Field>
        <input ref={file} type="file" accept=".json,application/json" className="hidden" onChange={(e) => void readFile(e.target.files?.[0])} />
        {format === 'jsonata' && (
          <Field label="JSONata expression" hint={<>It gets the JSON above and makes {'{ "flags": { "<key>": { "value": … } } }'}. <a href="https://docs.jsonata.org" target="_blank" rel="noreferrer">JSONata’s docs</a></>}>
            <textarea rows={4} value={expression} onChange={(e) => edit(setExpression)(e.target.value)} spellCheck={false} className={cn(textareaField, 'font-mono text-xs')} />
          </Field>
        )}
        <div className="grid gap-2">
          <label className="inline-flex items-center gap-2 text-13">
            <Checkbox checked={createFlags} onCheckedChange={(v) => edit(setCreateFlags)(v === true)} /> Create missing flags
          </label>
          {createFlags && (
            <div className="grid gap-1.5 pl-6">
              <span className="text-13 text-ink-3">New flags go in these services in {envName}. Leave them all off to move each flag later.</span>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {meta.services.map((p) => (
                  <label key={p.key} className="inline-flex items-center gap-2 font-mono text-xs">
                    <Checkbox checked={sets.includes(p.key)} onCheckedChange={(v) => edit(setSets)(v === true ? [...sets, p.key] : sets.filter((a) => a !== p.key))} /> {p.key}
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
        <Field label="Reason" hint="Shown in History, and to the reviewer where changes need approval.">
          <Input className="h-[34px] text-13" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Moving from the old config service" />
        </Field>
        <ErrorList error={error} />
        {plan && <PlanView plan={plan} envName={envName} />}
        <div className="flex flex-wrap gap-2">
          <Button variant={ready ? 'secondary' : 'default'} disabled={busy || !text.trim()} onClick={() => void preview()}>{busy && !plan ? 'Reading…' : 'Preview'}</Button>
          <Button disabled={busy || !ready} onClick={() => void doImport()}>{plan?.review ? 'Import as a request' : 'Import'}</Button>
        </div>
      </div>
    </section>
  );
}

function PlanView({ plan, envName }: { plan: Plan; envName: string }) {
  const list = (lines: { flag: string; text: string }[]) => (
    <ul className="m-0 grid gap-1 p-0">
      {lines.map((l, i) => <li key={`${l.flag}-${i}`} className="flex gap-3 text-13"><code className="shrink-0 font-mono text-xs text-ink">{l.flag}</code><span className="text-ink-2">{l.text}</span></li>)}
    </ul>
  );
  const nothing = !plan.problems.length && !plan.changes.length && !plan.create.length;
  return (
    <div className="grid gap-3 border-t border-grid pt-3">
      {plan.problems.length > 0 && (
        <Callout tone="error" role="alert">
          <p className="m-0 font-medium">Fix {plan.problems.length === 1 ? 'this' : `these ${plan.problems.length}`} first: nothing is imported while any are left.</p>
          <ul className="m-0 mt-1 grid gap-0.5 pl-4 text-13">{plan.problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </Callout>
      )}
      {plan.warnings.map((w) => <Callout key={w} tone="warn">{w}</Callout>)}
      {plan.review && !nothing && <Callout tone="warn">{envName} needs approval: these changes become one request, and go out once it’s approved.</Callout>}
      {plan.create.length > 0 && <div className="grid gap-1.5"><span className="text-13 font-medium">New flags ({plan.create.length})</span>{list(plan.create)}</div>}
      {plan.changes.length > 0 && <div className="grid gap-1.5"><span className="text-13 font-medium">Changes ({plan.changes.length})</span>{list(plan.changes)}</div>}
      <span className="text-13 text-ink-3">{nothing ? 'Nothing to change: ' : ''}{plan.unchanged} {plan.unchanged === 1 ? 'flag is' : 'flags are'} already as it says.</span>
    </div>
  );
}

// ---------------------------------------------------------------- export

// JSONata runs only for admins (server/api.ts): others export the fixed formats
function ExportSection({ admin }: { admin: boolean }) {
  const { meta } = useApp();
  const formats = FORMATS_IN.filter(([k]) => admin || k !== 'jsonata');
  const [env, setEnv] = useState(meta.environments[0]?.key ?? '');
  const [format, setFormat] = useState('values');
  const [service, setService] = useState(meta.services.find((p) => p.kind === 'server')?.key ?? meta.services[0]?.key ?? '');
  const [expression, setExpression] = useState('flags.$each(function($v, $k) { { "name": $k, "value": $v.value } })');
  const [shown, setShown] = useState<string | null>(null);
  const { busy, error, run } = useAsync();
  const get = async () => {
    const r = await run(() => api<{ output: unknown }>('POST', '/migration/export', { environment: env, format, service: format === 'flagd' ? service : null, expression: format === 'jsonata' ? expression : null }));
    return r ? (typeof r.output === 'string' ? r.output : JSON.stringify(r.output, null, 2)) : null;
  };
  return (
    <section aria-labelledby="m-export" className="grid gap-3">
      <Heading id="m-export" title="Export">
        One environment’s values, for the old system or a backup: each flag’s value for everyone, on/off, variants and entities’ own values. A values export imports back unchanged.
      </Heading>
      <div className="grid gap-4 border border-grid p-4">
        <div className="grid grid-cols-3 gap-4 max-md:grid-cols-1">
          <Field label="Environment">
            <NativeSelect className={selectField} value={env} onChange={(e) => { setEnv(e.target.value); setShown(null); }}>
              {meta.environments.map((e) => <option key={e.key} value={e.key}>{e.name}</option>)}
            </NativeSelect>
          </Field>
          <Field label="Format" hint={admin ? undefined : 'Only admins export with a JSONata expression.'}>
            <NativeSelect className={selectField} value={format} onChange={(e) => { setFormat(e.target.value); setShown(null); }}>
              {formats.map(([k, n]) => <option key={k} value={k}>{k === 'flagd' ? 'flagd (one service’s file)' : n}</option>)}
            </NativeSelect>
          </Field>
          {format === 'flagd' && (
            <Field label="Service">
              <NativeSelect className={selectField} value={service} onChange={(e) => { setService(e.target.value); setShown(null); }}>
                {meta.services.map((p) => <option key={p.key} value={p.key}>{p.key}</option>)}
              </NativeSelect>
            </Field>
          )}
        </div>
        {format === 'jsonata' && (
          <Field label="JSONata expression" hint="It gets the values document and makes whatever the other system reads.">
            <textarea rows={3} value={expression} onChange={(e) => { setExpression(e.target.value); setShown(null); }} spellCheck={false} className={cn(textareaField, 'font-mono text-xs')} />
          </Field>
        )}
        <ErrorList error={error} />
        {shown !== null && <pre className={code}>{shown.length > 20_000 ? `${shown.slice(0, 20_000)}\n…` : shown}</pre>}
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={busy} onClick={async () => setShown(await get())}>Show</Button>
          <Button disabled={busy} onClick={async () => { const t = await get(); if (t !== null) download(`${env}-${format}.json`, t); }}>Download</Button>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- webhooks
