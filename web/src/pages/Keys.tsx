import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@companyfeatures/ui/components/button';
import { Callout } from '@companyfeatures/ui/components/callout';
import { BulkBar, ColumnHead, KeyHints, RowCheck, SortHeader, tableHeadClass, tableRowClass, useListKeys, useSelection } from '@companyfeatures/ui/components/data-table';
import { Drawer, DrawerRow, DrawerSection } from '@companyfeatures/ui/components/drawer';
import { Input } from '@companyfeatures/ui/components/input';
import { NativeSelect } from '@companyfeatures/ui/components/native-select';
import { BAR_CONTROLS, barTextButton, FilterSelect, PageBar } from '@companyfeatures/ui/components/page-bar';
import { SearchField } from '@companyfeatures/ui/components/search-field';
import { cn } from '@companyfeatures/ui/lib/utils';
import { api, capital, entityIndex, joined, peek, title, type Meta } from '../api.ts';
import { CountSlot, SkeletonRows } from '../loading.tsx';
import { downloadCsv } from '../csv.ts';
import { KEYS_PATH } from '../paths.ts';
import { useApp } from '../app.ts';
import { plural } from '../text.ts';
import { Badge, Empty, ErrorList, Field, When } from '../ui.tsx';
import { copyText, useAsync, usePersistentState, useSlashFocus } from '../uiKit.ts';
import { useEnvs } from './envs.ts';
import { roleInfo } from '../../../server/policy.ts';

/*
 * API keys: the dense console list. A sticky page bar (search, filters, Create key), a sortable
 * full-width table with checkboxes, bulk Revoke and Export CSV, a drawer for one key, and a drawer
 * with the new-key form that then shows the key once. Keyboard: / search, j/k move, x select,
 * Enter open, Esc clear.
 */

// `scope`: which entries of the dimensions the key may ask about (server/auth.ts): its own (`entity`), its own and
// every one under it (`below`), or any (`all`). `entity`, `dimension`: the key's own, for `entity` and `below`.
type KeyRow = {
  id: number; prefix: string; label: string | null; environment: string; project: string; projectKind: string; scope: string;
  entity: string | null; dimension: string | null; createdAt: string; lastUsedAt: string | null; revokedAt: string | null;
};
type Sort = 'key' | 'env' | 'used' | 'created';
type State = 'active' | 'revoked' | 'all';

const SCOPE_HINT: Record<string, string> = {
  entity: 'The key asks about one entry only.',
  below: 'The key asks about one entry, or any under it: the address names which.',
  all: 'The key asks about any entry: the address names which.',
};
/** What a key may ask about, in words: "Only Acme", "Acme and everything under it", "Any". */
function scopeText(k: Pick<KeyRow, 'scope' | 'entity'>, meta: Meta) {
  const name = k.entity ? entityIndex(meta.entities).get(k.entity)?.name ?? k.entity : '';
  return k.scope === 'entity' ? `Only ${name}` : k.scope === 'below' ? `${name} and everything under it` : 'Any';
}
/** Where a backend downloads its flagd JSON with this key: the entity named in the address, by its dimension. */
function flagdAddress(k: Pick<KeyRow, 'scope' | 'entity' | 'dimension'>) {
  const mine = k.entity && k.dimension ? `/sdk/v1/flagd/${encodeURIComponent(k.dimension)}/${encodeURIComponent(k.entity)}` : null;
  return k.scope === 'all' || !mine ? '/sdk/v1/flagd/<dimension>/<key>' : mine;
}

/** checkbox, key, environment, app, asks about, last used, created */
const COLS = 'grid grid-cols-[28px_minmax(0,2fr)_104px_minmax(0,0.8fr)_minmax(0,1.3fr)_96px_96px] max-xl:grid-cols-[28px_minmax(0,2fr)_104px_minmax(0,0.8fr)_96px_96px] max-md:grid-cols-[28px_minmax(0,1fr)_84px]';
const XL = 'max-xl:hidden';
const MD = 'max-md:hidden';
const time = 'text-13 text-ink-2';
/** A 34px select in the new-key form. */
const selectField = 'w-full [&_select]:h-[34px] [&_select]:text-13';
/** The main cell's button: the row's way in for the keyboard and screen readers (the row itself takes clicks too). */
const openButton = 'block w-full min-w-0 cursor-default border-0 bg-transparent p-0 text-left text-inherit';

