import { useRef, useState } from 'react';
import { Button } from '@companyflags/ui/components/button';
import { tableHeadClass, tableRowClass } from '@companyflags/ui/components/data-table';
import { Drawer, DrawerSection } from '@companyflags/ui/components/drawer';
import { Input } from '@companyflags/ui/components/input';
import { NativeSelect } from '@companyflags/ui/components/native-select';
import { PageBar } from '@companyflags/ui/components/page-bar';
import { cn } from '@companyflags/ui/lib/utils';
import { api, type Meta, type User } from '../api.ts';
import { go, useApp } from '../app.ts';
import { plural } from '../text.ts';
import { Actions, Badge, Empty, ErrorList, Field, Heading, Modal } from '../ui.tsx';
import { copyText, useAsync } from '../uiKit.ts';
import { everyoneFilePath } from '../paths.ts';
import { ROLE_OPTIONS, selectField, SETTINGS, settingsKey, useRefresh } from './settingsKit.ts';
import { SingleSignOn } from './sso.tsx';
import { Cdn } from './cdn.tsx';
import { DimensionsSection } from './dimensions.tsx';
import { AppearanceSection } from './appearance.tsx';
import { needsReview, roleInfo } from '../../../server/policy.ts';

/*
 * Settings: what an admin sets up once, one page each (#/settings/<page>, settingsKit.ts SETTINGS), with Settings' own
 * menu beside them (settingsFrame.tsx): environments (each flag has its own settings in each one), dimensions (what
 * config is served per: dimensions.tsx), services (what reads flags, each with its own keys), people (People.tsx),
 * single sign-on (sso.tsx), appearance (appearance.tsx) and the CDN (cdn.tsx). Everyone can see them; only admins
 * change them.
 */

const approvalsText = (n: number) => (n === 0 ? 'None: changes go out at once' : `${plural(n, 'approval')} before a change goes out`);
const ENV_COLS = 'grid grid-cols-[minmax(0,1fr)_minmax(0,0.7fr)_minmax(0,1.4fr)_88px] max-md:grid-cols-[minmax(0,1fr)_88px]';
const APP_COLS = 'grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,auto)] max-md:grid-cols-[minmax(0,1fr)_minmax(0,auto)]';
const MD = 'max-md:hidden';

type Env = Meta['environments'][number];

// One page of Settings (settingsFrame.tsx draws the menu beside it): `section` is the address's second part.
export function Settings({ section }: { section?: string }) {
  const { meta } = useApp();
  const admin = roleInfo(meta.me.role).changesSettings;
  const at = settingsKey(section);
  const label = SETTINGS.find((s) => s.key === at)?.label ?? 'Settings';
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <PageBar crumbs={<a href="#/settings" className="text-ink-3 no-underline hover:text-ink hover:no-underline">Settings</a>} title={label}
        count={admin ? undefined : 'Only admins can change these'} />
      <div className="grid gap-10 px-6 py-6 max-sm:px-4">
        {at === 'environments' && <><EnvironmentsSection admin={admin} /><TokensNote admin={admin} /></>}
        {at === 'dimensions' && <DimensionsSection admin={admin} />}
        {at === 'services' && <ServicesSection admin={admin} />}
        {at === 'sso' && <SingleSignOn />}
        {at === 'appearance' && <AppearanceSection />}
        {/* the Cloudflare plugin's settings (server/plugins/cloudflare.ts), when this server runs it */}
        {at === 'cdn' && (meta.plugins?.includes('cloudflare') ? <Cdn /> : <Empty>This server runs without the Cloudflare plugin.</Empty>)}
      </div>
    </div>
  );
}

