import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@companyflags/ui/components/button';
import { Callout } from '@companyflags/ui/components/callout';
import { Checkbox } from '@companyflags/ui/components/checkbox';
import { tableHeadClass, tableRowClass } from '@companyflags/ui/components/data-table';
import { Drawer } from '@companyflags/ui/components/drawer';
import { Input } from '@companyflags/ui/components/input';
import { NativeSelect } from '@companyflags/ui/components/native-select';
import { PageBar } from '@companyflags/ui/components/page-bar';
import { cn } from '@companyflags/ui/lib/utils';
import { api } from '../api.ts';
import { useApp } from '../app.ts';
import { Actions, Badge, Empty, ErrorList, Field, Heading, Modal, Switch, When } from '../ui.tsx';
import { copyText, textareaField, useAsync } from '../uiKit.ts';
import { roleInfo } from '../../../server/policy.ts';
import {
  download, EVENT_NAMES, FORMAT_HINT, FORMATS_IN, incomingUrl, lastDelivery, OUT_FORMAT_HINT, OUT_FORMATS, SAMPLE_IN, SAMPLE_OUT, SIDE_BY_SIDE,
  WEBHOOKS_PATH, type Imported, type Plan, type WebhookIn, type WebhookList, type WebhookOut,
} from './migrationKit.ts';

/*
 * Migration: moving to CompanyFlags from another config system, with both running side by side until the last flag
 * has moved (docs/guide/migration.md). Import the old system's values (server/values.ts), export these, and keep
 * both the same with webhooks out and in (server/webhooks.ts). Everyone can see it and export; admins do the rest.
 */

const selectField = 'w-full [&_select]:h-[34px] [&_select]:text-13';
const code = 'm-0 max-h-[320px] overflow-auto border border-grid bg-subtle p-3 font-mono text-12 leading-relaxed text-ink-1 whitespace-pre';

export function Migration() {
  const { meta } = useApp();
  const admin = roleInfo(meta.me.role).changesSettings;
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <PageBar title="Migration" count={admin ? undefined : 'Only admins import and set up webhooks'} />
      <div className="grid gap-10 px-6 py-6 max-sm:px-4">
        <SideBySide />
        {admin && <ImportSection />}
        <ExportSection />
        {/* the webhooks plugin's (server/plugins/webhooks.ts), when this server runs it */}
        {meta.plugins?.includes('webhooks') && <WebhooksSection admin={admin} />}
      </div>
    </div>
  );
}

