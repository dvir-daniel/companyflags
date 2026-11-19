import { useRef, useState } from 'react';
import { Button } from '@companyfeatures/ui/components/button';
import { Callout } from '@companyfeatures/ui/components/callout';
import { tableHeadClass, tableRowClass } from '@companyfeatures/ui/components/data-table';
import { Drawer } from '@companyfeatures/ui/components/drawer';
import { Input } from '@companyfeatures/ui/components/input';
import { NativeSelect } from '@companyfeatures/ui/components/native-select';
import { PageBar } from '@companyfeatures/ui/components/page-bar';
import { cn } from '@companyfeatures/ui/lib/utils';
import { api, type Meta, type User } from '../api.ts';
import { go, useApp } from '../app.ts';
import { plural } from '../text.ts';
import { Actions, Badge, Empty, ErrorList, Field, Heading, Modal } from '../ui.tsx';
import { copyText, useAsync } from '../uiKit.ts';
import { ROLE_OPTIONS, roleName, selectField, useRefresh } from './settingsKit.ts';
import { SingleSignOn } from './sso.tsx';
import { Cdn } from './cdn.tsx';
import { DimensionsSection } from './dimensions.tsx';
import { needsReview, roleInfo, ROLES } from '../../../server/policy.ts';

/*
 * Settings: what an admin sets up once. Environments (each flag has its own settings in each one),
 * apps (what flags are delivered to), dimensions (what config is served per: dimensions.tsx, #/settings/dimensions
 * scrolls to it) and people: who may sign in, and their roles. Everyone can see it; only admins change it.
 * People have a page of their own (People.tsx, #/settings/people): with single sign-on there can be hundreds.
 */

const approvalsText = (n: number) => (n === 0 ? 'None: changes go out at once' : `${plural(n, 'approval')} before a change goes out`);
const ENV_COLS = 'grid grid-cols-[minmax(0,1fr)_minmax(0,0.7fr)_minmax(0,1.4fr)_88px] max-md:grid-cols-[minmax(0,1fr)_88px]';
const APP_COLS = 'grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,auto)] max-md:grid-cols-[minmax(0,1fr)_minmax(0,auto)]';
const MD = 'max-md:hidden';

type Env = Meta['environments'][number];

// `section`: 'dimensions' opens the page at its Dimensions (the sidebar's way there before there are any)
export function Settings({ section }: { section?: string }) {
  const { meta } = useApp();
  const admin = roleInfo(meta.me.role).changesSettings;
  const [envDrawer, setEnvDrawer] = useState<{ env: Env | null } | null>(null);

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <PageBar title="Settings" count={admin ? undefined : 'Only admins can change these'} />
      <div className="grid gap-10 px-6 py-6 max-sm:px-4">
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
        </section>

        <AppsSection admin={admin} />

        <DimensionsSection admin={admin} focus={section === 'dimensions'} />

        <section aria-labelledby="s-people" className="grid gap-3">
          <Heading id="s-people" title="People" action={<Button variant="secondary" onClick={() => go('settings/people')}>{admin ? 'Manage people' : 'See everyone'}</Button>}>
            Who may sign in, and their roles. {admin ? 'Add people by email with their role: each gets an invite link to join. ' : 'An admin adds people and gives them a role. '}
            With single sign-on, people at your organization’s domains join on their own as viewers.
          </Heading>
          <PeopleSummary users={meta.users} />
        </section>

        <SingleSignOn />

        <Cdn />
      </div>

      {/* the forms are mounted only while open, so each opening starts fresh */}
      {envDrawer && <EnvironmentDrawer key={envDrawer.env?.key ?? 'new'} env={envDrawer.env} onClose={() => setEnvDrawer(null)} />}
    </div>
  );
}

/** Everyone at a glance: how many, by role, and who can't sign in yet. The list itself is on the People page. */
function PeopleSummary({ users }: { users: User[] }) {
  const can = users.filter((u) => u.status !== 'removed');
  const byRole = ROLES.map((r) => [r, can.filter((u) => u.role === r).length] as const).filter(([, n]) => n > 0);
  const invited = users.filter((u) => u.status === 'invited').length;
  const removed = users.length - can.length;
  return (
    <a href="#/settings/people" className="flex flex-wrap items-baseline gap-x-6 gap-y-2 border border-grid px-5 py-3.5 text-ink no-underline transition-colors duration-150 hover:bg-wash hover:no-underline max-sm:px-4">
      <span className="text-sm font-medium">{plural(can.length, 'person', 'people')}</span>
      {byRole.map(([r, n]) => {
        const role = roleName(r).toLowerCase();
        // "41 on call", but "200 viewers"
        return <span key={r} className="text-13 text-ink-2"><span className="font-mono text-ink">{n.toLocaleString()}</span> {n === 1 || r === 'oncall' ? role : `${role}s`}</span>;
      })}
      {invited > 0 && <span className="text-13 text-flag">{invited.toLocaleString()} invited</span>}
      {removed > 0 && <span className="text-13 text-ink-3">{removed.toLocaleString()} without access</span>}
    </a>
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
    </Drawer>
  );
}