function EnvironmentsSection({ admin }: { admin: boolean }) {
  const { meta } = useApp();
  const [envDrawer, setEnvDrawer] = useState<{ env: Env | null } | null>(null);
  return (
    <section aria-labelledby="s-env" className="grid gap-3">
      <Heading id="s-env" title="Environments" action={admin && <Button onClick={() => setEnvDrawer({ env: null })}>+ Add environment</Button>}>
        Each flag has its own settings in each environment. Where approvals are needed, changes are reviewed and confirmed before they go out.
      </Heading>
      {meta.environments.length === 0 ? (
        <Empty action={admin ? <Button onClick={() => setEnvDrawer({ env: null })}>+ Add environment</Button> : undefined}>
          No environments yet. Most teams start with Development and Production.
        </Empty>
      ) : (
        <div role="table" aria-label="Environments">
          <div role="row" className={cn(ENV_COLS, tableHeadClass)}>
            <span role="columnheader">Name</span><span role="columnheader" className={MD}>Key</span>
            <span role="columnheader" className={MD}>Approvals</span><span />
          </div>
          {meta.environments.map((e) => (
            <div key={e.key} role="row" className={cn(ENV_COLS, tableRowClass)}>
              <span role="cell" className="min-w-0 truncate font-medium">{e.name}</span>
              <code role="cell" className={cn(MD, 'truncate font-mono text-13 text-ink-2')}>{e.key}</code>
              <span role="cell" className={cn(MD, 'text-13 text-ink-2')}>{needsReview(e) ? <Badge kind="danger">{approvalsText(e.minApprovals)}</Badge> : approvalsText(0)}</span>
              <span role="cell" className="text-right">{admin && <Button variant="secondary" onClick={() => setEnvDrawer({ env: e })}>Edit</Button>}</span>
            </div>
          ))}
        </div>
      )}
      {/* the form is mounted only while open, so each opening starts fresh */}
      {envDrawer && <EnvironmentDrawer key={envDrawer.env?.key ?? 'new'} env={envDrawer.env} onClose={() => setEnvDrawer(null)} />}
    </section>
  );
}

/** Where access tokens are: each person's own, from their account menu. */
function TokensNote({ admin }: { admin: boolean }) {
  return (
    <section aria-labelledby="s-tokens" className="grid gap-3">
      <Heading id="s-tokens" title="Access tokens" action={<Button variant="secondary" onClick={() => go('tokens')}>{admin ? 'Manage tokens' : 'Your tokens'}</Button>}>
        A token acts as you, with a role up to yours, for scripts, the CLI and MCP clients. Everyone makes their own from their account menu{admin ? '; you can see and revoke everyone’s' : ''}.
      </Heading>
    </section>
  );
}

