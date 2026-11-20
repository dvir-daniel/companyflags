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
import { CDN_PATH } from '../paths.ts';
import { useApp } from '../app.ts';
import { Badge, Empty, ErrorList, Field, Heading, When } from '../ui.tsx';
import { useAsync } from '../uiKit.ts';
import { roleInfo } from '../../../server/policy.ts';
import { cloudflareFailure } from './cdnKit.ts';

/*
 * Settings → CDN (server/cdn.ts): the Cloudflare zone the app files are served through, and a token that may purge
 * its cache. After each publish the server drops that environment's files from Cloudflare, so apps get a change in
 * seconds instead of within the cache's minute. Set on the server (CF_ZONE_ID, CF_API_TOKEN), it shows here read-only.
 */

type Publish = { environment: string; revision: number; publishedAt: string | null; purgedAt: string | null; error: string | null };
type CdnState = {
  source: 'server' | 'console' | null; zoneId: string | null; tokenEnd: string | null;
  updatedAt: string | null; updatedBy: string | null; reachable: boolean; publishes: Publish[];
};

const COLS = 'grid grid-cols-[minmax(0,0.8fr)_minmax(0,0.6fr)_minmax(0,1fr)_minmax(0,1.6fr)] max-md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]';
const MD = 'max-md:hidden';
const selectField = 'w-full [&_select]:h-[34px] [&_select]:text-13';

export function Cdn() {
  const { meta, toast, ask } = useApp();
  const admin = roleInfo(meta.me.role).changesSettings;
  const [state, setState] = useState<CdnState | null>(() => peek<CdnState>(CDN_PATH) ?? null);
  const [editing, setEditing] = useState(false);
  const [env, setEnv] = useState(meta.environments[0]?.key ?? '');
  const { busy, error, setError, run } = useAsync();
  // only the newest load's answer is shown (an older one that comes back late is ignored)
  const latest = useRef(0);
  const load = useCallback(() => {
    const id = ++latest.current;
    return api<CdnState>('GET', CDN_PATH).then((r) => { if (id === latest.current) setState(r); }, (e) => { if (id === latest.current) setError({ message: e.message }); });
  }, [setError]);
  useEffect(() => { void load(); }, [load]);

  const purgeNow = async () => {
    setError(null);
    if (!(await run(() => api('POST', '/cdn/purge', { environment: env })))) return;
    toast(`${meta.environments.find((e) => e.key === env)?.name ?? env}: Cloudflare dropped its files. Apps get the current values on their next request.`);
  };
  const remove = async () => {
    const { action } = await ask({
      title: 'Stop purging Cloudflare after a publish?',
      body: <p>Apps still get every change, within a minute instead of seconds: Cloudflare keeps each file for 60 seconds. The token is deleted from this server.</p>,
      actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'remove', label: 'Stop purging', tone: 'danger' }],
    });
    if (action !== 'remove') return;
    setError(null);
    const r = await run(() => api<CdnState>('DELETE', CDN_PATH));
    if (!r) return;
    setState(r);
    toast('Cloudflare purge removed');
  };

  const setUp = admin && state?.source === null && <Button onClick={() => setEditing(true)}>Set up</Button>;
  return (
    <section aria-labelledby="s-cdn" className="grid gap-3">
      <Heading id="s-cdn" title="CDN (Cloudflare)" action={setUp}>
        Apps download their files through Cloudflare, which keeps each one for a minute. After a publish this server can tell Cloudflare to drop
        that environment’s files, so apps get the change in seconds.
      </Heading>
      <ErrorList error={error} />
      {!state ? (error ? null : <div aria-hidden className="flex h-[46px] items-center border border-grid px-4"><Bone className="w-2/3" /></div>) : <>
        {!state.reachable && <Callout>This server can’t reach Cloudflare, so nothing is purged and settings can’t be checked here.</Callout>}
        {state.source === null ? (
          <Empty action={setUp || undefined}>Not set up: apps get each change within a minute, when Cloudflare’s copy expires.</Empty>
        ) : (
          <div className="grid gap-3 border border-grid p-4">
            <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2 text-13">
              <dt className="text-ink-3">Zone ID</dt><dd className="m-0 min-w-0 truncate font-mono">{state.zoneId}</dd>
              <dt className="text-ink-3">API token</dt><dd className="m-0 font-mono">••••••••{state.tokenEnd}</dd>
              <dt className="text-ink-3">Set</dt>
              <dd className="m-0 text-ink-2">
                {state.source === 'server' ? 'On the server: CF_ZONE_ID and CF_API_TOKEN. Change them there.'
                  : <>By {meta.users.find((u) => u.key === state.updatedBy)?.name ?? state.updatedBy}{state.updatedAt && <>, <When iso={state.updatedAt} /></>}</>}
              </dd>
            </dl>
            {admin && (
              <div className="flex flex-wrap items-center gap-2">
                <NativeSelect className={cn(selectField, 'w-auto')} aria-label="Environment to purge" value={env} onChange={(e) => setEnv(e.target.value)}>
                  {meta.environments.map((e) => <option key={e.key} value={e.key}>{e.name}</option>)}
                </NativeSelect>
                <Button variant="secondary" disabled={busy || !env || !state.reachable} onClick={() => void purgeNow()}>{busy ? 'Purging…' : 'Purge now'}</Button>
                {state.source === 'console' && <>
                  <span className="flex-1" />
                  <Button variant="secondary" onClick={() => setEditing(true)}>Change</Button>
                  <Button variant="secondary" onClick={() => void remove()}>Remove</Button>
                </>}
              </div>
            )}
          </div>
        )}
        {state.publishes.length > 0 && <Publishes publishes={state.publishes} names={Object.fromEntries(meta.environments.map((e) => [e.key, e.name]))} />}
      </>}
      {/* mounted only while open: once it closes, the token typed in is gone from memory */}
      {state && editing && <CdnDrawer state={state} onClose={() => setEditing(false)}
        onSaved={(s) => { setEditing(false); setState(s); toast('Cloudflare purge is on: the next publish drops its files from the cache'); }} />}
    </section>
  );
}