export function Keys() {
  const { meta, revisionTick, toast, ask } = useApp();
  const { envName, isProtected } = useEnvs();
  const [keys, setKeys] = useState<KeyRow[] | null>(() => peek<KeyRow[]>(KEYS_PATH) ?? null);   // the last answer, while a fresh one loads
  const [loadError, setLoadError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [env, setEnv] = usePersistentState('keys.env', '');
  const [app, setApp] = usePersistentState('keys.app', '');
  const [state, setState] = usePersistentState<State>('keys.state', 'active');
  const [order, setOrder] = usePersistentState<{ by: Sort; dir: 'asc' | 'desc' }>('keys.sort', { by: 'created', dir: 'desc' });
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);

  // only the newest load's answer is shown: an older one that comes back late (a revoke, then a refresh) is ignored
  const latest = useRef(0);
  const load = useCallback(() => {
    const id = ++latest.current;
    return api<KeyRow[]>('GET', KEYS_PATH)
      .then((r) => { if (id === latest.current) { setKeys(r); setLoadError(null); } })
      .catch((e) => { if (id === latest.current) { setKeys([]); setLoadError(e.message); } });
  }, []);
  const [retrying, setRetrying] = useState(false);
  const retry = () => { setRetrying(true); load().finally(() => setRetrying(false)); };
  // again whenever something changed (here or in another tab), like the other lists
  useEffect(() => { void load(); }, [load, revisionTick]);
  // "/" puts the cursor in the search box
  useSlashFocus(search, !creating && !detailOpen);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const m = order.dir === 'asc' ? 1 : -1;
    const ts = (iso: string | null) => (iso ? Date.parse(iso) : 0);
    return (keys ?? [])
      .filter((k) => (state === 'all' || (state === 'active') === !k.revokedAt)
        && (!env || k.environment === env) && (!app || k.project === app)
        && (!needle || k.prefix.toLowerCase().includes(needle) || !!k.label?.toLowerCase().includes(needle)))
      .sort((a, b) => m * (order.by === 'key' ? a.prefix.localeCompare(b.prefix)
        : order.by === 'env' ? a.environment.localeCompare(b.environment) || a.prefix.localeCompare(b.prefix)
        : order.by === 'used' ? ts(a.lastUsedAt) - ts(b.lastUsedAt)
        : ts(a.createdAt) - ts(b.createdAt)) || b.id - a.id);
  }, [keys, q, env, app, state, order]);

  const sel = useSelection(rows.map((k) => String(k.id)));
  const list = useListKeys({
    count: rows.length,
    onOpen: (i) => openKey(rows[i].id),
    onToggle: (i) => sel.toggle(String(rows[i].id)),
    onClear: () => { if (!detailOpen) sel.clear(); },
    enabled: !creating && !detailOpen,
  });
  const openKey = (id: number) => { setOpenId(id); setDetailOpen(true); };
  const detail = keys?.find((k) => k.id === openId) ?? null;

  const live = keys?.filter((k) => !k.revokedAt).length ?? 0;
  const admin = roleInfo(meta.me.role).changesSettings;     // only admins make or revoke keys
  const filtered = !!(q || env || app || state !== 'active');
  const clearFilters = () => { setQ(''); setEnv(''); setApp(''); setState('active'); };
  const chosen = rows.filter((k) => sel.isSelected(String(k.id)));
  const revocable = chosen.filter((k) => !k.revokedAt);

  // ---- revoking can't be undone, so every revoke asks first and says so
  const confirmRevoke = (n: number, what: string) => ask({
    title: `Revoke ${what}?`,
    body: <p>Every app or server using {n === 1 ? 'this key' : 'these keys'} stops getting flags right away and falls back to its code defaults. <b className="font-medium">This can’t be undone.</b></p>,
    actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'revoke', label: n === 1 ? 'Revoke key' : `Revoke ${n} keys`, tone: 'danger' }],
  });
  const revokeOne = async (k: KeyRow) => {
    const r = await confirmRevoke(1, `${k.prefix}…`);
    if (r.action === 'revoke') revoke(k);
  };
  // already confirmed; Retry runs it again as it is
  const revoke = async (k: KeyRow) => {
    const where = envName(k.environment).toLowerCase();
    try {
      await api('POST', `/api-keys/${k.id}/revoke`);
      toast(`Revoked ${k.prefix}… in ${where}`);
      setDetailOpen(false);
    } catch (e) { toast(`Couldn’t revoke ${k.prefix}… in ${where}: ${(e as Error).message}`, 'err', { label: 'Retry', onClick: () => revoke(k) }); }
    load();
  };
  // one call per key, in order; one summary at the end
  const revokeSelected = async () => {
    const r = await confirmRevoke(revocable.length, plural(revocable.length, 'key'));
    if (r.action === 'revoke') revokeAll(revocable);
  };
  // already confirmed; each failure keeps its reason, and Retry runs only the failed ones again
  const revokeAll = async (list: KeyRow[]) => {
    const failed: { k: KeyRow; why: string }[] = [];
    for (const [i, k] of list.entries()) {
      setBusy(`Revoking ${i + 1} of ${list.length}…`);
      try { await api('POST', `/api-keys/${k.id}/revoke`); } catch (e) { failed.push({ k, why: (e as Error).message }); }
    }
    setBusy(null); sel.clear(); load();
    const done = list.length - failed.length;
    const envs = [...new Set(list.map((k) => k.environment))];
    const where = envs.length === 1 ? ` in ${envName(envs[0]).toLowerCase()}` : '';
    if (!failed.length) { toast(`Revoked ${plural(done, 'key')}${where}`); return; }
    toast([done && `Revoked ${plural(done, 'key')}${where}`, `${plural(failed.length, 'key')} not revoked: ${failed[0].why}`].filter(Boolean).join(' · '), 'err',
      { label: 'Retry', onClick: () => revokeAll(failed.map((f) => f.k)) });
  };
  const exportCsv = () => {
    downloadCsv('api-keys.csv', ['prefix', 'label', 'environment', 'app', 'scope', 'entity', 'created_at', 'last_used_at', 'revoked_at'],
      chosen.map((k) => [k.prefix, k.label, k.environment, k.project, k.scope, k.entity, k.createdAt, k.lastUsedAt, k.revokedAt]));
    toast(`Exported ${plural(chosen.length, 'key')} to api-keys.csv`);
  };

  const onSort = (by: Sort, dir: 'asc' | 'desc') => setOrder({ by, dir });
  const sortProps = { sort: order.by, dir: order.dir, onSort };

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <PageBar title="API keys" count={loadError ? undefined : <CountSlot text={keys ? `${live} in use` : undefined} />}
        actions={admin ? <Button onClick={() => setCreating(true)}>+ Create key</Button> : <span className="text-13 text-ink-3">Only admins make and revoke keys</span>}>
        <SearchField ref={search} className="w-[240px] max-md:w-auto max-md:flex-1 max-md:basis-full" placeholder="Search  /" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search keys by prefix or label" />
        <FilterSelect label="Environment" value={env} onChange={setEnv} options={[['', 'All'], ...meta.environments.map((e) => [e.key, envName(e.key)] as [string, string])]} />
        <FilterSelect label="App" value={app} onChange={setApp} options={[['', 'All'], ...meta.projects.map((p) => [p.key, p.key] as [string, string])]} />
        <FilterSelect<State> label="State" value={state} onChange={setState} options={[['active', 'Active'], ['revoked', 'Revoked'], ['all', 'All']]} />
        {filtered && <button type="button" onClick={clearFilters} className={barTextButton}>Reset</button>}
      </PageBar>

      <div role="table" aria-label="API keys" className="flex-1">
        <div role="row" className={cn(COLS, tableHeadClass)}>
          <RowCheck checked={sel.all} indeterminate={sel.some} onChange={sel.toggleAll} label="Select all keys" />
          <SortHeader label="Key" sortKey="key" {...sortProps} />
          <span className={MD}><SortHeader label="Environment" sortKey="env" {...sortProps} /></span>
          <span className={MD}>App</span>
          <ColumnHead className={XL} label="Asks about" help="Which entries of your dimensions the key may ask about. A backend names the one it wants in the address, by its dimension: /sdk/v1/flagd/<dimension>/<key>." />
          <SortHeader label="Last used" sortKey="used" {...sortProps} />
          <span className={MD}><SortHeader label="Created" sortKey="created" {...sortProps} /></span>
        </div>
        {loadError ? (
          <Callout tone="error" role="alert" className="m-6 flex flex-wrap items-center gap-x-4 gap-y-2 max-sm:m-4">
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">Couldn’t load the keys: {loadError}</span>
            <span className={BAR_CONTROLS}><Button variant="secondary" disabled={retrying} onClick={retry}>{retrying ? 'Trying…' : 'Try again'}</Button></span>
          </Callout>
        )
          : !keys ? <SkeletonRows cols={COLS} cells={['', '', MD, MD, XL, '', MD]} />
          : rows.length === 0 ? (
            <div className="px-6 py-10 max-sm:px-4">
              <Empty action={filtered ? <Button variant="secondary" onClick={clearFilters}>Clear filters</Button> : <Button onClick={() => setCreating(true)}>+ Create key</Button>}>
                {filtered ? 'No keys match these filters.' : 'No keys yet. Each backend server needs a key for an environment before it can download its rules. Apps don’t need one.'}
              </Empty>
            </div>
          ) : rows.map((k, i) => (
            <div key={k.id} role="row" data-row-index={i} data-active={list.active === i} aria-selected={sel.isSelected(String(k.id))}
              onClick={() => { list.setActive(i); openKey(k.id); }} className={cn(COLS, tableRowClass, 'cursor-default', k.revokedAt && 'text-ink-3')}>
              <RowCheck checked={sel.isSelected(String(k.id))} onChange={() => sel.toggle(String(k.id))} label={`Select ${k.prefix}`} />
              <span role="cell" className="min-w-0">
                <button type="button" className={openButton} aria-haspopup="dialog" onClick={(e) => { e.stopPropagation(); list.setActive(i); openKey(k.id); }}>
                  <span className="flex min-w-0 items-center gap-2">
                    <code className={cn('truncate font-mono text-13 font-medium', k.revokedAt && 'font-normal line-through decoration-ink-4')}>{k.prefix}…</code>
                    {k.revokedAt && <Badge kind="danger">revoked</Badge>}
                  </span>
                  {k.label && <span className="block truncate text-ink-3">{k.label}</span>}
                </button>
              </span>
              <span role="cell" className={MD}><Badge kind={isProtected(k.environment) ? 'danger' : undefined}>{envName(k.environment)}</Badge></span>
              <span role="cell" className={cn(MD, 'truncate font-mono text-xs text-ink-2')}>{k.project}</span>
              <span role="cell" className={cn(XL, 'truncate text-ink-2')}>{scopeText(k, meta)}</span>
              <span role="cell" className={time}>{k.lastUsedAt ? <When iso={k.lastUsedAt} /> : 'never'}</span>
              <span role="cell" className={cn(MD, time)}><When iso={k.createdAt} /></span>
            </div>
          ))}
      </div>

      <div className="flex flex-wrap items-center gap-4 border-t border-rule px-6 py-2.5 max-sm:px-4">
        <KeyHints className="max-md:hidden" />
        <span className="flex-1" />
        {keys && !loadError && <span className="font-mono text-11 text-ink-3 uppercase">{rows.length === keys.length ? plural(keys.length, 'key') : `${rows.length} of ${plural(keys.length, 'key')}`}</span>}
      </div>

      <BulkBar count={sel.count} onClear={sel.clear}>
        {busy ? <span className="text-13 text-ink-2">{busy}</span> : <>
          <Button variant="outline" onClick={exportCsv}>Export CSV</Button>
          {admin && revocable.length > 0 && <Button variant="stop" onClick={revokeSelected}>{revocable.length === chosen.length ? 'Revoke' : `Revoke ${revocable.length} active`}</Button>}
        </>}
      </BulkBar>

      <KeyDrawer k={detail} open={detailOpen && !!detail} onClose={() => setDetailOpen(false)} onRevoke={admin ? revokeOne : undefined} />
      {/* mounted only while open: after Done, the new key is gone from memory */}
      {creating && <CreateKey onClose={() => setCreating(false)} onCreated={() => void load()} />}
    </div>
  );
}

