import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@companyflags/ui/components/button';
import { Callout } from '@companyflags/ui/components/callout';
import { Checkbox } from '@companyflags/ui/components/checkbox';
import { KeyHints, tableHeadClass, tableRowClass, useListKeys } from '@companyflags/ui/components/data-table';
import { Drawer, DrawerRow, DrawerSection } from '@companyflags/ui/components/drawer';
import { Input } from '@companyflags/ui/components/input';
import { NativeSelect } from '@companyflags/ui/components/native-select';
import { BAR_CONTROLS, barTextButton, FilterSelect, PageBar } from '@companyflags/ui/components/page-bar';
import { cn } from '@companyflags/ui/lib/utils';
import { api, peek } from '../api.ts';
import { CountSlot, SkeletonRows } from '../loading.tsx';
import { TOKENS_PATH } from '../paths.ts';
import { useApp } from '../app.ts';
import { plural } from '../text.ts';
import { AgentBadge, Badge, Empty, ErrorList, Field, Switch, When } from '../ui.tsx';
import { copyText, useAsync, usePersistentState } from '../uiKit.ts';
import { roleInfo } from '../../../server/policy.ts';
import { TwoFactorSection } from './twoFactor.tsx';
import { AGENT_ABOUT, ALERTS_ABOUT, allowedRole, DEFAULT_DAYS, mayMakeAlertsToken, EXPIRY_DAYS, expiresText, roleChoices, TOKEN_ABOUT, tokenState, type TokenRow, type TokenState } from './tokensKit.ts';

/*
 * Access tokens: a person's tokens for the console's API (server/tokens.ts), for scripts, the CLI and MCP clients.
 * The same dense list as API keys: a page bar (state filter, an admin's switch for everyone's, + New token), a table,
 * a drawer for one token with Revoke, and a drawer with the new-token form that then shows the token once.
 */

type Show = 'active' | 'ended' | 'all';

/** name, role, person (everyone's), expires, last used */
const COLS = 'grid grid-cols-[minmax(0,2fr)_96px_110px_110px] max-md:grid-cols-[minmax(0,1fr)_96px]';
const COLS_ALL = 'grid grid-cols-[minmax(0,2fr)_96px_minmax(0,1fr)_110px_110px] max-md:grid-cols-[minmax(0,1fr)_96px]';
const MD = 'max-md:hidden';
const time = 'text-13 text-ink-2';
const selectField = 'w-full [&_select]:h-[34px] [&_select]:text-13';
/** The main cell's button: the row's way in for the keyboard and screen readers (the row itself takes clicks too). */
const openButton = 'block w-full min-w-0 cursor-default border-0 bg-transparent p-0 text-left text-inherit';

function StateBadge({ state }: { state: TokenState }) {
  return state === 'active' ? null : <Badge kind={state === 'revoked' ? 'danger' : undefined}>{state}</Badge>;
}

