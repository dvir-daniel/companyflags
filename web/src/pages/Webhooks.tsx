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
  EVENT_NAMES, FORMAT_HINT, FORMATS_IN, incomingUrl, lastDelivery, offBecause, OUT_FORMAT_HINT, OUT_FORMATS, SAMPLE_IN, SAMPLE_OUT,
  WEBHOOKS_PATH, type WebhookIn, type WebhookList, type WebhookOut,
} from './migrationKit.ts';

/*
 * Webhooks (server/webhooks.ts, the webhooks plugin): out, this server tells an address each change made here (signed
 * JSON, a Slack message, or your own shape with JSONata), for chat, CI, an audit log or another system; in, another
 * system posts its values here and they're imported. Everyone can see them; admins add and change them.
 */

const selectField = 'w-full [&_select]:h-[34px] [&_select]:text-13';

export function Webhooks() {
  const { meta } = useApp();
  const admin = roleInfo(meta.me.role).changesSettings;
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <PageBar title="Webhooks" count={admin ? undefined : 'Only admins can change these'} />
      <div className="grid gap-10 px-6 py-6 max-sm:px-4">
        {meta.plugins.includes('webhooks')
          ? <WebhooksSection admin={admin} />
          : <Empty>This server runs without the webhooks plugin. Add <code className="font-mono">webhooks()</code> to the plugins in companyflags.config.ts.</Empty>}
      </div>
    </div>
  );
}

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
      <Heading id="m-hooks" title="Out and in" action={admin && <div className="flex gap-2">
        <Button variant="secondary" onClick={() => setDrawer({ in: null })}>+ Add webhook in</Button>
        <Button onClick={() => setDrawer({ out: null })}>+ Add webhook out</Button>
      </div>}>
        Out: after each change, this server tells an address what changed (signed JSON, a Slack message, or your own shape). In: another system posts its values here, and they’re imported.
      </Heading>
      <ErrorList error={error} />
      {list && !list.reachable && <Callout>This server doesn’t send webhooks out: it was started without network access for them.</Callout>}
      {list && (
        <>
          <span className="text-13 font-medium">Out</span>
          {list.webhooks.length === 0 ? <Empty>No webhooks out. Add one to post each change to Slack, Teams, CI, an audit log or another system.</Empty> : (
            <div role="table" aria-label="Webhooks out">
              <div role="row" className={cn(OUT_COLS, tableHeadClass)}>
                <span role="columnheader">Name</span><span role="columnheader" className={MD}>Sends</span><span role="columnheader" className={MD}>Last delivery</span><span />
              </div>
              {list.webhooks.map((w) => {
                const last = lastDelivery(w);
                const off = offBecause(w);
                return (
                  <div key={w.id} role="row" className={cn(OUT_COLS, tableRowClass)}>
                    <span role="cell" className="grid min-w-0">
                      <span className="truncate font-medium">{w.name}</span>
                      <span className="truncate font-mono text-xs text-ink-3">{w.method} {w.host}</span>
                    </span>
                    <span role="cell" className={cn(MD, 'text-13 text-ink-2')}>
                      {w.events.map((e) => EVENT_NAMES[e] ?? e).join(' and ')} · {w.environments ? w.environments.map(envName).join(', ') : 'every environment'}
                      {' · '}{OUT_FORMATS.find(([k]) => k === w.format)?.[1] ?? w.format}
                    </span>
                    <span role="cell" className={cn(MD, 'min-w-0 truncate text-13')} title={w.lastError ?? undefined}>
                      {off ? <Badge kind="danger">Switched off</Badge>
                        : last.tone === 'bad' ? <Badge kind="danger" title={last.text}>{w.nextAttemptAt ? 'Failed: tries again' : 'Failed'}</Badge>
                        : <span className={last.tone === 'ok' ? 'text-ink-2' : 'text-ink-3'}>{last.text}{last.tone === 'ok' && w.lastSentAt && <> · <When iso={w.lastSentAt} /></>}</span>}
                    </span>
                    <span role="cell" className="flex items-center justify-end gap-2">
                      {admin && <>
                        <Switch checked={w.enabled} label={`${w.name} on`} onChange={(v) => void act(() => api('PUT', `${WEBHOOKS_PATH}/${w.id}`, { enabled: v }), v ? `${w.name} is on: it sends changes from now` : `${w.name} is off`)} />
                        <Button variant="secondary" onClick={() => void test(w)}>Test</Button>
                        <Button variant="secondary" onClick={() => setDrawer({ out: w })}>Edit</Button>
                      </>}
                    </span>
                    {/* why it's off, said in full on every screen (a runaway expression switches a webhook off) */}
                    {off && <Callout role="cell" tone="error" className="col-span-full mb-1">{off}</Callout>}
                  </div>
                );
              })}
            </div>
          )}
          <span className="text-13 font-medium">In</span>
          {list.incoming.length === 0 ? <Empty>No webhooks in. Add one for another system to post its values to, such as the one you’re moving from.</Empty> : (
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
    <Drawer open onClose={onClose} title={webhook ? `Edit ${webhook.name}` : 'New webhook out'} initialFocus={first}
      subtitle="After each change, this server posts what changed to this address. One that’s down is tried again later, and holds up only itself."
      footer={<>
        <Button disabled={busy || !ready} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        {onNewSecret && <><span className="flex-1" /><Button variant="secondary" onClick={onNewSecret}>New secret</Button></>}
        {onDelete && <Button variant="secondary" onClick={onDelete}>Delete</Button>}
      </>}>
      <div className="grid gap-4">
        {webhook && offBecause(webhook) && <Callout tone="error">{offBecause(webhook)}</Callout>}
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
            <textarea rows={4} value={expression} onChange={(e) => setExpression(e.target.value)} spellCheck={false} className={cn(textareaField, 'font-mono text-xs')} />
          </Field>
        )}
        <Field label="Sends">
          <div className="grid gap-1.5">
            <label className="inline-flex items-center gap-2 text-13"><Checkbox checked={events.includes('changes')} onCheckedChange={(v) => setEvents(toggle(events, 'changes', v === true))} /> Changes: what an environment serves</label>
            <label className="inline-flex items-center gap-2 text-13"><Checkbox checked={events.includes('reviews')} onCheckedChange={(v) => setEvents(toggle(events, 'reviews', v === true))} /> Reviews: a request made, approved, rejected or scheduled</label>
            <label className="inline-flex items-center gap-2 text-13"><Checkbox checked={events.includes('security')} onCheckedChange={(v) => setEvents(toggle(events, 'security', v === true))} /> Security events, for a SIEM: sign-ins and failed ones, people and roles, tokens, keys, single sign-on (every environment’s)</label>
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
    const body = { name, environment: env, format, expression: format === 'jsonata' ? expression : null, createFlags, services: webhook?.services ?? [] };
    const r = await run(() => webhook
      ? api<WebhookIn>('PUT', `${WEBHOOKS_PATH}/in/${webhook.id}`, body).then((w) => ({ webhook: w }))
      : api<{ webhook: WebhookIn; token: string }>('POST', `${WEBHOOKS_PATH}/in`, body));
    if (r) onSaved(r);
  };
  return (
    <Drawer open onClose={onClose} title={webhook ? `Edit ${webhook.name}` : 'New webhook in'} initialFocus={first}
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
            <textarea rows={4} value={expression} onChange={(e) => setExpression(e.target.value)} spellCheck={false} className={cn(textareaField, 'font-mono text-xs')} />
          </Field>
        )}
        <label className="inline-flex items-center gap-2 text-13">
          <Checkbox checked={createFlags} onCheckedChange={(v) => setCreateFlags(v === true)} /> Create missing flags (in no service, so apps keep reading the old system)
        </label>
        <ErrorList error={error} />
      </div>
    </Drawer>
  );
}