/** One key: where it works, who it means, when it was used; Revoke while it's active. */
function KeyDrawer({ k, open, onClose, onRevoke }: { k: KeyRow | null; open: boolean; onClose: () => void; onRevoke?: (k: KeyRow) => void }) {
  const { meta, toast } = useApp();
  const { envName } = useEnvs();
  const exact = (iso: string) => <>{new Date(iso).toLocaleString()} <span className="text-ink-3">· <When iso={iso} /></span></>;
  return (
    <Drawer open={open} onClose={onClose} title={<span className="font-mono">{k ? `${k.prefix}…` : ''}</span>}
      subtitle={k ? [k.label, envName(k.environment), k.project].filter(Boolean).join(' · ') : undefined}
      footer={k && !k.revokedAt && onRevoke ? <Button variant="stop" onClick={() => onRevoke(k)}>Revoke key</Button> : undefined}>
      {k && <>
        <DrawerSection title="Key">
          <DrawerRow label="State">{k.revokedAt ? <Badge kind="danger">revoked</Badge> : 'Active'}</DrawerRow>
          <DrawerRow label="Prefix"><code className="font-mono">{k.prefix}…</code></DrawerRow>
          <DrawerRow label="Label">{k.label ?? <span className="text-ink-3">—</span>}</DrawerRow>
          <DrawerRow label="Environment">{envName(k.environment)}</DrawerRow>
          <DrawerRow label="App"><span className="font-mono">{k.project}</span> <span className="text-ink-3">· {k.projectKind}</span></DrawerRow>
          <DrawerRow label="Asks about">{scopeText(k, meta)}<span className="block text-ink-3">{SCOPE_HINT[k.scope]}</span></DrawerRow>
        </DrawerSection>
        <DrawerSection title="flagd JSON">
          <DrawerRow label="Address">
            <span className="flex min-w-0 items-center gap-2">
              <code className="min-w-0 truncate font-mono text-13">{flagdAddress(k)}</code>
              {k.scope !== 'all' && <Button variant="secondary" onClick={() => void copyText(`${location.origin}${flagdAddress(k)}`, 'the address', toast)}>Copy</Button>}
            </span>
            <span className="block text-ink-3">{k.scope === 'all' ? 'Put the dimension and the key of the entry it’s for in the address.'
              : k.scope === 'below' ? 'Or the dimension and key of any entry under it.' : 'Send the key in the Authorization header: Bearer <key>.'}</span>
          </DrawerRow>
        </DrawerSection>
        <DrawerSection title="Activity">
          <DrawerRow label="Created">{exact(k.createdAt)}</DrawerRow>
          <DrawerRow label="Last used">{k.lastUsedAt ? exact(k.lastUsedAt) : <span className="text-ink-3">Never</span>}</DrawerRow>
          {k.revokedAt && <DrawerRow label="Revoked">{exact(k.revokedAt)}</DrawerRow>}
        </DrawerSection>
      </>}
    </Drawer>
  );
}

