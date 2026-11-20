import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@companyflags/ui/components/button';
import { Callout } from '@companyflags/ui/components/callout';
import { tableHeadClass, tableRowClass } from '@companyflags/ui/components/data-table';
import { Drawer } from '@companyflags/ui/components/drawer';
import { Input } from '@companyflags/ui/components/input';
import { NativeSelect } from '@companyflags/ui/components/native-select';
import { cn } from '@companyflags/ui/lib/utils';
import { api, peek } from '../api.ts';
import { Bone } from '../loading.tsx';
import { SSO_PATH } from '../paths.ts';
import { useApp } from '../app.ts';
import { Badge, Collapsible, Empty, ErrorList, Field, Heading, Switch } from '../ui.tsx';
import { copyText, textareaField, useAsync } from '../uiKit.ts';
import { roleInfo } from '../../../server/policy.ts';

/*
 * Settings → Single sign-on (server/sso.ts): connections to your organization's identity provider, OIDC or SAML,
 * each for its email domains. People at those domains sign in with it and join as viewers.
 * A connection can require single sign-on: then only admins may still use a password there.
 */

type ServiceProvider = { oidcRedirectUri: string; samlAcsUrl: string; samlEntityId: string; samlMetadataUrl: string };
type Connection = { id: string; type: 'oidc' | 'saml'; issuer: string; domains: string[]; requireSso: boolean; clientId?: string; entryPoint?: string; serviceProvider: ServiceProvider };
type SsoState = { available: boolean; base: string; connections: Connection[] };

const COLS = 'grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,auto)] max-md:grid-cols-[minmax(0,1fr)_minmax(0,auto)]';
const MD = 'max-md:hidden';
const selectField = 'w-full [&_select]:h-[34px] [&_select]:text-13';

/** The addresses the identity provider's admin enters on their side, for a connection id. */
const serviceProvider = (base: string, id: string): ServiceProvider => {
  const auth = `${base.replace(/\/+$/, '')}/api/auth`;
  return {
    oidcRedirectUri: `${auth}/sso/callback/${id}`, samlAcsUrl: `${auth}/sso/saml2/sp/acs/${id}`,
    samlEntityId: `${auth}/sso/saml2/sp/metadata?providerId=${id}`, samlMetadataUrl: `${auth}/sso/saml2/sp/metadata?providerId=${id}`,
  };
};

export function SingleSignOn() {
  const { meta, toast, ask } = useApp();
  const admin = roleInfo(meta.me.role).changesSettings;
  // the last answer while a fresh one loads (navigation fetches it first: paths.ts)
  const [state, setState] = useState<SsoState | null>(() => peek<SsoState>(SSO_PATH) ?? null);
  const [adding, setAdding] = useState(false);
  const { error, setError, run } = useAsync();
  // only the newest load's answer is shown: an older one that comes back late (after an add or a remove) is ignored
  const latest = useRef(0);
  const load = useCallback(() => {
    const id = ++latest.current;
    return api<SsoState>('GET', SSO_PATH).then((r) => { if (id === latest.current) setState(r); }, (e) => { if (id === latest.current) setError({ message: e.message }); });
  }, [setError]);
  useEffect(() => { void load(); }, [load]);

  const toggle = async (c: Connection, requireSso: boolean) => {
    setError(null);
    if (!(await run(() => api('PUT', `/sso/${c.id}`, { requireSso })))) return;
    await load();
    toast(requireSso ? `${c.domains.join(', ')}: single sign-on only (admins can still use a password)` : `${c.domains.join(', ')}: passwords allowed again`);
  };
  const remove = async (c: Connection) => {
    const { action } = await ask({
      title: `Remove the ${c.id} connection?`,
      body: <p>Nobody at {c.domains.join(', ')} can sign in with it any more. People keep their roles; anyone without a password needs an invite link to get back in.</p>,
      actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'remove', label: 'Remove connection', tone: 'danger' }],
    });
    if (action !== 'remove') return;
    setError(null);
    if (!(await run(() => api('DELETE', `/sso/${c.id}`)))) return;
    await load();
    toast(`${c.id} removed`);
  };

  const addButton = admin && state?.available && <Button onClick={() => setAdding(true)}>+ Add connection</Button>;
  return (
    <section aria-labelledby="s-sso" className="grid gap-3">
      <Heading id="s-sso" title="Single sign-on" action={addButton}>
        People sign in with your organization’s identity provider (Okta, Entra ID, Google Workspace, JumpCloud…) over OIDC or SAML.
        Everyone at the connection’s email domains can sign in and joins as a viewer; leaving your identity provider ends their access
        when single sign-on is required.
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
              <span role="cell" className="flex min-w-0 items-center gap-2">
                <code className="truncate font-mono text-13 font-medium">{c.id}</code><Badge>{c.type.toUpperCase()}</Badge>
              </span>
              <span role="cell" className={cn(MD, 'min-w-0 truncate text-13 text-ink-2')} title={c.issuer}>{c.domains.join(', ')}</span>
              <span role="cell" className={MD}>
                {admin ? (
                  <Switch checked={c.requireSso} label={`Require single sign-on for ${c.domains.join(', ')}`} onChange={(v) => void toggle(c, v)}>
                    <span className="text-ink-2">{c.requireSso ? 'Single sign-on only' : 'Allowed'}</span>
                  </Switch>
                ) : <span className="text-13 text-ink-2">{c.requireSso ? 'Single sign-on only' : 'Allowed'}</span>}
              </span>
              <span role="cell" className="text-right">{admin && <Button variant="secondary" onClick={() => void remove(c)}>Remove</Button>}</span>
            </div>
          ))}
        </div>
      )}
      {/* mounted only while open: once it closes, the client secret and the certificate typed in are gone from memory */}
      {state && adding && <ConnectionDrawer base={state.base} onClose={() => setAdding(false)} onAdded={async (c) => { setAdding(false); await load(); toast(`${c.id} added: people at ${c.domains.join(', ')} can sign in with it`); }} />}
    </section>
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

