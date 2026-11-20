import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@companyflags/ui/components/button';
import { Callout } from '@companyflags/ui/components/callout';
import { tableHeadClass, tableRowClass } from '@companyflags/ui/components/data-table';
import { Drawer } from '@companyflags/ui/components/drawer';
import { Input } from '@companyflags/ui/components/input';
import { NativeSelect } from '@companyflags/ui/components/native-select';
import { cn } from '@companyflags/ui/lib/utils';
import { api, peek } from '../api.ts';
import { authClient } from '../authClient.ts';
import { Bone } from '../loading.tsx';
import { SSO_PATH } from '../paths.ts';
import { useApp } from '../app.ts';
import { Badge, Collapsible, Empty, ErrorList, Field, Heading, Switch, When } from '../ui.tsx';
import { copyText, textareaField, useAsync } from '../uiKit.ts';
import { roleInfo } from '../../../server/policy.ts';
import { groupLines, JOIN_ROLES, readGroupLines, RULES_PATH, serviceProvider, type Connection, type SignInRules, type SsoState } from './ssoKit.ts';

/*
 * Settings → Single sign-on (server/sso.ts): connections to your organization's identity provider, OIDC or SAML,
 * each for its email domains, and the organization's sign-in rules (server/access.ts): the break-glass admin,
 * two-factor sign-in for admins, and the role people get when they join without an invite.
 * A connection can require single sign-on once someone has signed in with it (Test sign-in): then nobody at its
 * domains uses a password but the break-glass admin, and each session there lasts 12 hours at most
 * (FF_SSO_SESSION_HOURS), so someone removed from the identity provider is out of the console by then.
 */

const COLS = 'grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,auto)] max-md:grid-cols-[minmax(0,1fr)_minmax(0,auto)]';
const MD = 'max-md:hidden';
const selectField = 'w-full [&_select]:h-[34px] [&_select]:text-13';