export function PersonDrawer({ onClose, onAdded }: { onClose: () => void; onAdded: (u: User, invite: string) => void }) {
  const refresh = useRefresh();
  const first = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('viewer');
  const { busy, error, run } = useAsync();
  const save = async () => {
    const r = await run(() => api<User & { invite: string }>('POST', '/people', { email, name, role }));
    if (!r) return;
    onAdded(r, r.invite);              // the link shows once: before anything else can fail
    void refresh();
  };
  return (
    <Drawer open onClose={onClose} title="Add a person" initialFocus={first}
      subtitle="They get an invite link to make their account. It works once, for 7 days."
      footer={<>
        <Button disabled={busy || !email.trim()} onClick={save}>{busy ? 'Adding…' : 'Add and get link'}</Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
      </>}>
      <div className="grid gap-4">
        <Field label="Email" required hint="If Google, GitHub or Microsoft sign-in is set up, they can also use it with this email instead of the link.">
          <Input ref={first} type="email" className="h-[34px] text-13" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="sam@example.com" />
        </Field>
        <Field label="Name" hint="Optional: they can give their own when they join.">
          <Input className="h-[34px] text-13" value={name} onChange={(e) => setName(e.target.value)} placeholder="Sam Lee" />
        </Field>
        <Field label="Role">
          <NativeSelect className={selectField} value={role} onChange={(e) => setRole(e.target.value)}>
            {ROLE_OPTIONS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </NativeSelect>
        </Field>
        <ErrorList error={error} />
      </div>
    </Drawer>
  );
}

/** An invite link, shown once: only its hash is kept on the server. */
export function InviteLink({ person, invite, onClose }: { person: User; invite: string; onClose: () => void }) {
  const { toast } = useApp();
  const url = `${location.origin}${location.pathname}#/join/${invite}`;
  return (
    <Modal title={`Invite link for ${person.name === person.key ? person.key : person.name}`} onClose={onClose} footer={
      <Actions>
        <Button variant="secondary" onClick={onClose}>Done</Button>
        <Button onClick={() => void copyText(url, 'the invite link', toast)}>Copy link</Button>
      </Actions>
    }>
      <p className="m-0 text-sm text-ink-1">Send this to {person.key}. It works once, for 7 days, and only for this email. You won’t see it again: if it gets lost, make a new one.</p>
      <Input readOnly value={url} data-autofocus onFocus={(e) => e.currentTarget.select()} className="h-[34px] font-mono text-11" aria-label="Invite link" />
    </Modal>
  );
}

/** A password reset link an admin made for someone (People → Reset password), shown once. */
export function ResetLink({ person, token, onClose }: { person: User; token: string; onClose: () => void }) {
  const { toast } = useApp();
  const url = `${location.origin}${location.pathname}#/reset/${token}`;
  return (
    <Modal title={`Password reset link for ${person.name === person.key ? person.key : person.name}`} onClose={onClose} footer={
      <Actions>
        <Button variant="secondary" onClick={onClose}>Done</Button>
        <Button onClick={() => void copyText(url, 'the reset link', toast)}>Copy link</Button>
      </Actions>
    }>
      <p className="m-0 text-sm text-ink-1">Send this to {person.key}. It works once, for a day: they choose a new password and are signed out everywhere. You won’t see it again.</p>
      <Input readOnly value={url} data-autofocus onFocus={(e) => e.currentTarget.select()} className="h-[34px] font-mono text-11" aria-label="Password reset link" />
    </Modal>
  );
}

/** An environment's form, new or to edit. Mounted only while open (keyed by the environment), so it starts fresh. */
function EnvironmentDrawer({ env, onClose }: { env: Env | null; onClose: () => void }) {
  const { toast } = useApp();
  const refresh = useRefresh();
  const first = useRef<HTMLInputElement>(null);
  const [key, setKey] = useState(env?.key ?? '');
  const [name, setName] = useState(env?.name ?? '');
  const [approvals, setApprovals] = useState(env?.minApprovals ?? 0);
  const { busy, error, run } = useAsync();
  // the key follows the name until it's typed in by hand
  const [keyTouched, setKeyTouched] = useState(false);
  const onName = (v: string) => {
    setName(v);
    if (!env && !keyTouched) setKey(v.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, ''));
  };
  const save = async () => {
    const r = await run(() => env
      ? api('PUT', `/environments/${env.key}`, { name, minApprovals: approvals })
      : api('POST', '/environments', { key, name, minApprovals: approvals }));
    if (!r) return;
    toast(env ? `${r.name} saved` : `${r.name} added. Every flag starts off there.`);
    onClose();
    void refresh();
  };
  return (
    <Drawer open onClose={onClose} title={env ? `Edit ${env.name}` : 'New environment'} initialFocus={first}
      subtitle={env ? undefined : 'Every flag gets its own settings here, starting off.'}
      footer={<>
        <Button disabled={busy || !name.trim() || (!env && !key)} onClick={save}>{busy ? 'Saving…' : env ? 'Save' : 'Add environment'}</Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
      </>}>
      <div className="grid gap-4">
        <Field label="Name" required>
          <Input ref={first} className="h-[34px] text-13" value={name} onChange={(e) => onName(e.target.value)} placeholder="Production" />
        </Field>
        <Field label="Key" required hint={env ? 'The key can’t change: apps and API keys use it.' : 'Used in app links and API keys. Lowercase letters, digits and dashes.'}>
          <Input className="h-[34px] font-mono text-13" value={key} disabled={!!env} onChange={(e) => { setKey(e.target.value); setKeyTouched(true); }} placeholder="production" />
        </Field>
        <Field label="Approvals needed" hint="Changes here wait for this many reviewers, and the author can’t review their own.">
          <NativeSelect className={selectField} value={String(approvals)} onChange={(e) => setApprovals(Number(e.target.value))}>
            {[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{approvalsText(n)}</option>)}
          </NativeSelect>
        </Field>
        <ErrorList error={error} />
      </div>
      {env && <ReplaceLinks env={env} />}
    </Drawer>
  );
}

/** Every app link and app token in one environment replaced at once (server/control.ts rotateEnvironmentLinks), for
 *  when one may have leaked. Admins only, like the drawer it's in. */