export function Tokens() {
  const { meta, revisionTick, toast, ask } = useApp();
  const admin = roleInfo(meta.me.role).changesSettings;
  const [everyone, setEveryone] = usePersistentState('tokens.all', false);
  const all = admin && everyone;
  const path = all ? `${TOKENS_PATH}?all=1` : TOKENS_PATH;
  const [tokens, setTokens] = useState<TokenRow[] | null>(() => peek<TokenRow[]>(path) ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [show, setShow] = usePersistentState<Show>('tokens.show', 'active');
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  // only the newest load's answer is shown
  const latest = useRef(0);
  const load = useCallback(() => {
    const id = ++latest.current;
    return api<TokenRow[]>('GET', path)
      .then((r) => { if (id === latest.current) { setTokens(r); setLoadError(null); } })
      .catch((e) => { if (id === latest.current) { setTokens([]); setLoadError(e.message); } });
  }, [path]);
  useEffect(() => { void load(); }, [load, revisionTick]);

  const rows = useMemo(() => (tokens ?? []).filter((t) => {
    const s = tokenState(t);
    return show === 'all' || (show === 'active') === (s === 'active');
  }), [tokens, show]);
  const list = useListKeys({
    count: rows.length,
    onOpen: (i) => openToken(rows[i].id),
    enabled: !creating && !detailOpen,
  });
  const openToken = (id: number) => { setOpenId(id); setDetailOpen(true); };
  const detail = tokens?.find((t) => t.id === openId) ?? null;
  const live = tokens?.filter((t) => tokenState(t) === 'active').length ?? 0;
  const cols = all ? COLS_ALL : COLS;

  // revoking can't be undone, so it asks first and says so
  const revokeOne = async (t: TokenRow) => {
    const r = await ask({
      title: `Revoke ${t.name}?`,
      body: <p>Every script, CLI or agent using <span className="font-mono">{t.prefix}…</span> stops at once. <b className="font-medium">This can’t be undone.</b></p>,
      actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'revoke', label: 'Revoke token', tone: 'danger' }],
    });
    if (r.action === 'revoke') revoke(t);
  };
  const revoke = async (t: TokenRow) => {
    try {
      await api('DELETE', `${TOKENS_PATH}/${t.id}`);
      toast(`Revoked ${t.name} (${t.prefix}…)`);
      setDetailOpen(false);
    } catch (e) { toast(`Couldn’t revoke ${t.name}: ${(e as Error).message}`, 'err', { label: 'Retry', onClick: () => revoke(t) }); }
    load();
  };

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <PageBar title="Account" count={loadError ? undefined : <CountSlot text={tokens ? `${live} ${live === 1 ? 'token' : 'tokens'} in use` : undefined} />}
        actions={<Button onClick={() => setCreating(true)}>+ New token</Button>}>
        <FilterSelect<Show> label="State" value={show} onChange={setShow} options={[['active', 'Active'], ['ended', 'Revoked or expired'], ['all', 'All']]} />
        {admin && <Switch checked={everyone} onChange={setEveryone} label="Show everyone’s tokens">Everyone’s</Switch>}
        {show !== 'active' && <button type="button" onClick={() => setShow('active')} className={barTextButton}>Reset</button>}
      </PageBar>
      <TwoFactorSection />
      <p className="m-0 border-b border-grid px-6 py-3 text-13 text-ink-2 max-sm:px-4">{TOKEN_ABOUT} {AGENT_ABOUT}</p>

      <div role="table" aria-label="Access tokens" className="flex-1">
        <div role="row" className={cn(cols, tableHeadClass)}>
          <span role="columnheader">Token</span>
          <span role="columnheader">Role</span>
          {all && <span role="columnheader" className={MD}>Person</span>}
          <span role="columnheader" className={MD}>Expires</span>
          <span role="columnheader" className={MD}>Last used</span>
        </div>
        {loadError ? (
          <Callout tone="error" role="alert" className="m-6 flex flex-wrap items-center gap-x-4 gap-y-2 max-sm:m-4">
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">Couldn’t load the tokens: {loadError}</span>
            <span className={BAR_CONTROLS}><Button variant="secondary" onClick={() => void load()}>Try again</Button></span>
          </Callout>
        )
          : !tokens ? <SkeletonRows cols={cols} cells={all ? ['', '', MD, MD, MD] : ['', '', MD, MD]} />
          : rows.length === 0 ? (
            <div className="px-6 py-10 max-sm:px-4">
              <Empty action={show !== 'active' ? <Button variant="secondary" onClick={() => setShow('active')}>Show active</Button> : <Button onClick={() => setCreating(true)}>+ New token</Button>}>
                {show !== 'active' ? 'No tokens match this filter.' : 'No tokens yet. Make one for a script, the CLI or an agent’s MCP settings.'}
              </Empty>
            </div>
          ) : rows.map((t, i) => {
            const state = tokenState(t);
            return (
              <div key={t.id} role="row" data-row-index={i} data-active={list.active === i}
                onClick={() => { list.setActive(i); openToken(t.id); }} className={cn(cols, tableRowClass, 'cursor-default', state !== 'active' && 'text-ink-3')}>
                <span role="cell" className="min-w-0">
                  <button type="button" className={openButton} aria-haspopup="dialog" onClick={(e) => { e.stopPropagation(); list.setActive(i); openToken(t.id); }}>
                    <span className="flex min-w-0 items-center gap-2">
                      <span className={cn('truncate font-medium', state !== 'active' && 'font-normal line-through decoration-ink-4')}>{t.name}</span>
                      {t.agent && <AgentBadge title="For an agent: Viewer or Editor, and its changes show as an agent’s" />}
                      <StateBadge state={state} />
                    </span>
                    <code className="block truncate font-mono text-xs text-ink-3">{t.prefix}…</code>
                  </button>
                </span>
                <span role="cell" className="text-13 text-ink-2">{roleInfo(t.role).label}</span>
                {all && <span role="cell" className={cn(MD, 'truncate text-13 text-ink-2')}>{t.person}</span>}
                <span role="cell" className={cn(MD, time)} title={new Date(t.expiresAt).toLocaleString()}>{t.revokedAt ? '—' : expiresText(t.expiresAt)}</span>
                <span role="cell" className={cn(MD, time)}>{t.lastUsedAt ? <When iso={t.lastUsedAt} /> : 'never'}</span>
              </div>
            );
          })}
      </div>

      <div className="flex flex-wrap items-center gap-4 border-t border-rule px-6 py-2.5 max-sm:px-4">
        <KeyHints className="max-md:hidden" />
        <span className="flex-1" />
        {tokens && !loadError && <span className="font-mono text-11 text-ink-3 uppercase">{rows.length === tokens.length ? plural(tokens.length, 'token') : `${rows.length} of ${plural(tokens.length, 'token')}`}</span>}
      </div>

      <TokenDrawer t={detail} open={detailOpen && !!detail} onClose={() => setDetailOpen(false)} onRevoke={revokeOne} />
      {/* mounted only while open: after Done, the new token is gone from memory */}
      {creating && <CreateToken onClose={() => setCreating(false)} onCreated={() => void load()} />}
    </div>
  );
}