export function SingleSignOn() {
  const { meta, toast, ask } = useApp();
  const admin = roleInfo(meta.me.role).changesSettings;
  // the last answer while a fresh one loads (navigation fetches it first: paths.ts)
  const [state, setState] = useState<SsoState | null>(() => peek<SsoState>(SSO_PATH) ?? null);
  const [rules, setRules] = useState<SignInRules | null>(null);
  const [drawer, setDrawer] = useState<{ editing: Connection | null } | null>(null);
  const { error, setError, run } = useAsync();
  // only the newest load's answer is shown: an older one that comes back late (after an add or a remove) is ignored
  const latest = useRef(0);
  const load = useCallback(() => {
    const id = ++latest.current;
    void api<SignInRules>('GET', RULES_PATH).then(setRules, () => {});
    return api<SsoState>('GET', SSO_PATH).then((r) => { if (id === latest.current) setState(r); }, (e) => { if (id === latest.current) setError({ message: e.message }); });
  }, [setError]);
  useEffect(() => { void load(); }, [load]);
  const nameOf = (key: string | null) => (key ? meta.users.find((u) => u.key === key)?.name ?? key : null);

  const toggle = async (c: Connection, requireSso: boolean) => {
    setError(null);
    const where = c.domains.join(', ');
    if (requireSso) {
      const kept = nameOf(rules?.breakGlassAdmin ?? null);
      const { action } = await ask({
        title: `Require single sign-on for ${where}?`,
        body: <>
          <p>Everyone at {where} is signed out now, and signs in again with {c.id}. Passwords and Google, GitHub or Microsoft stop working there.</p>
          <p>Each session there lasts 12 hours at most: someone removed from your identity provider is out of the console by then. Their access tokens keep working until they expire: remove people in People when they leave.</p>
          {kept ? <p><b className="font-medium">{kept}</b> keeps their password, as the break-glass admin, in case {c.id} is down.</p>
            : <p><b className="font-medium">Nobody keeps a password.</b> If {c.id} is down, nobody at {where} can sign in. Choose a break-glass admin below first, unless that’s what you want.</p>}
        </>,
        actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'require', label: 'Require single sign-on', tone: 'danger' }],
      });
      if (action !== 'require') return;
    }
    if (!(await run(() => api('PUT', `/sso/${c.id}`, { requireSso })))) return;
    await load();
    toast(requireSso ? `${where}: single sign-on only` : `${where}: passwords allowed again`);
  };
  const test = async (c: Connection) => {
    const { action } = await ask({
      title: `Test sign-in with ${c.id}?`,
      body: <>
        <p>You go to your identity provider and come back here signed in as whoever signs in there: someone at {c.domains.join(', ')}.</p>
        <p>Sign in as yourself to stay you. To test as someone else, open the console in a private window and choose Sign in with SSO there.</p>
      </>,
      actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'go', label: 'Go to the identity provider' }],
    });
    if (action !== 'go') return;
    const back = `/${location.hash}`;
    const { error: e } = await authClient.signIn.sso({ providerId: c.id, callbackURL: back, errorCallbackURL: back });
    if (e) setError({ message: e.message ?? 'The identity provider couldn’t be reached.' });
  };
  const remove = async (c: Connection) => {
    const { action } = await ask({
      title: `Remove the ${c.id} connection?`,
      body: <p>Nobody at {c.domains.join(', ')} can sign in with it any more, and everyone who did is signed out. People keep their roles; anyone without a password needs an invite link to get back in.</p>,
      actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'remove', label: 'Remove connection', tone: 'danger' }],
    });
    if (action !== 'remove') return;
    setError(null);
    if (!(await run(() => api('DELETE', `/sso/${c.id}`)))) return;
    await load();
    toast(`${c.id} removed`);
  };

  const addButton = admin && state?.available && <Button onClick={() => setDrawer({ editing: null })}>+ Add connection</Button>;
  return (
    <section aria-labelledby="s-sso" className="grid gap-3">
      <Heading id="s-sso" title="Single Sign-On" quiet action={addButton}>
        People sign in with your organization’s identity provider (Okta, Entra ID, Google Workspace, JumpCloud…) over OIDC or SAML.
        Everyone at the connection’s email domains can sign in, and joins with the role below.
        Where single sign-on is required, someone you remove from your identity provider is signed out within 12 hours.
        Their access tokens keep working until they expire, so remove people in People when they leave.
      </Heading>
      <ErrorList error={error} />
      {!state ? (error ? null : <div aria-hidden className="flex h-[46px] items-center border border-grid px-4"><Bone className="w-2/3" /></div>) : !state.available ? (
        <Callout>Single sign-on needs the Better Auth sign-in, which this server doesn’t use.</Callout>
      ) : state.connections.length === 0 ? (
        <Empty action={addButton || undefined}>No single sign-on yet. People sign in with their password, or the providers set up on the server.</Empty>
      ) : (
        <div role="table" aria-label="Single sign-on connections">
          <div role="row" className={cn(COLS, tableHeadClass)}>
            <span role="columnheader">Connection</span><span role="columnheader" className={MD}>Email domains</span>
            <span role="columnheader" className={MD}>Passwords</span><span />
          </div>
          {state.connections.map((c) => (
            <div key={c.id} role="row" className={cn(COLS, tableRowClass)}>
              <span role="cell" className="min-w-0">
                <span className="flex min-w-0 items-center gap-2"><code className="truncate font-mono text-13 font-medium">{c.id}</code><Badge>{c.type.toUpperCase()}</Badge></span>
                <span className="block text-11 text-ink-3">{c.lastSignInAt ? <>Last sign-in <When iso={c.lastSignInAt} className="text-11 text-ink-3" /></> : 'Nobody has signed in with it yet'}</span>
              </span>
              <span role="cell" className={cn(MD, 'min-w-0 truncate text-13 text-ink-2')} title={c.issuer}>
                {c.domains.join(', ')}{c.groupRoles && <span className="block text-11 text-ink-3">Roles from its groups</span>}
              </span>
              <span role="cell" className={MD}>
                {admin ? (
                  <Switch checked={c.requireSso} disabled={!c.requireSso && !c.lastSignInAt} label={`Require single sign-on for ${c.domains.join(', ')}`} onChange={(v) => void toggle(c, v)}>
                    <span className="text-ink-2">{c.requireSso ? 'Single sign-on only' : c.lastSignInAt ? 'Allowed' : 'Allowed: test it first'}</span>
                  </Switch>
                ) : <span className="text-13 text-ink-2">{c.requireSso ? 'Single sign-on only' : 'Allowed'}</span>}
              </span>
              <span role="cell" className="flex flex-wrap justify-end gap-2">
                {admin && <>
                  <Button variant="secondary" onClick={() => void test(c)}>Test sign-in</Button>
                  <Button variant="secondary" onClick={() => setDrawer({ editing: c })}>Edit</Button>
                  <Button variant="secondary" onClick={() => void remove(c)}>Remove</Button>
                </>}
              </span>
            </div>
          ))}
        </div>
      )}
      {rules && <Rules rules={rules} admin={admin} onSaved={setRules} />}
      {/* mounted only while open: once it closes, the client secret and the certificate typed in are gone from memory */}
      {state && drawer && <ConnectionDrawer base={state.base} editing={drawer.editing} onClose={() => setDrawer(null)}
        onSaved={async (c, added) => { setDrawer(null); await load(); toast(added ? `${c.id} added. Test sign-in with it next.` : `${c.id} saved`); }} />}
    </section>
  );
}