function ReplaceLinks({ env }: { env: Env }) {
  const { toast, ask } = useApp();
  const { busy, error, run } = useAsync();
  const replace = async () => {
    const { action } = await ask({
      title: `Replace every link in ${env.name}?`,
      body: <>
        <p>Every app link and app token in {env.name} stops working at once. Apps get new ones from your backend at their next sign-in.</p>
        <p>Links in other environments stay as they are. History keeps a note of it.</p>
      </>,
      actions: [{ id: 'keep', label: 'Keep the links' }, { id: 'replace', label: 'Replace every link', tone: 'danger' }],
    });
    if (action !== 'replace') return;
    if (!(await run(() => api('POST', `/environments/${encodeURIComponent(env.key)}/links/rotate`)))) return;
    toast(`Replaced every app link in ${env.name}`);
  };
  return (
    <DrawerSection title="App links" className="mt-8 border-t border-rule pt-5">
      <div className="grid gap-3">
        <p className="m-0 text-13 text-ink-2">If an app link or token may have leaked, replace them all here. Each entry’s own link can be replaced on its page.</p>
        <ErrorList error={error} />
        <span className="flex"><Button variant="stop" disabled={busy} onClick={() => void replace()}>{busy ? 'Replacing…' : 'Replace every link in this environment'}</Button></span>
      </div>
    </DrawerSection>
  );
}

type App = Meta['projects'][number];
const kindName = (k: App['kind']) => (k === 'client' ? 'an app' : 'a backend');
/** What has to be true before a service changes kind or goes (server/control.ts appUse): said before an admin tries. */
const IN_USE = 'no flag is in it, no API key for it still works, and no request waiting to go out would put a flag in it';

/**
 * The services flags are sent in. An admin adds one, changes its kind or deletes it; the server refuses the last two,
 * saying why, while anything uses the service. The key never changes: installed apps ask for their file with it.
 */
function ServicesSection({ admin }: { admin: boolean }) {
  const { meta, toast, ask } = useApp();
  const refresh = useRefresh();
  const [drawer, setDrawer] = useState<{ app: App | null } | null>(null);
  const [fileOf, setFileOf] = useState<string | null>(null);
  const { error, setError, run } = useAsync();
  // the app-files plugin serves each app service's file for everyone (server/delivery.ts), with no entry needed
  const files = meta.plugins?.includes('app-files') ?? true;

  const remove = async (p: App) => {
    setError(null);
    const { action } = await ask({
      title: `Delete ${p.key}?`,
      body: <>
        <p>A service can only go once {IN_USE}. If something still uses it, nothing is deleted and you’ll see what to change first.</p>
        <p>{p.kind === 'client' ? 'An installed app that still asks for its file gets “not found”. ' : ''}Its revoked API keys go with it. History keeps every change to it.</p>
      </>,
      actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'delete', label: 'Delete service', tone: 'danger' }],
    });
    if (action !== 'delete') return;
    if (!(await run(() => api('DELETE', `/services/${encodeURIComponent(p.key)}`)))) return;
    toast(`${p.key} deleted`);
    void refresh();
  };

  return (
    <section aria-labelledby="s-services" className="grid gap-3">
      <Heading id="s-services" title="Services" action={admin && <Button onClick={() => setDrawer({ app: null })}>+ Add service</Button>}>
        What reads your flags: each app (Android, iOS, web) and each backend. A service reads only the flags you put in it, with
        its own key in each environment (API keys): an app’s key reads values only, a backend’s key reads the rules.
      </Heading>
      <ErrorList error={error} />
      {meta.projects.length === 0 ? (
        <Empty action={admin ? <Button onClick={() => setDrawer({ app: null })}>+ Add service</Button> : undefined}>No services yet.</Empty>
      ) : (
        <div role="table" aria-label="Services">
          <div role="row" className={cn(APP_COLS, tableHeadClass)}>
            <span role="columnheader">Key</span><span role="columnheader" className={MD}>Kind</span><span />
          </div>
          {meta.projects.map((p) => (
            <div key={p.key} role="row" className={cn(APP_COLS, tableRowClass)}>
              <code role="cell" className="truncate font-mono text-13 font-medium">{p.key}</code>
              <span role="cell" className={cn(MD, 'text-13 text-ink-2')}>{p.kind === 'client' ? 'App: gets values only' : 'Backend: gets the rules'}</span>
              <span role="cell" className="flex justify-end gap-2">
                {files && p.kind === 'client' && <Button variant="secondary" aria-label={`Link to ${p.key}’s file for everyone`} onClick={() => setFileOf(p.key)}>Link</Button>}
                {admin && <>
                  <Button variant="secondary" aria-label={`Edit ${p.key}`} onClick={() => { setError(null); setDrawer({ app: p }); }}>Edit</Button>
                  <Button variant="secondary" aria-label={`Delete ${p.key}`} onClick={() => void remove(p)}>Delete</Button>
                </>}
              </span>
            </div>
          ))}
        </div>
      )}
      {/* mounted only while open (keyed by the service), so each opening starts fresh */}
      {drawer && <AppDrawer key={drawer.app?.key ?? 'new'} app={drawer.app} onClose={() => setDrawer(null)} />}
      {fileOf && <EveryoneFile service={fileOf} onClose={() => setFileOf(null)} />}
    </section>
  );
}