/** The new-connection form. It's mounted only while open, so each opening starts a fresh form. */
function ConnectionDrawer({ base, onClose, onAdded }: { base: string; onClose: () => void; onAdded: (c: Connection) => void }) {
  const first = useRef<HTMLSelectElement>(null);
  const [type, setType] = useState<'oidc' | 'saml'>('oidc');
  const [id, setId] = useState('');
  const [domains, setDomains] = useState('');
  const [issuer, setIssuer] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [metadata, setMetadata] = useState('');
  const [entryPoint, setEntryPoint] = useState('');
  const [entityId, setEntityId] = useState('');
  const [certificate, setCertificate] = useState('');
  const [requireSso, setRequireSso] = useState(false);
  const { busy, error, run } = useAsync();
  const key = id.trim().toLowerCase() || (type === 'oidc' ? 'okta' : 'entra');
  const sp = serviceProvider(base, key);
  const ready = !!domains.trim() && (type === 'oidc' ? !!(issuer.trim() && clientId.trim() && clientSecret.trim()) : !!(metadata.trim() || (entryPoint.trim() && entityId.trim() && certificate.trim())));
  const save = async () => {
    const body = type === 'oidc'
      ? { type, id: key, domains, requireSso, issuer, clientId, clientSecret }
      : { type, id: key, domains, requireSso, metadata, entryPoint, entityId, certificate };
    const r = await run(() => api<Connection>('POST', '/sso', body));
    if (r) onAdded(r);
  };
  return (
    <Drawer open onClose={onClose} title="Add single sign-on" initialFocus={first}
      subtitle="Connect your organization’s identity provider. People at its email domains sign in with it."
      footer={<>
        <Button disabled={busy || !ready} onClick={save}>{busy ? 'Connecting…' : 'Add connection'}</Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
      </>}>
      <div className="grid gap-4">
        <Field label="Protocol">
          <NativeSelect ref={first} className={selectField} value={type} onChange={(e) => setType(e.target.value as 'oidc' | 'saml')}>
            <option value="oidc">OIDC: Okta, Entra ID, Google Workspace, Auth0, Keycloak…</option>
            <option value="saml">SAML 2.0</option>
          </NativeSelect>
        </Field>
        <Field label="Connection ID" hint="Lowercase letters, digits and dashes. It’s in the addresses below, so choose it first.">
          <Input className="h-[34px] font-mono text-13" value={id} onChange={(e) => setId(e.target.value.toLowerCase())} placeholder={key} />
        </Field>
        <Field label="Your email domains" required hint="Comma-separated, e.g. example.com, example.co.uk. Subdomains are included.">
          <Input className="h-[34px] text-13" value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="example.com" />
        </Field>

        <div className="grid gap-3 border border-rule p-3">
          <span className="text-13 font-medium text-ink">In your identity provider, create an app with these:</span>
          {type === 'oidc' ? (
            <Copyable label="Sign-in redirect URI" value={sp.oidcRedirectUri} />
          ) : <>
            <Copyable label="ACS URL (reply URL)" value={sp.samlAcsUrl} />
            <Copyable label="Entity ID (audience)" value={sp.samlEntityId} />
            <span className="text-13 text-ink-3">Name ID: the person’s email address. Or give it the metadata URL: {sp.samlMetadataUrl}</span>
          </>}
        </div>

        {type === 'oidc' ? <>
          <Field label="Issuer URL" required hint="e.g. https://example.okta.com, https://login.microsoftonline.com/<tenant>/v2.0, https://accounts.google.com">
            <Input className="h-[34px] font-mono text-13" value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="https://example.okta.com" />
          </Field>
          <Field label="Client ID" required>
            <Input className="h-[34px] font-mono text-13" value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Client secret" required hint="Kept on the server, never shown again.">
            <Input className="h-[34px] font-mono text-13" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="new-password" />
          </Field>
        </> : <>
          <Field label="Identity provider metadata XML" hint="Download it from your identity provider’s SAML app and paste it here.">
            <textarea rows={5} className={cn(textareaField, 'font-mono text-11')} value={metadata} onChange={(e) => setMetadata(e.target.value)}
              placeholder={'<EntityDescriptor entityID="…">…</EntityDescriptor>'} />
          </Field>
          <Collapsible title="No metadata? Enter the details instead">
            <div className="grid gap-3">
              <Field label="Sign-in URL (SSO URL)">
                <Input className="h-[34px] font-mono text-13" value={entryPoint} onChange={(e) => setEntryPoint(e.target.value)} placeholder="https://idp.example.com/sso/saml" />
              </Field>
              <Field label="Issuer (identity provider entity ID)">
                <Input className="h-[34px] font-mono text-13" value={entityId} onChange={(e) => setEntityId(e.target.value)} />
              </Field>
              <Field label="Signing certificate">
                <textarea rows={4} className={cn(textareaField, 'font-mono text-11')} value={certificate} onChange={(e) => setCertificate(e.target.value)}
                  placeholder="-----BEGIN CERTIFICATE-----" />
              </Field>
            </div>
          </Collapsible>
        </>}

        <Switch checked={requireSso} label="Require single sign-on" onChange={setRequireSso}>
          <span className="text-ink-1">Require single sign-on for these domains</span>
        </Switch>
        <p className="-mt-2 m-0 text-13 text-ink-3">No passwords there: people who leave your identity provider can’t sign in. Admins keep their password, in case the provider is down.</p>
        <ErrorList error={error} />
      </div>
    </Drawer>
  );
}