/** The organization's sign-in rules (server/access.ts): who keeps a password, two-factor for admins, the join role. */
function Rules({ rules, admin, onSaved }: { rules: SignInRules; admin: boolean; onSaved: (r: SignInRules) => void }) {
  const { meta, toast } = useApp();
  const { error, setError, run } = useAsync();
  const admins = meta.users.filter((u) => roleInfo(u.role).changesSettings && u.status !== 'removed');
  const save = async (change: Partial<SignInRules>, said: string) => {
    setError(null);
    const r = await run(() => api<SignInRules>('PUT', RULES_PATH, change));
    if (r) { onSaved(r); toast(said); }
  };
  const nameOf = (key: string) => meta.users.find((u) => u.key === key)?.name ?? key;
  return (
    <div className="mt-4 grid gap-4 border border-grid p-4">
      <span className="text-13 font-medium text-ink">Sign-in rules</span>
      <Field label="Break-glass admin" hint="The one admin who keeps their password where single sign-on is required, for when your identity provider is down. Every other admin signs in with single sign-on there.">
        <NativeSelect className={selectField} value={rules.breakGlassAdmin ?? ''} disabled={!admin} aria-label="Break-glass admin"
          onChange={(e) => void save({ breakGlassAdmin: e.target.value || null }, e.target.value ? `${nameOf(e.target.value)} is the break-glass admin` : 'No break-glass admin')}>
          <option value="">Nobody</option>
          {admins.map((u) => <option key={u.key} value={u.key}>{u.name === u.key ? u.key : `${u.name} (${u.key})`}</option>)}
        </NativeSelect>
      </Field>
      <Field label="New people join as" hint="People who join without an invite: by single sign-on, or with Google, GitHub or Microsoft at an allowed domain. Viewers can see every flag and entity, and change nothing.">
        <NativeSelect className={selectField} value={rules.joinRole} disabled={!admin} aria-label="New people join as"
          onChange={(e) => void save({ joinRole: e.target.value }, `New people join as ${roleInfo(e.target.value).label.toLowerCase()}`)}>
          {JOIN_ROLES.map((r) => <option key={r} value={r}>{roleInfo(r).label}: {roleInfo(r).does}</option>)}
        </NativeSelect>
      </Field>
      <Switch checked={rules.adminsNeedTwoFactor} disabled={!admin} label="Admins with a password use two-factor sign-in"
        onChange={(v) => void save({ adminsNeedTwoFactor: v }, v ? 'Admins with a password set up two-factor sign-in first' : 'Two-factor sign-in is up to each admin')}>
        <span className="text-ink-1">Admins with a password use two-factor sign-in</span>
      </Switch>
      <p className="-mt-2 m-0 text-13 text-ink-3">They set it up before anything else in the console. Set yours up first: your account menu → Account. Admins who sign in with single sign-on use your identity provider’s.</p>
      <ErrorList error={error} />
    </div>
  );
}

function Copyable({ label, value }: { label: string; value: string }) {
  const { toast } = useApp();
  return (
    <div className="grid gap-1">
      <span className="text-13 text-ink-2">{label}</span>
      <div className="flex gap-2">
        <Input readOnly value={value} onFocus={(e) => e.currentTarget.select()} className="h-[30px] min-w-0 flex-1 font-mono text-11" aria-label={label} />
        <Button variant="secondary" onClick={() => void copyText(value, label.toLowerCase(), toast)}>Copy</Button>
      </div>
    </div>
  );
}