type App = Meta['projects'][number];
const kindName = (k: App['kind']) => (k === 'client' ? 'an app' : 'a backend');
/** What has to be true before an app changes kind or goes (server/control.ts appUse): said before an admin tries. */
const IN_USE = 'no flag is sent to it, no API key for it still works, and no request waiting to go out would send it a flag';

/**
 * The apps flags are sent to. An admin adds one, changes its kind or deletes it; the server refuses the last two,
 * saying why, while anything uses the app. The key never changes: installed apps ask for their file with it.
 */
function AppsSection({ admin }: { admin: boolean }) {
  const { meta, toast, ask } = useApp();
  const refresh = useRefresh();
  const [drawer, setDrawer] = useState<{ app: App | null } | null>(null);
  const { error, setError, run } = useAsync();

  const remove = async (p: App) => {
    setError(null);
    const { action } = await ask({
      title: `Delete ${p.key}?`,
      body: <>
        <p>An app can only go once {IN_USE}. If something still uses it, nothing is deleted and you’ll see what to change first.</p>
        <p>{p.kind === 'client' ? 'An installed app that still asks for its file gets “not found”. ' : ''}Its revoked API keys go with it. History keeps every change to it.</p>
      </>,
      actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'delete', label: 'Delete app', tone: 'danger' }],
    });
    if (action !== 'delete') return;
    if (!(await run(() => api('DELETE', `/apps/${encodeURIComponent(p.key)}`)))) return;
    toast(`${p.key} deleted`);
    void refresh();
  };

  return (
    <section aria-labelledby="s-apps" className="grid gap-3">
      <Heading id="s-apps" title="Apps" action={admin && <Button onClick={() => setDrawer({ app: null })}>+ Add app</Button>}>
        What flags are sent to. Apps (Android, iOS, web) read a values-only file at their app link; backends download the rules with an API key.
        Use the same key in the app’s SDK.
      </Heading>
      <ErrorList error={error} />
      {meta.projects.length === 0 ? (
        <Empty action={admin ? <Button onClick={() => setDrawer({ app: null })}>+ Add app</Button> : undefined}>No apps yet.</Empty>
      ) : (
        <div role="table" aria-label="Apps">
          <div role="row" className={cn(APP_COLS, tableHeadClass)}>
            <span role="columnheader">Key</span><span role="columnheader" className={MD}>Kind</span><span />
          </div>
          {meta.projects.map((p) => (
            <div key={p.key} role="row" className={cn(APP_COLS, tableRowClass)}>
              <code role="cell" className="truncate font-mono text-13 font-medium">{p.key}</code>
              <span role="cell" className={cn(MD, 'text-13 text-ink-2')}>{p.kind === 'client' ? 'App: reads its file at an app link' : 'Backend: uses an API key'}</span>
              <span role="cell" className="flex justify-end gap-2">
                {admin && <>
                  <Button variant="secondary" aria-label={`Edit ${p.key}`} onClick={() => { setError(null); setDrawer({ app: p }); }}>Edit</Button>
                  <Button variant="secondary" aria-label={`Delete ${p.key}`} onClick={() => void remove(p)}>Delete</Button>
                </>}
              </span>
            </div>
          ))}
        </div>
      )}
      {/* mounted only while open (keyed by the app), so each opening starts fresh */}
      {drawer && <AppDrawer key={drawer.app?.key ?? 'new'} app={drawer.app} onClose={() => setDrawer(null)} />}
    </section>
  );
}