function SideBySide() {
  const { toast } = useApp();
  return (
    <section aria-labelledby="m-side" className="grid gap-3">
      <Heading id="m-side" title="Run both side by side">
        Move one flag at a time. Apps ask CompanyFlags first and the old system for everything not moved yet, so nothing changes for anyone on the day you start.
      </Heading>
      <ol className="m-0 grid max-w-[760px] list-decimal gap-2 pl-5 text-13 text-ink-2 marker:text-ink-3">
        <li><b className="font-medium text-ink">Import</b> the old system’s flags below, with “Create missing flags” on. They’re in no flag set yet, so apps still read the old system.</li>
        <li><b className="font-medium text-ink">Put OpenFeature’s Multi-Provider</b> in each app: CompanyFlags first, the old system second. A flag that isn’t in the app’s flag set is “not found” here, so the old system answers.</li>
        <li><b className="font-medium text-ink">Move a flag</b> by adding it to the app’s flag set, on the flag’s page. From then on the app reads it here.</li>
        <li><b className="font-medium text-ink">Keep both the same</b> meanwhile: a webhook out tells the old system each change made here, and a webhook in takes the old system’s changes.</li>
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
  const body = () => ({ environment: env, format, text, expression: format === 'jsonata' ? expression : undefined, createFlags, flagSets: sets, reason });
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
            className={cn(textareaField, 'font-mono text-12')} />
        </Field>
        <input ref={file} type="file" accept=".json,application/json" className="hidden" onChange={(e) => void readFile(e.target.files?.[0])} />
        {format === 'jsonata' && (
          <Field label="JSONata expression" hint={<>It gets the JSON above and makes {'{ "flags": { "<key>": { "value": … } } }'}. <a href="https://docs.jsonata.org" target="_blank" rel="noreferrer">JSONata’s docs</a></>}>
            <textarea rows={4} value={expression} onChange={(e) => edit(setExpression)(e.target.value)} spellCheck={false} className={cn(textareaField, 'font-mono text-12')} />
          </Field>
        )}
        <div className="grid gap-2">
          <label className="inline-flex items-center gap-2 text-13">
            <Checkbox checked={createFlags} onCheckedChange={(v) => edit(setCreateFlags)(v === true)} /> Create missing flags
          </label>
          {createFlags && (
            <div className="grid gap-1.5 pl-6">
              <span className="text-13 text-ink-3">New flags go in these flag sets in {envName}. Leave them all off to move each flag later.</span>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {meta.projects.map((p) => (
                  <label key={p.key} className="inline-flex items-center gap-2 font-mono text-12">
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
      {lines.map((l, i) => <li key={`${l.flag}-${i}`} className="flex gap-3 text-13"><code className="shrink-0 font-mono text-12 text-ink">{l.flag}</code><span className="text-ink-2">{l.text}</span></li>)}
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

function ExportSection() {
  const { meta } = useApp();
  const [env, setEnv] = useState(meta.environments[0]?.key ?? '');
  const [format, setFormat] = useState('values');
  const [flagSet, setFlagSet] = useState(meta.projects.find((p) => p.kind === 'server')?.key ?? meta.projects[0]?.key ?? '');
  const [expression, setExpression] = useState('flags.$each(function($v, $k) { { "name": $k, "value": $v.value } })');
  const [shown, setShown] = useState<string | null>(null);
  const { busy, error, run } = useAsync();
  const get = async () => {
    const r = await run(() => api<{ output: unknown }>('POST', '/migration/export', { environment: env, format, flagSet: format === 'flagd' ? flagSet : null, expression: format === 'jsonata' ? expression : null }));
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
          <Field label="Format">
            <NativeSelect className={selectField} value={format} onChange={(e) => { setFormat(e.target.value); setShown(null); }}>
              {FORMATS_IN.map(([k, n]) => <option key={k} value={k}>{k === 'flagd' ? 'flagd (one flag set’s file)' : n}</option>)}
            </NativeSelect>
          </Field>
          {format === 'flagd' && (
            <Field label="Flag set">
              <NativeSelect className={selectField} value={flagSet} onChange={(e) => { setFlagSet(e.target.value); setShown(null); }}>
                {meta.projects.map((p) => <option key={p.key} value={p.key}>{p.key}</option>)}
              </NativeSelect>
            </Field>
          )}
        </div>
        {format === 'jsonata' && (
          <Field label="JSONata expression" hint="It gets the values document and makes whatever the other system reads.">
            <textarea rows={3} value={expression} onChange={(e) => { setExpression(e.target.value); setShown(null); }} spellCheck={false} className={cn(textareaField, 'font-mono text-12')} />
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

function WebhooksSection({ admin }: { admin: boolean }) {
  const { meta, toast, ask } = useApp();
  const [list, setList] = useState<WebhookList | null>(null);
  const [drawer, setDrawer] = useState<{ out: WebhookOut | null } | { in: WebhookIn | null } | null>(null);
  const [once, setOnce] = useState<{ title: string; body: string; value: string; what: string } | null>(null);
  const { error, setError, run } = useAsync();
  const latest = useRef(0);
  const load = useCallback(() => {
    const id = ++latest.current;
    return api<WebhookList>('GET', WEBHOOKS_PATH).then((r) => { if (id === latest.current) setList(r); }, (e) => { if (id === latest.current) setError({ message: e.message }); });
  }, [setError]);
  useEffect(() => { void load(); }, [load]);
  const envName = (k: string) => meta.environments.find((e) => e.key === k)?.name ?? k;

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setError(null);
    if ((await run(fn)) === undefined) return;
    if (done) toast(done);
    await load();
  };
  const remove = async (what: string, path: string) => {
    const { action } = await ask({ title: `Delete ${what}?`, body: <p>It stops at once. History keeps a note that it was deleted.</p>,
      actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'delete', label: 'Delete', tone: 'danger' }] });
    if (action === 'delete') await act(() => api('DELETE', path), `${what} deleted`);
  };
  const test = async (w: WebhookOut) => {
    setError(null);
    const r = await run(() => api<{ ok: boolean; status: number | null; error: string | null; skipped?: boolean }>('POST', `${WEBHOOKS_PATH}/${w.id}/test`));
    if (!r) return;
    toast(r.skipped ? 'Your expression makes nothing of the test message, so nothing was sent.' : r.ok ? `${w.host} answered ${r.status}: it can be reached.` : (r.error ?? 'It didn’t answer.'), r.ok ? 'ok' : 'err');
  };

  return (
    <section aria-labelledby="m-hooks" className="grid gap-3">
      <Heading id="m-hooks" title="Webhooks" action={admin && <div className="flex gap-2">
        <Button variant="secondary" onClick={() => setDrawer({ in: null })}>+ Webhook in</Button>
        <Button onClick={() => setDrawer({ out: null })}>+ Webhook out</Button>
      </div>}>
        Out: after each change, this server tells an address what changed (signed JSON, a Slack message, or your own shape). In: another system posts its values here, and they’re imported.
      </Heading>
      <ErrorList error={error} />
      {list && !list.reachable && <Callout>This server doesn’t send webhooks out: it was started without network access for them.</Callout>}
      {list && (
        <>
          <span className="text-13 font-medium">Out</span>
          {list.webhooks.length === 0 ? <Empty>No webhooks out. Add one to post each change to Slack, CI or the old system.</Empty> : (
            <div role="table" aria-label="Webhooks out">
              <div role="row" className={cn(OUT_COLS, tableHeadClass)}>
                <span role="columnheader">Name</span><span role="columnheader" className={MD}>Sends</span><span role="columnheader" className={MD}>Last delivery</span><span />
              </div>
              {list.webhooks.map((w) => {
                const last = lastDelivery(w);
                return (
                  <div key={w.id} role="row" className={cn(OUT_COLS, tableRowClass)}>
                    <span role="cell" className="grid min-w-0">
                      <span className="truncate font-medium">{w.name}</span>
                      <span className="truncate font-mono text-12 text-ink-3">{w.method} {w.host}</span>
                    </span>
                    <span role="cell" className={cn(MD, 'text-13 text-ink-2')}>
                      {w.events.map((e) => EVENT_NAMES[e] ?? e).join(' and ')} · {w.environments ? w.environments.map(envName).join(', ') : 'every environment'}
                      {' · '}{OUT_FORMATS.find(([k]) => k === w.format)?.[1] ?? w.format}
                    </span>
                    <span role="cell" className={cn(MD, 'min-w-0 truncate text-13')} title={w.lastError ?? undefined}>
                      {last.tone === 'bad' ? <Badge kind="danger" title={last.text}>{w.nextAttemptAt ? 'Failed: tries again' : 'Failed'}</Badge>
                        : <span className={last.tone === 'ok' ? 'text-ink-2' : 'text-ink-3'}>{last.text}{last.tone === 'ok' && w.lastSentAt && <> · <When iso={w.lastSentAt} /></>}</span>}
                    </span>
                    <span role="cell" className="flex items-center justify-end gap-2">
                      {admin && <>
                        <Switch checked={w.enabled} label={`${w.name} on`} onChange={(v) => void act(() => api('PUT', `${WEBHOOKS_PATH}/${w.id}`, { enabled: v }), v ? `${w.name} is on: it sends changes from now` : `${w.name} is off`)} />
                        <Button variant="secondary" onClick={() => void test(w)}>Test</Button>
                        <Button variant="secondary" onClick={() => setDrawer({ out: w })}>Edit</Button>
                      </>}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          <span className="text-13 font-medium">In</span>
          {list.incoming.length === 0 ? <Empty>No webhooks in. Add one for the old system to post its values to while both run.</Empty> : (
            <div role="table" aria-label="Webhooks in">
              <div role="row" className={cn(OUT_COLS, tableHeadClass)}>
                <span role="columnheader">Name</span><span role="columnheader" className={MD}>Imports</span><span role="columnheader" className={MD}>Last received</span><span />
              </div>
              {list.incoming.map((w) => (
                <div key={w.id} role="row" className={cn(OUT_COLS, tableRowClass)}>
                  <span role="cell" className="truncate font-medium">{w.name}</span>
                  <span role="cell" className={cn(MD, 'text-13 text-ink-2')}>
                    {FORMATS_IN.find(([k]) => k === w.format)?.[1] ?? w.format} into {envName(w.environment)}{w.createFlags ? ', creating missing flags' : ''}
                  </span>
                  <span role="cell" className={cn(MD, 'min-w-0 truncate text-13')} title={w.lastResult ?? undefined}>
                    {w.lastReceivedAt
                      ? (w.lastStatus && w.lastStatus >= 400 ? <Badge kind="danger" title={w.lastResult ?? undefined}>{w.lastResult}</Badge>
                        : <span className="text-ink-2">{w.lastResult} · <When iso={w.lastReceivedAt} /></span>)
                      : <span className="text-ink-3">Nothing received yet</span>}
                  </span>
                  <span role="cell" className="flex items-center justify-end gap-2">
                    {admin && <>
                      <Switch checked={w.enabled} label={`${w.name} on`} onChange={(v) => void act(() => api('PUT', `${WEBHOOKS_PATH}/in/${w.id}`, { enabled: v }), v ? `${w.name} is on` : `${w.name} is off: it refuses posts`)} />
                      <Button variant="secondary" onClick={() => setDrawer({ in: w })}>Edit</Button>
                    </>}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {drawer && 'out' in drawer && <OutDrawer webhook={drawer.out} onClose={() => setDrawer(null)}
        onDelete={drawer.out ? () => { const w = drawer.out!; setDrawer(null); void remove(w.name, `${WEBHOOKS_PATH}/${w.id}`); } : undefined}
        onNewSecret={drawer.out ? async () => {
          const w = drawer.out!;
          const r = await run(() => api<{ secret: string }>('POST', `${WEBHOOKS_PATH}/${w.id}/secret`));
          if (r) { setDrawer(null); setOnce({ title: `New signing secret for ${w.name}`, body: 'The old one stopped signing just now: give this one to the receiving end. You won’t see it again.', value: r.secret, what: 'the secret' }); }
        } : undefined}
        onSaved={async (r) => {
          setDrawer(null);
          await load();
          if (r.secret) setOnce({ title: `${r.webhook.name} is set up`, body: 'Each message is signed with this secret (Standard Webhooks). Give it to the receiving end to check them. You won’t see it again.', value: r.secret, what: 'the secret' });
          else toast(`${r.webhook.name} saved`);
        }} />}
      {drawer && 'in' in drawer && <InDrawer webhook={drawer.in} onClose={() => setDrawer(null)}
        onDelete={drawer.in ? () => { const w = drawer.in!; setDrawer(null); void remove(w.name, `${WEBHOOKS_PATH}/in/${w.id}`); } : undefined}
        onNewAddress={drawer.in ? async () => {
          const w = drawer.in!;
          const r = await run(() => api<{ token: string }>('POST', `${WEBHOOKS_PATH}/in/${w.id}/token`));
          if (r) { setDrawer(null); setOnce({ title: `New address for ${w.name}`, body: 'The old address stopped working just now. You won’t see this one again.', value: incomingUrl(r.token), what: 'the address' }); }
        } : undefined}
        onSaved={async (r) => {
          setDrawer(null);
          await load();
          if (r.token) setOnce({ title: `${r.webhook.name} is set up`, body: 'The other system posts its values to this address (POST, JSON). The address is the password: keep it secret. You won’t see it again.', value: incomingUrl(r.token), what: 'the address' });
          else toast(`${r.webhook.name} saved`);
        }} />}
      {once && <ShownOnce {...once} onClose={() => setOnce(null)} />}
    </section>
  );
}

const OUT_COLS = 'grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,auto)] max-md:grid-cols-[minmax(0,1fr)_minmax(0,auto)]';
const MD = 'max-md:hidden';

function ShownOnce({ title, body, value, what, onClose }: { title: string; body: string; value: string; what: string; onClose: () => void }) {
  const { toast } = useApp();
  return (
    <Modal title={title} onClose={onClose} footer={
      <Actions>
        <Button variant="secondary" onClick={onClose}>Done</Button>
        <Button onClick={() => void copyText(value, what, toast)}>Copy</Button>
      </Actions>
    }>
      <p className="m-0 text-sm text-ink-1">{body}</p>
      <Input readOnly value={value} data-autofocus onFocus={(e) => e.currentTarget.select()} className="h-[34px] font-mono text-11" aria-label={what} />
    </Modal>
  );
}

function OutDrawer({ webhook, onClose, onSaved, onDelete, onNewSecret }: {
  webhook: WebhookOut | null; onClose: () => void; onSaved: (r: { webhook: WebhookOut; secret?: string }) => void; onDelete?: () => void; onNewSecret?: () => void;
}) {
  const { meta } = useApp();
  const first = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(webhook?.name ?? '');
  const [url, setUrl] = useState('');
  const [method, setMethod] = useState(webhook?.method ?? 'POST');
  const [header, setHeader] = useState({ name: webhook?.headerNames[0] ?? '', value: '' });
  const [format, setFormat] = useState(webhook?.format ?? 'json');
  const [expression, setExpression] = useState(webhook?.expression ?? SAMPLE_OUT);
  const [events, setEvents] = useState<string[]>(webhook?.events ?? ['changes']);
  const [envs, setEnvs] = useState<string[] | null>(webhook?.environments ?? null);
  const { busy, error, run } = useAsync();
  const save = async () => {
    const headerChanged = !webhook || header.value.trim() !== '' || (webhook.headerNames[0] ?? '') !== header.name.trim();
    const body = {
      name, ...(url.trim() ? { url: url.trim() } : {}), method, format, expression: format === 'jsonata' ? expression : null, events, environments: envs,
      ...(headerChanged ? { headers: header.name.trim() && header.value.trim() ? { [header.name.trim()]: header.value.trim() } : {} } : {}),
    };
    const r = await run(() => webhook
      ? api<WebhookOut>('PUT', `${WEBHOOKS_PATH}/${webhook.id}`, body).then((w) => ({ webhook: w }))
      : api<{ webhook: WebhookOut; secret: string }>('POST', WEBHOOKS_PATH, body));
    if (r) onSaved(r);
  };
  const toggle = (list: string[], k: string, on: boolean) => (on ? [...new Set([...list, k])] : list.filter((x) => x !== k));
  const ready = name.trim() && (webhook || url.trim()) && events.length && (envs === null || envs.length);
  return (
    <Drawer open onClose={onClose} title={webhook ? `Edit ${webhook.name}` : 'Webhook out'} initialFocus={first}
      subtitle="After each change, this server posts what changed to this address. One that’s down is tried again later, and holds up only itself."
      footer={<>
        <Button disabled={busy || !ready} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        {onNewSecret && <><span className="flex-1" /><Button variant="secondary" onClick={onNewSecret}>New secret</Button></>}
        {onDelete && <Button variant="secondary" onClick={onDelete}>Delete</Button>}
      </>}>
      <div className="grid gap-4">
        <Field label="Name" required><Input ref={first} className="h-[34px] text-13" value={name} onChange={(e) => setName(e.target.value)} placeholder="Old config service" /></Field>
        <div className="grid grid-cols-[1fr_110px] gap-3">
          <Field label="Address" required={!webhook} hint={webhook ? `Now ${webhook.host}. Leave empty to keep it.` : 'Kept on the server: only its host is shown again.'}>
            <Input className="h-[34px] font-mono text-13" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.slack.com/services/…" autoComplete="off" />
          </Field>
          <Field label="Method">
            <NativeSelect className={selectField} value={method} onChange={(e) => setMethod(e.target.value)}>
              {['POST', 'PUT', 'PATCH'].map((m) => <option key={m}>{m}</option>)}
            </NativeSelect>
          </Field>
        </div>
        <Field label="Format" hint={OUT_FORMAT_HINT[format]}>
          <NativeSelect className={selectField} value={format} onChange={(e) => setFormat(e.target.value)}>
            {OUT_FORMATS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
          </NativeSelect>
        </Field>
        {format === 'jsonata' && (
          <Field label="JSONata expression" hint="It gets the JSON message (type, timestamp, data: changes and values) and makes the body. Nothing: that message isn’t sent.">
            <textarea rows={4} value={expression} onChange={(e) => setExpression(e.target.value)} spellCheck={false} className={cn(textareaField, 'font-mono text-12')} />
          </Field>
        )}
        <Field label="Sends">
          <div className="grid gap-1.5">
            <label className="inline-flex items-center gap-2 text-13"><Checkbox checked={events.includes('changes')} onCheckedChange={(v) => setEvents(toggle(events, 'changes', v === true))} /> Changes: what an environment serves</label>
            <label className="inline-flex items-center gap-2 text-13"><Checkbox checked={events.includes('reviews')} onCheckedChange={(v) => setEvents(toggle(events, 'reviews', v === true))} /> Reviews: a request made, approved, rejected or scheduled</label>
          </div>
        </Field>
        <Field label="Environments">
          <div className="grid gap-1.5">
            <label className="inline-flex items-center gap-2 text-13"><Checkbox checked={envs === null} onCheckedChange={(v) => setEnvs(v === true ? null : meta.environments.map((e) => e.key))} /> Every environment</label>
            {envs !== null && meta.environments.map((e) => (
              <label key={e.key} className="inline-flex items-center gap-2 pl-6 text-13"><Checkbox checked={envs.includes(e.key)} onCheckedChange={(v) => setEnvs(toggle(envs, e.key, v === true))} /> {e.name}</label>
            ))}
          </div>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Header" hint="Optional, e.g. Authorization for the other system’s API.">
            <Input className="h-[34px] font-mono text-13" value={header.name} onChange={(e) => setHeader({ ...header, name: e.target.value })} placeholder="Authorization" autoComplete="off" />
          </Field>
          <Field label="Its value" hint={webhook?.headerNames.length ? 'Leave empty to keep the saved one.' : 'Kept on the server, never shown again.'}>
            <Input className="h-[34px] font-mono text-13" type="password" value={header.value} onChange={(e) => setHeader({ ...header, value: e.target.value })} autoComplete="new-password" />
          </Field>
        </div>
        <ErrorList error={error} />
      </div>
    </Drawer>
  );
}

function InDrawer({ webhook, onClose, onSaved, onDelete, onNewAddress }: {
  webhook: WebhookIn | null; onClose: () => void; onSaved: (r: { webhook: WebhookIn; token?: string }) => void; onDelete?: () => void; onNewAddress?: () => void;
}) {
  const { meta } = useApp();
  const first = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(webhook?.name ?? '');
  const [env, setEnv] = useState(webhook?.environment ?? meta.environments[0]?.key ?? '');
  const [format, setFormat] = useState(webhook?.format ?? 'kv');
  const [expression, setExpression] = useState(webhook?.expression ?? SAMPLE_IN);
  const [createFlags, setCreateFlags] = useState(webhook?.createFlags ?? false);
  const { busy, error, run } = useAsync();
  const save = async () => {
    const body = { name, environment: env, format, expression: format === 'jsonata' ? expression : null, createFlags, flagSets: webhook?.flagSets ?? [] };
    const r = await run(() => webhook
      ? api<WebhookIn>('PUT', `${WEBHOOKS_PATH}/in/${webhook.id}`, body).then((w) => ({ webhook: w }))
      : api<{ webhook: WebhookIn; token: string }>('POST', `${WEBHOOKS_PATH}/in`, body));
    if (r) onSaved(r);
  };
  return (
    <Drawer open onClose={onClose} title={webhook ? `Edit ${webhook.name}` : 'Webhook in'} initialFocus={first}
      subtitle="Another system posts its values to this webhook’s address, and they’re imported like an import: at once, or as a request where approval is needed."
      footer={<>
        <Button disabled={busy || !name.trim() || !env} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        {onNewAddress && <><span className="flex-1" /><Button variant="secondary" onClick={onNewAddress}>New address</Button></>}
        {onDelete && <Button variant="secondary" onClick={onDelete}>Delete</Button>}
      </>}>
      <div className="grid gap-4">
        <Field label="Name" required><Input ref={first} className="h-[34px] text-13" value={name} onChange={(e) => setName(e.target.value)} placeholder="Old config service" /></Field>
        <Field label="Imports into">
          <NativeSelect className={selectField} value={env} onChange={(e) => setEnv(e.target.value)}>
            {meta.environments.map((e) => <option key={e.key} value={e.key}>{e.name}</option>)}
          </NativeSelect>
        </Field>
        <Field label="Format" hint={FORMAT_HINT[format]}>
          <NativeSelect className={selectField} value={format} onChange={(e) => setFormat(e.target.value)}>
            {FORMATS_IN.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
          </NativeSelect>
        </Field>
        {format === 'jsonata' && (
          <Field label="JSONata expression" hint="It gets each post’s JSON and makes a values document of it.">
            <textarea rows={4} value={expression} onChange={(e) => setExpression(e.target.value)} spellCheck={false} className={cn(textareaField, 'font-mono text-12')} />
          </Field>
        )}
        <label className="inline-flex items-center gap-2 text-13">
          <Checkbox checked={createFlags} onCheckedChange={(v) => setCreateFlags(v === true)} /> Create missing flags (in no flag set, so apps keep reading the old system)
        </label>
        <ErrorList error={error} />
      </div>
    </Drawer>
  );
}