/** A connection's form: a new one, or one to edit (its protocol and id stay; a secret left empty stays as it was). It's
 *  mounted only while open, so each opening starts a fresh form. */
function ConnectionDrawer({ base, editing, onClose, onSaved }: { base: string; editing: Connection | null; onClose: () => void; onSaved: (c: Connection, added: boolean) => void }) {
  const first = useRef<HTMLSelectElement>(null);
  const [type, setType] = useState<'oidc' | 'saml'>(editing?.type ?? 'oidc');
  const [id, setId] = useState(editing?.id ?? '');
  const [domains, setDomains] = useState(editing?.domains.join(', ') ?? '');
  const [issuer, setIssuer] = useState(editing?.type === 'oidc' ? editing.issuer : '');
  const [clientId, setClientId] = useState(editing?.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [metadata, setMetadata] = useState('');
  const [entryPoint, setEntryPoint] = useState(editing?.entryPoint ?? '');
  const [entityId, setEntityId] = useState(editing?.entityId ?? '');
  const [certificate, setCertificate] = useState('');
  const [claim, setClaim] = useState(editing?.groupRoles?.claim ?? '');
  const [groups, setGroups] = useState(groupLines(editing?.groupRoles ?? null));
  const { busy, error, setError, run } = useAsync();
  const key = id.trim().toLowerCase() || (type === 'oidc' ? 'okta' : 'entra');
  const sp = serviceProvider(base, key);
  const ready = !!domains.trim() && (editing ? true
    : type === 'oidc' ? !!(issuer.trim() && clientId.trim() && clientSecret.trim()) : !!(metadata.trim() || (entryPoint.trim() && entityId.trim() && certificate.trim())));
  const save = async () => {
    const read = readGroupLines(groups);
    if (read.problem) { setError({ message: read.problem }); return; }
    if (read.roles && !claim.trim()) { setError({ message: 'Name the claim or attribute that lists the groups, e.g. groups.' }); return; }
    const groupRoles = read.roles ? { claim: claim.trim(), roles: read.roles } : null;
    const all: Record<string, string> = type === 'oidc' ? { issuer, clientId, clientSecret } : { metadata, entryPoint, entityId, certificate };
    // editing: only what changed goes, so saving new domains doesn't ask the identity provider again
    const was: Record<string, string | undefined> = editing ? { issuer: editing.issuer, clientId: editing.clientId, entryPoint: editing.entryPoint, entityId: editing.entityId } : {};
    const fields = Object.fromEntries(Object.entries(all).filter(([k, v]) => !editing || (v.trim() !== '' && v.trim() !== (was[k] ?? ''))));
    const r = editing
      ? await run(() => api<Connection>('PUT', `/sso/${editing.id}`, { domains, groupRoles, ...fields }))
      : await run(() => api<Connection>('POST', '/sso', { type, id: key, domains, ...(groupRoles ? { groupRoles } : {}), ...fields }));
    if (r) onSaved(r, !editing);
  };
  const keep = editing ? 'Leave empty to keep the one saved.' : undefined;
  return (
    <Drawer open onClose={onClose} title={editing ? `Edit ${editing.id}` : 'Add single sign-on'} initialFocus={first}
      subtitle={editing ? `${editing.type.toUpperCase()}. For another protocol or id, add a new connection.` : 'Connect your organization’s identity provider. People at its email domains sign in with it.'}
      footer={<>
        <Button disabled={busy || !ready} onClick={save}>{busy ? 'Saving…' : editing ? 'Save' : 'Add connection'}</Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
      </>}>
      <div className="grid gap-4">
        {!editing && <>
          <Field label="Protocol">
            <NativeSelect ref={first} className={selectField} value={type} onChange={(e) => setType(e.target.value as 'oidc' | 'saml')}>
              <option value="oidc">OIDC: Okta, Entra ID, Google Workspace, Auth0, Keycloak…</option>
              <option value="saml">SAML 2.0</option>
            </NativeSelect>
          </Field>
          <Field label="Connection ID" hint="Lowercase letters, digits and dashes. It’s in the addresses below, so choose it first.">
            <Input className="h-[34px] font-mono text-13" value={id} onChange={(e) => setId(e.target.value.toLowerCase())} placeholder={key} />
          </Field>
        </>}
        <Field label="Your email domains" required hint="Comma-separated, e.g. example.com, example.co.uk. Subdomains are included.">
          <Input className="h-[34px] text-13" value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="example.com" />
        </Field>

        <div className="grid gap-3 border border-rule p-3">
          <span className="text-13 font-medium text-ink">In your identity provider, {editing ? 'the app has these:' : 'create an app with these:'}</span>
          {type === 'oidc' ? (
            <Copyable label="Sign-in redirect URI" value={sp.oidcRedirectUri} />
          ) : <>
            <Copyable label="ACS URL (reply URL)" value={sp.samlAcsUrl} />
            <Copyable label="Entity ID (audience)" value={sp.samlEntityId} />
            <span className="text-13 text-ink-3">Name ID: the person’s email address. Or give it the metadata URL: {sp.samlMetadataUrl}</span>
          </>}
        </div>

        {type === 'oidc' ? <>
          <Field label="Issuer URL" required={!editing} hint="e.g. https://example.okta.com, https://login.microsoftonline.com/<tenant>/v2.0, https://accounts.google.com">
            <Input className="h-[34px] font-mono text-13" value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="https://example.okta.com" />
          </Field>
          <Field label="Client ID" required={!editing}>
            <Input className="h-[34px] font-mono text-13" value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Client secret" required={!editing} hint={keep ?? 'Kept on the server, never shown again.'}>
            <Input className="h-[34px] font-mono text-13" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="new-password" />
          </Field>
        </> : <>
          <Field label="Identity provider metadata XML" hint={keep ?? 'Download it from your identity provider’s SAML app and paste it here.'}>
            <textarea rows={5} className={cn(textareaField, 'font-mono text-11')} value={metadata} onChange={(e) => setMetadata(e.target.value)}
              placeholder={'<EntityDescriptor entityID="…">…</EntityDescriptor>'} />
          </Field>
          <Collapsible title="No metadata? Enter the details instead" defaultOpen={!!editing && !!entryPoint}>
            <div className="grid gap-3">
              <Field label="Sign-in URL (SSO URL)">
                <Input className="h-[34px] font-mono text-13" value={entryPoint} onChange={(e) => setEntryPoint(e.target.value)} placeholder="https://idp.example.com/sso/saml" />
              </Field>
              <Field label="Issuer (identity provider entity ID)">
                <Input className="h-[34px] font-mono text-13" value={entityId} onChange={(e) => setEntityId(e.target.value)} />
              </Field>
              <Field label="Signing certificate" hint={keep}>
                <textarea rows={4} className={cn(textareaField, 'font-mono text-11')} value={certificate} onChange={(e) => setCertificate(e.target.value)}
                  placeholder="-----BEGIN CERTIFICATE-----" />
              </Field>
            </div>
          </Collapsible>
        </>}

        <Collapsible title="Roles from your identity provider’s groups" defaultOpen={!!editing?.groupRoles}>
          <div className="grid gap-3">
            <p className="m-0 text-13 text-ink-2">
              Each time someone signs in with this connection, their groups give their role: the highest of the groups below.
              Someone in none of them gets the join role. Without groups here, roles are set in People.
            </p>
            <Field label={type === 'oidc' ? 'Claim with the groups' : 'Attribute with the groups'}
              hint={type === 'oidc' ? 'Usually groups. Make sure your identity provider puts it in the ID token or user info.' : 'e.g. groups, or http://schemas.microsoft.com/ws/2008/06/identity/claims/groups'}>
              <Input className="h-[34px] font-mono text-13" value={claim} onChange={(e) => setClaim(e.target.value)} placeholder="groups" />
            </Field>
            <Field label="Groups and their roles" hint="One per line: group = role (viewer, editor, approver, oncall, admin).">
              <textarea rows={4} className={cn(textareaField, 'font-mono text-13')} value={groups} onChange={(e) => setGroups(e.target.value)}
                placeholder={'flag-admins = admin\nflag-editors = editor'} />
            </Field>
          </div>
        </Collapsible>

        {!editing && <p className="m-0 text-13 text-ink-3">Once it’s added, use Test sign-in. Then you can require single sign-on for these domains.</p>}
        <ErrorList error={error} />
      </div>
    </Drawer>
  );
}