/** One token: whose, what role, when it ends and was used; Revoke while it's active. */
function TokenDrawer({ t, open, onClose, onRevoke }: { t: TokenRow | null; open: boolean; onClose: () => void; onRevoke: (t: TokenRow) => void }) {
  const exact = (iso: string) => <>{new Date(iso).toLocaleString()} <span className="text-ink-3">· <When iso={iso} /></span></>;
  const state = t ? tokenState(t) : 'active';
  return (
    <Drawer open={open} onClose={onClose} title={t?.name ?? ''} subtitle={t ? `${t.prefix}… · ${t.person}` : undefined}
      footer={t && state === 'active' ? <Button variant="stop" onClick={() => onRevoke(t)}>Revoke token</Button> : undefined}>
      {t && <>
        <DrawerSection title="Token">
          <DrawerRow label="State">{state === 'active' ? 'Active' : <StateBadge state={state} />}</DrawerRow>
          <DrawerRow label="Prefix"><code className="font-mono">{t.prefix}…</code></DrawerRow>
          <DrawerRow label="Person">{t.person}</DrawerRow>
          <DrawerRow label="Role">{roleInfo(t.role).label}<span className="block text-ink-3">Never above its person’s role today.</span></DrawerRow>
          <DrawerRow label="For an agent">{t.agent ? <><AgentBadge /><span className="block text-ink-3">{AGENT_ABOUT}</span></> : 'No'}</DrawerRow>
          {t.alertsOnly && <DrawerRow label="For alerts only">Yes<span className="block text-ink-3">{ALERTS_ABOUT}</span></DrawerRow>}
        </DrawerSection>
        <DrawerSection title="Activity">
          <DrawerRow label="Created">{exact(t.createdAt)}</DrawerRow>
          <DrawerRow label="Expires">{new Date(t.expiresAt).toLocaleString()} <span className="text-ink-3">· {expiresText(t.expiresAt)}</span></DrawerRow>
          <DrawerRow label="Last used">{t.lastUsedAt ? exact(t.lastUsedAt) : <span className="text-ink-3">Never</span>}</DrawerRow>
          {t.revokedAt && <DrawerRow label="Revoked">{exact(t.revokedAt)}</DrawerRow>}
        </DrawerSection>
      </>}
    </Drawer>
  );
}

/**
 * The new-token form in a drawer; after creating, the drawer shows the token once. It's mounted only while open, so
 * each opening starts a fresh form and the shown token is forgotten when it closes.
 */