/** A service's file for everyone, in each environment: what an app reads before it knows who is signed in, and the
 *  only file there is until the dimensions have an entry. Each entry's own link is on its page. */
function EveryoneFile({ service, onClose }: { service: string; onClose: () => void }) {
  const { meta, toast } = useApp();
  return (
    <Drawer open onClose={onClose} title={`${service}: the file for everyone`} subtitle="The values everyone gets, with no entry’s own settings"
      footer={<Button variant="secondary" onClick={onClose}>Done</Button>}>
      <div className="grid gap-4 text-13 text-ink-2">
        <p className="m-0">An app reads this before it knows who is signed in. Then it uses its entry’s own link, from the entry’s page (App link). Each environment has its own file.</p>
        {meta.environments.map((e) => {
          const url = `${location.origin}${everyoneFilePath(e.key, service)}`;
          return (
            <Field key={e.key} label={e.name}>
              <span className="flex min-w-0 items-center gap-2">
                <Input readOnly value={url} onFocus={(ev) => ev.target.select()} className="h-[34px] font-mono text-13" />
                <Button variant="secondary" aria-label={`Copy the link for ${e.name}`} onClick={() => void copyText(url, 'the link', toast)}>Copy</Button>
              </span>
            </Field>
          );
        })}
      </div>
    </Drawer>
  );
}

/** A service's form, new or to edit (its kind: the key can't change). Mounted only while open, so it starts fresh. */
function AppDrawer({ app, onClose }: { app: App | null; onClose: () => void }) {
  const { toast } = useApp();
  const refresh = useRefresh();
  const first = useRef<HTMLInputElement>(null);
  const kindSelect = useRef<HTMLSelectElement>(null);
  const [key, setKey] = useState(app?.key ?? '');
  const [kind, setKind] = useState<App['kind']>(app?.kind ?? 'client');
  const { busy, error, run } = useAsync();
  const save = async () => {
    if (app && kind === app.kind) { onClose(); return; }
    const r = await run(() => app
      ? api<App>('PUT', `/services/${encodeURIComponent(app.key)}`, { kind })
      : api<App>('POST', '/services', { key, kind }));
    if (!r) return;
    toast(app ? `${r.key} is now ${kindName(r.kind)}` : `${r.key} added`);
    onClose();
    void refresh();
  };
  return (
    <Drawer open onClose={onClose} title={app ? `Edit ${app.key}` : 'New service'} initialFocus={app ? kindSelect : first}
      footer={<>
        <Button disabled={busy || !key} onClick={save}>{busy ? 'Saving…' : app ? 'Save' : 'Add service'}</Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
      </>}>
      <div className="grid gap-4">
        <Field label="Key" required hint={app
          ? 'The key can’t change: installed apps ask for their file with it, and API keys are made for it. To use another key, add a new service.'
          : 'Lowercase letters, digits and dashes, e.g. android, ios, web, checkout-api.'}>
          <Input ref={first} className="h-[34px] font-mono text-13" value={key} disabled={!!app} onChange={(e) => setKey(e.target.value.toLowerCase())} placeholder="android" />
        </Field>
        <Field label="Kind" hint={app ? `The kind can change only while ${IN_USE}.` : undefined}>
          <NativeSelect ref={kindSelect} className={selectField} value={kind} onChange={(e) => setKind(e.target.value as App['kind'])}>
            <option value="client">App (Android, iOS, web): gets values only</option>
            <option value="server">Backend: gets the rules</option>
          </NativeSelect>
        </Field>
        <ErrorList error={error} />
      </div>
    </Drawer>
  );
}