/** An app's form, new or to edit (its kind: the key can't change). Mounted only while open, so it starts fresh. */
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
      ? api<App>('PUT', `/apps/${encodeURIComponent(app.key)}`, { kind })
      : api<App>('POST', '/apps', { key, kind }));
    if (!r) return;
    toast(app ? `${r.key} is now ${kindName(r.kind)}` : `${r.key} added`);
    onClose();
    void refresh();
  };
  return (
    <Drawer open onClose={onClose} title={app ? `Edit ${app.key}` : 'New app'} initialFocus={app ? kindSelect : first}
      footer={<>
        <Button disabled={busy || !key} onClick={save}>{busy ? 'Saving…' : app ? 'Save' : 'Add app'}</Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
      </>}>
      <div className="grid gap-4">
        <Field label="Key" required hint={app
          ? 'The key can’t change: installed apps ask for their file with it, and API keys are made for it. To use another key, add a new app.'
          : 'Lowercase letters, digits and dashes, e.g. android, ios, web, checkout-api.'}>
          <Input ref={first} className="h-[34px] font-mono text-13" value={key} disabled={!!app} onChange={(e) => setKey(e.target.value.toLowerCase())} placeholder="android" />
        </Field>
        <Field label="Kind" hint={app ? `The kind can change only while ${IN_USE}.` : undefined}>
          <NativeSelect ref={kindSelect} className={selectField} value={kind} onChange={(e) => setKind(e.target.value as App['kind'])}>
            <option value="client">App (Android, iOS, web): reads its file at an app link</option>
            <option value="server">Backend: downloads the rules with an API key</option>
          </NativeSelect>
        </Field>
        <ErrorList error={error} />
      </div>
    </Drawer>
  );
}

const SETUP_STEPS: [string, string][] = [
  ['Environments', 'Where flags live, such as Development and Production. Production can require an approval for every change.'],
  ['Apps', 'What reads flags: your web, iOS and Android apps (each reads its file), and backends (each with an API key).'],
  ['Dimensions', 'What config is served per, in your own words: one level, or a chain such as region › chain › store.'],
  ['Your first flag', 'An on/off switch, a value that differs per entity, or a release that reaches a % of devices step by step.'],
];

/** Shown on every page until there is an environment to work in: sample data to explore with, or the steps to set up. */
export function GetStarted() {
  const { meta, reload, toast } = useApp();
  const admin = roleInfo(meta.me.role).changesSettings;
  const [busy, setBusy] = useState(false);
  const addSample = async () => {
    setBusy(true);
    try {
      await api('POST', '/sample-data');
      await reload();
      toast('Sample data added: open a flag to see how it decides');
      go('flags');
    } catch (e) {
      toast(e as Error, 'err');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid max-w-[680px] content-start gap-8 p-12 max-sm:p-6">
      <div className="grid gap-3">
        <h1 className="m-0 text-[28px] leading-tight font-semibold text-ink">Welcome to CompanyFeatures</h1>
        <p className="m-0 text-15 text-subtitle">Feature flags and remote config, served per region, store or whatever your business is made of.</p>
      </div>
      {admin ? <>
        <section className="grid gap-3 border border-rule bg-panel p-5">
          <h2 className="m-0 text-15 font-semibold text-ink">Explore with sample data</h2>
          <p className="m-0 text-13 text-ink-2">
            A made-up installation: Development and Production, three apps and a backend, two dimensions with eight
            entities, and flags that show each part (a release to 10% of devices, a kill switch, a setting the entities
            below follow).
            It is ordinary data: change or delete any of it later.
          </p>
          <div><Button disabled={busy} onClick={addSample}>{busy ? 'Adding…' : 'Add sample data'}</Button></div>
        </section>
        <section className="grid gap-3">
          <h2 className="m-0 text-15 font-semibold text-ink">Or set it up yourself</h2>
          <ol className="m-0 grid list-none gap-0 p-0">
            {SETUP_STEPS.map(([title, text], i) => (
              <li key={title} className="grid grid-cols-[28px_1fr] gap-3 border-t border-rule py-3 last:border-b">
                <span className="font-mono text-13 text-ink-3">{String(i + 1).padStart(2, '0')}</span>
                <span className="grid gap-0.5"><span className="text-13 font-medium text-ink">{title}</span><span className="text-13 text-ink-2">{text}</span></span>
              </li>
            ))}
          </ol>
          <div><Button variant="secondary" onClick={() => go('settings')}>Open settings</Button></div>
        </section>
      </> : (
        <Callout>An admin needs to add the environments and apps first. You’re signed in as {meta.me.key}, a {roleName(meta.me.role).toLowerCase()}.</Callout>
      )}
    </div>
  );
}