function CreateToken({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const firstField = useRef<HTMLInputElement>(null);
  const tokenField = useRef<HTMLInputElement>(null);
  const { meta, toast } = useApp();
  const myRole = meta.me.role;
  const [name, setName] = useState('');
  const [agent, setAgent] = useState(false);
  const [alertsOnly, setAlertsOnly] = useState(false);
  const [rolePick, setRole] = useState('');
  const role = alertsOnly ? 'oncall' : allowedRole(rolePick, myRole, agent);
  const mayAlert = mayMakeAlertsToken(myRole);
  const [days, setDays] = useState<number>(DEFAULT_DAYS);
  const [created, setCreated] = useState<string | null>(null);
  const { busy, error, run } = useAsync();

  const copy = async (token: string) => {
    await copyText(token, 'the new token', toast);
    tokenField.current?.focus(); tokenField.current?.select();
  };
  const create = async () => {
    const r = await run(() => api<{ token: string }>('POST', TOKENS_PATH, alertsOnly ? { name: name.trim(), alertsOnly, days } : { name: name.trim(), agent, role, days }));
    if (!r) return;
    setCreated(r.token); onCreated();
    // no Copy in the toast: it would keep the token after the drawer closes
    toast(`Made the access token ${name.trim()}`);
  };

  return (
    <Drawer open onClose={onClose} title={created ? 'Copy your new token' : 'New token'} initialFocus={firstField}
      subtitle={created ? `${name.trim()} · ${roleInfo(role).label}` : TOKEN_ABOUT}
      footer={created ? <>
        <Button onClick={() => copy(created)}>Copy token</Button>
        <Button variant="secondary" onClick={onClose}>Done</Button>
      </> : <>
        <Button disabled={busy || !name.trim()} onClick={create}>{busy ? 'Creating…' : 'Create token'}</Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <span className="text-13 text-ink-3">It’s shown once; only its hash is stored.</span>
      </>}>
      {created ? (
        <div className="grid gap-4" role="status">
          <Callout tone="warn"><b className="font-medium">Copy this token now.</b> It won’t be shown again.</Callout>
          <Input ref={tokenField} readOnly value={created} onFocus={(e) => e.target.select()} className="h-[34px] font-mono text-13" aria-label="New access token" />
          <p className="m-0 text-13 text-ink-3">Send it on <code className="font-mono">/api</code> as <code className="font-mono">Authorization: Bearer cfp_…</code>, from a script or an agent’s settings: a browser can’t use it.</p>
        </div>
      ) : (
        <div className="grid gap-4">
          <Field label="Name" required>
            <Input ref={firstField} className="h-[34px] text-13" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Claude in my editor" />
          </Field>
          <label className="flex cursor-pointer items-start gap-2.5 text-sm text-ink-1">
            <Checkbox className="mt-0.5" checked={agent} disabled={alertsOnly} onCheckedChange={(v) => setAgent(v === true)} />
            <span className="grid gap-0.5">
              For an agent (Claude, Cursor, Codex…)
              <span className="text-13 text-ink-3">Viewer or Editor only. {AGENT_ABOUT}</span>
            </span>
          </label>
          {mayAlert && (
            <label className="flex cursor-pointer items-start gap-2.5 text-sm text-ink-1">
              <Checkbox className="mt-0.5" checked={alertsOnly} disabled={agent} onCheckedChange={(v) => setAlertsOnly(v === true)} />
              <span className="grid gap-0.5">
                For alerts only (Grafana, Datadog…)
                <span className="text-13 text-ink-3">{ALERTS_ABOUT}</span>
              </span>
            </label>
          )}
          <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
            <Field label="Role" hint={alertsOnly ? 'On call: turning a flag off from an alert is break-glass.' : 'Up to your own role. An admin’s token is On call at most.'}>
              <NativeSelect className={selectField} value={role} disabled={alertsOnly} onChange={(e) => setRole(e.target.value)}>
                {(alertsOnly ? [['oncall', roleInfo('oncall').label]] : roleChoices(myRole, agent)).map(([r, label]) => <option key={r} value={r}>{label}</option>)}
              </NativeSelect>
            </Field>
            <Field label="Expires in">
              <NativeSelect className={selectField} value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
                {EXPIRY_DAYS.map((d) => <option key={d} value={d}>{d} days</option>)}
              </NativeSelect>
            </Field>
          </div>
          <ErrorList error={error} />
        </div>
      )}
    </Drawer>
  );
}