/** The last publishes, and whether Cloudflare dropped each one's files. */
function Publishes({ publishes, names }: { publishes: Publish[]; names: Record<string, string> }) {
  const purge = (p: Publish) => {
    // only the Cloudflare plugin's failure: another plugin's after the same publish isn't the CDN's (cdnKit.ts)
    const failed = cloudflareFailure(p.error);
    if (failed) return <span className="flex min-w-0 items-center gap-2" title={failed}><Badge kind="danger">Purge failed</Badge><span className="min-w-0 truncate text-ink-2">{failed}</span></span>;
    if (p.purgedAt) return <span className="text-ink-2">Purged <When iso={p.purgedAt} /></span>;
    if (!p.publishedAt) return <Badge kind="warn">Publishing…</Badge>;
    return <span className="text-ink-3">Not purged</span>;
  };
  return (
    <div role="table" aria-label="Recent publishes">
      <div role="row" className={cn(COLS, tableHeadClass)}>
        <span role="columnheader">Environment</span><span role="columnheader" className={MD}>Version</span>
        <span role="columnheader" className={MD}>Published</span><span role="columnheader">Cloudflare</span>
      </div>
      {publishes.map((p) => (
        <div key={`${p.environment}-${p.revision}-${p.publishedAt}`} role="row" className={cn(COLS, tableRowClass)}>
          <span role="cell" className="min-w-0 truncate">{names[p.environment] ?? p.environment}</span>
          <span role="cell" className={cn(MD, 'font-mono text-13 text-ink-2')}>{p.revision}</span>
          <span role="cell" className={MD}>{p.publishedAt ? <When iso={p.publishedAt} /> : '—'}</span>
          <span role="cell" className="min-w-0 truncate text-13">{purge(p)}</span>
        </div>
      ))}
    </div>
  );
}

/** Setting the zone and token. Saving asks Cloudflare first, so a wrong zone or a token without permission isn't kept. */
function CdnDrawer({ state, onClose, onSaved }: { state: CdnState; onClose: () => void; onSaved: (s: CdnState) => void }) {
  const first = useRef<HTMLInputElement>(null);
  const [zoneId, setZoneId] = useState(state.zoneId ?? '');
  const [token, setToken] = useState('');
  const { busy, error, run } = useAsync();
  const keeping = state.source === 'console' && !token.trim();
  const ready = /^[0-9a-fA-F]{32}$/.test(zoneId.trim()) && (keeping || token.trim().length >= 20);
  const save = async () => {
    const r = await run(() => api<CdnState>('PUT', CDN_PATH, { zoneId: zoneId.trim(), ...(token.trim() ? { token: token.trim() } : {}) }));
    if (r) onSaved(r);
  };
  return (
    <Drawer open onClose={onClose} title={state.source ? 'Change Cloudflare purge' : 'Set up Cloudflare purge'} initialFocus={first}
      subtitle="After each publish, Cloudflare drops that environment’s app files, so apps get the change in seconds."
      footer={<>
        <Button disabled={busy || !ready} onClick={save}>{busy ? 'Checking with Cloudflare…' : 'Check and save'}</Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
      </>}>
      <div className="grid gap-4">
        <ol className="m-0 grid list-decimal gap-2 pl-5 text-13 text-ink-2 marker:text-ink-3">
          <li>In Cloudflare, open the domain the app files are served from. On its <b>Overview</b> page, under <b>API</b>, copy the <b>Zone ID</b>.</li>
          <li>Go to <b>My Profile → API Tokens → Create Token → Custom token</b>. Give it the permission <b>Zone · Cache Purge · Purge</b>,
            and under Zone Resources choose <b>Include · Specific zone</b> and that domain. Nothing else is needed.</li>
          <li>Paste both here. Saving checks them with Cloudflare first.</li>
        </ol>
        <Field label="Zone ID" required hint="32 letters and digits">
          <Input ref={first} className="h-[34px] font-mono text-13" value={zoneId} onChange={(e) => setZoneId(e.target.value)} placeholder="023e105f4ecef8ad9ca31a8372d0c353" autoComplete="off" />
        </Field>
        <Field label="API token" required={!keeping} hint={state.source === 'console' ? `Leave empty to keep the saved token (••••${state.tokenEnd}).` : 'Kept on the server, never shown again.'}>
          <Input className="h-[34px] font-mono text-13" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="new-password" />
        </Field>
        <ErrorList error={error} />
      </div>
    </Drawer>
  );
}