/**
 * The new-key form in a drawer; after creating, the drawer shows the key once. It's mounted only while open, so each
 * opening starts a fresh form and the shown key is forgotten when it closes.
 */
function CreateKey({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const firstField = useRef<HTMLSelectElement>(null);   // the form starts in its first field
  const keyField = useRef<HTMLInputElement>(null);
  const { meta, toast } = useApp();
  const { envName } = useEnvs();
  const servers = meta.projects.filter((p) => p.kind === 'server');
  // the first environment and server until one is picked (and again if the picked one goes away)
  const [envPick, setEnv] = useState('');
  const env = meta.environments.some((e) => e.key === envPick) ? envPick : meta.environments[0]?.key ?? '';
  const [projectPick, setProject] = useState('');
  const project = servers.some((p) => p.key === projectPick) ? projectPick : servers[0]?.key ?? '';
  const [scope, setScope] = useState('all');
  const [entity, setEntity] = useState('');
  const [label, setLabel] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const { busy, error, run } = useAsync();

  // says "Copied" only once the clipboard has it; the field stays selected either way, to copy by hand
  const copy = async (key: string) => {
    await copyText(key, 'the new key', toast);
    keyField.current?.focus(); keyField.current?.select();
  };
  const create = async () => {
    const r = await run(() => api('POST', '/api-keys', { environment: env, project, scope, entity: scope === 'all' ? undefined : entity, label }));
    if (!r) return;
    setCreated(r.key); setLabel(''); onCreated();
    // no Copy in the toast: it would keep the key after the drawer closes. The drawer has Copy key
    toast(`Key created for ${project} in ${envName(env).toLowerCase()}`);
  };

  return (
    <Drawer open onClose={onClose} title={created ? 'Copy your new key' : 'New key'} initialFocus={firstField}
      subtitle={created ? `${project} · ${envName(env)}` : 'For backend servers. Apps don’t need a key: they read their file at an app link (on each entry’s page).'}
      footer={created ? <>
        <Button onClick={() => copy(created)}>Copy key</Button>
        <Button variant="secondary" onClick={onClose}>Done</Button>
      </> : <>
        <Button disabled={busy || (scope !== 'all' && !entity)} onClick={create}>{busy ? 'Creating…' : 'Create key'}</Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <span className="text-13 text-ink-3">It’s shown once; only its hash is stored.</span>
      </>}>
      {created ? (
        <div className="grid gap-4" role="status">
          <Callout tone="warn"><b className="font-medium">Copy this key now.</b> Only its hash is stored, so it can’t be shown again.</Callout>
          <Input ref={keyField} readOnly value={created} onFocus={(e) => e.target.select()} className="h-[34px] font-mono text-13" aria-label="New API key" />
        </div>
      ) : (
        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
            <Field label="Environment">
              <NativeSelect ref={firstField} className={selectField} value={env} onChange={(e) => setEnv(e.target.value)}>{meta.environments.map((e) => <option key={e.key} value={e.key}>{envName(e.key)}</option>)}</NativeSelect>
            </Field>
            <Field label="Server">
              <NativeSelect className={selectField} value={project} onChange={(e) => setProject(e.target.value)}>{servers.map((p) => <option key={p.key}>{p.key}</option>)}</NativeSelect>
            </Field>
          </div>
          <Field label="Asks about" hint={SCOPE_HINT[scope]}>
            <NativeSelect className={selectField} value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="all">Any entry</option>
              <option value="entity" disabled={meta.entities.length === 0}>Only one</option>
              <option value="below" disabled={meta.entities.length === 0}>One and everything under it</option>
            </NativeSelect>
          </Field>
          {scope !== 'all' && (
            <Field label={capital(joined(meta.dimensions, 'or')) || 'Entry'} required>
              <NativeSelect className={selectField} value={entity} onChange={(e) => setEntity(e.target.value)}>
                <option value="">Pick one</option>
                {meta.dimensions.map((d) => (
                  <optgroup key={d.key} label={title(d)}>
                    {meta.entities.filter((c) => c.dimension === d.key).map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
                  </optgroup>
                ))}
              </NativeSelect>
            </Field>
          )}
          <Field label="Label">
            <Input className="h-[34px] text-13" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="ds production" />
          </Field>
          <ErrorList error={error} />
        </div>
      )}
    </Drawer>
  );
}
