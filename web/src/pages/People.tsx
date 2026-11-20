import { useMemo, useRef, useState } from 'react';
import { Button } from '@companyflags/ui/components/button';
import { tableHeadClass, tableRowClass } from '@companyflags/ui/components/data-table';
import { NativeSelect } from '@companyflags/ui/components/native-select';
import { barTextButton, FilterSelect, PageBar } from '@companyflags/ui/components/page-bar';
import { SearchField } from '@companyflags/ui/components/search-field';
import { cn } from '@companyflags/ui/lib/utils';
import { api, type User } from '../api.ts';
import { useApp } from '../app.ts';
import { CountSlot } from '../loading.tsx';
import { pagerRow } from '../loadingKit.ts';
import { plural } from '../text.ts';
import { Badge, Empty, ErrorList, PAGE_SIZE, Pager } from '../ui.tsx';
import { useAsync, usePersistentState, useSlashFocus } from '../uiKit.ts';
import { InviteLink, PersonDrawer, ResetLink } from './Settings.tsx';
import { ROLE_OPTIONS, roleName, selectField, useRefresh } from './settingsKit.ts';
import { roleInfo, ROLES } from '../../../server/policy.ts';

/*
 * Settings → People (#/settings/people): everyone who may sign in, and their roles. A page of its own because an organization
 * that signs in with single sign-on can have hundreds of people: search by name or email, filters by role and by status,
 * 50 to a page. Everyone can see it; only admins add people, change roles, send invite links and remove access.
 * The list is the console's own (/meta's users), so it opens at once and filters as you type.
 */

/** person (name, then email), role, status, the row's actions */
const COLS = 'grid grid-cols-[minmax(0,1.6fr)_minmax(180px,1fr)_120px_minmax(0,auto)] max-md:grid-cols-[minmax(0,1fr)_minmax(0,auto)]';
const MD = 'max-md:hidden';
/** a row: the name, then the email under it */
const ROW = 'min-h-[53px]';

type Status = NonNullable<User['status']>;
const STATUS_TEXT: Record<Status, string> = { active: 'Active', invited: 'Invited', no_account: 'No account yet', removed: 'No access' };
const STATUS_HELP: Record<Status, string> = {
  active: 'Signs in and works with the role shown',
  invited: 'Hasn’t used their invite link yet',
  no_account: 'Hasn’t made an account yet: send them an invite link',
  removed: 'An admin removed their access',
};
const statusOf = (u: User): Status => u.status ?? 'active';

export function People() {
  const { meta, toast, ask } = useApp();
  const refresh = useRefresh();
  const admin = roleInfo(meta.me.role).changesSettings;
  // "no account yet" only means something where people sign in with Better Auth; elsewhere they're simply active
  const accounts = meta.signIn === 'better-auth';
  const shownStatus = (u: User): Status => (statusOf(u) === 'no_account' && !accounts ? 'active' : statusOf(u));
  const [q, setQ] = useState('');
  const [role, setRole] = usePersistentState('people.role', '');
  const [status, setStatus] = usePersistentState('people.status', '');
  const [page, setPage] = useState(0);
  const [adding, setAdding] = useState(false);
  const [link, setLink] = useState<{ person: User; invite: string } | null>(null);
  const [resetFor, setResetFor] = useState<{ person: User; token: string } | null>(null);
  // a role on its way: the select shows it, and waits, until the people list has reloaded with it
  const [roleChange, setRoleChange] = useState<{ person: string; role: string } | null>(null);
  const { error, setError, run } = useAsync();
  const search = useRef<HTMLInputElement>(null);
  useSlashFocus(search, !adding && !link);
  const firstName = (u: User) => (u.name === u.key ? u.key : u.name);

  const needle = q.trim().toLowerCase();
  // everyone, by name; then what the filters and the search leave
  const everyone = useMemo(() => [...meta.users].sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key)), [meta.users]);
  const matches = (u: User, ignore?: 'role' | 'status') =>
    (ignore === 'role' || !role || u.role === role)
    && (ignore === 'status' || !status || shownStatus(u) === status)
    && (!needle || u.name.toLowerCase().includes(needle) || u.key.toLowerCase().includes(needle));
  const rows = everyone.filter((u) => matches(u));
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const at = Math.min(page, pages - 1);
  const shown = rows.slice(at * PAGE_SIZE, (at + 1) * PAGE_SIZE);
  const filtered = !!(needle || role || status);
  const reset = () => { setQ(''); setRole(''); setStatus(''); setPage(0); };
  const filter = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(0); };
  // each choice says how many it would show with the other filters as they are
  const roleOptions: [string, string][] = [['', 'All'], ...ROLES.map((r) => [r, `${roleName(r)} · ${everyone.filter((u) => u.role === r && matches(u, 'role')).length}`] as [string, string])];
  const statuses = (Object.keys(STATUS_TEXT) as Status[]).filter((s) => s !== 'no_account' || accounts);
  const statusOptions: [string, string][] = [['', 'All'], ...statuses.map((s) => [s, `${STATUS_TEXT[s]} · ${everyone.filter((u) => shownStatus(u) === s && matches(u, 'status')).length}`] as [string, string])];

  const newLink = async (u: User) => {
    setError(null);
    const r = await run(() => api<{ invite: string }>('POST', `/people/${encodeURIComponent(u.key)}/invite`));
    if (!r) return;
    setLink({ person: u, invite: r.invite });
    void refresh();
  };
  const resetLink = async (u: User) => {
    setError(null);
    const r = await run(() => api<{ token: string }>('POST', `/people/${encodeURIComponent(u.key)}/password-reset`));
    if (r) setResetFor({ person: u, token: r.token });
  };
  const remove = async (u: User) => {
    const { action } = await ask({
      title: `Remove ${firstName(u)}’s access?`,
      body: <p>They’re signed out everywhere at once and can’t sign in again unless you invite them again. Their name stays in the history.</p>,
      actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'remove', label: 'Remove access', tone: 'danger' }],
    });
    if (action !== 'remove') return;
    setError(null);
    if (!(await run(() => api('DELETE', `/people/${encodeURIComponent(u.key)}`)))) return;
    toast(`${firstName(u)} can’t sign in any more`);
    void refresh();
  };
  const changeRole = async (u: User, next: string) => {
    if (next === u.role) return;
    setError(null);
    if (u.key === meta.me.key && !roleInfo(next).changesSettings) {
      // only admins change roles (policy.ts changesSettings), so a new role for yourself takes your admin access away
      const { action } = await ask({
        title: `Make yourself ${roleName(next).toLowerCase()}?`,
        body: <p>You won’t be an admin any more: you can’t change settings or roles, and only another admin can make you an admin again.</p>,
        actions: [{ id: 'cancel', label: 'Stay admin' }, { id: 'change', label: `Make me ${roleName(next).toLowerCase()}`, tone: 'danger' }],
      });
      if (action !== 'change') return;
    }
    setRoleChange({ person: u.key, role: next });
    const r = await run(() => api('PUT', `/people/${encodeURIComponent(u.key)}`, { role: next }));
    if (!r) { setRoleChange(null); return; }
    toast(`${u.key} is now ${roleName(next).toLowerCase()}`);
    await refresh();
    setRoleChange(null);
  };

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <PageBar crumbs={<a href="#/settings" className="text-ink-3 no-underline hover:text-ink hover:no-underline">Settings</a>} title="People"
        count={<CountSlot text={filtered ? `${rows.length.toLocaleString()} of ${everyone.length.toLocaleString()}` : everyone.length.toLocaleString()} />}
        actions={admin && <Button onClick={() => setAdding(true)}>+ Add person</Button>} />

      <div role="search" aria-label="Filter people" className="flex flex-wrap items-center gap-2 border-b border-grid px-6 py-2.5 max-sm:px-4">
        <SearchField ref={search} className="w-[260px] max-md:w-auto max-md:flex-1 max-md:basis-full" placeholder="Name or email  /" value={q}
          onChange={(e) => { setQ(e.target.value); setPage(0); }} aria-label="Search people by name or email" />
        <FilterSelect label="Role" value={role} onChange={filter(setRole)} options={roleOptions} />
        <FilterSelect label="Status" value={status} onChange={filter(setStatus)} options={statusOptions} />
        {filtered && <button type="button" onClick={reset} className={barTextButton}>Reset</button>}
      </div>

      {error && <div className="px-6 pt-3 max-sm:px-4"><ErrorList error={error} /></div>}

      <div role="table" aria-label="People" className="flex-1">
        <div role="row" className={cn(COLS, tableHeadClass)}>
          <span role="columnheader">Person</span><span role="columnheader" className={MD}>Role</span>
          <span role="columnheader" className={MD}>Status</span><span />
        </div>
        {shown.length === 0 ? (
          <div className="px-6 py-10 max-sm:px-4">
            <Empty action={filtered ? <Button variant="secondary" onClick={reset}>Clear filters</Button> : undefined}>
              {filtered ? `No one matches ${[needle && `“${q.trim()}”`, role && roleName(role).toLowerCase(), status && STATUS_TEXT[status as Status].toLowerCase()].filter(Boolean).join(', ')}.` : 'No people yet.'}
            </Empty>
          </div>
        ) : shown.map((u) => {
          const s = shownStatus(u);
          return (
            <div key={u.key} role="row" className={cn(COLS, tableRowClass, ROW, s === 'removed' && 'text-ink-3')}>
              <span role="cell" className="min-w-0">
                <span className="block truncate text-13 font-medium">{u.name}{u.key === meta.me.key && <span className="font-normal text-ink-3"> (you)</span>}</span>
                <span className="block truncate font-mono text-11 text-ink-3">{u.key}</span>
              </span>
              <span role="cell" className={MD}>
                {admin && s !== 'removed' ? (
                  <NativeSelect className={selectField} value={roleChange?.person === u.key ? roleChange.role : u.role} aria-label={`Role for ${u.name}`}
                    disabled={!!roleChange} aria-busy={roleChange?.person === u.key || undefined}
                    onChange={(e) => void changeRole(u, e.target.value)}>
                    {ROLE_OPTIONS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                  </NativeSelect>
                ) : <span className="text-13 text-ink-2">{roleName(u.role)}</span>}
              </span>
              <span role="cell" className={MD} title={STATUS_HELP[s]}>
                {s === 'active' ? <span className="text-13 text-ink-2">Active</span> : <Badge kind={s === 'removed' ? undefined : 'warn'}>{STATUS_TEXT[s]}</Badge>}
              </span>
              <span role="cell" className="flex justify-end gap-2">
                {/* on a phone the role and status columns are hidden: the status goes here */}
                {s !== 'active' && <span className="md:hidden"><Badge kind={s === 'removed' ? undefined : 'warn'}>{STATUS_TEXT[s]}</Badge></span>}
                {admin && s === 'invited' && <Button variant="secondary" onClick={() => void newLink(u)}>New link</Button>}
                {admin && s === 'no_account' && u.key !== meta.me.key && <Button variant="secondary" onClick={() => void newLink(u)}>Invite link</Button>}
                {admin && s === 'removed' && <Button variant="secondary" onClick={() => void newLink(u)}>Invite again</Button>}
                {admin && s === 'active' && u.key !== meta.me.key && <Button variant="secondary" onClick={() => void resetLink(u)}>Reset password</Button>}
                {admin && s !== 'removed' && u.key !== meta.me.key && <Button variant="secondary" onClick={() => void remove(u)}>Remove</Button>}
              </span>
            </div>
          );
        })}
      </div>

      <div className={cn('flex flex-wrap items-center gap-4 border-t border-rule px-6 max-sm:px-4', pagerRow)}>
        <span className="text-13 text-ink-3 max-md:hidden">
          {plural(everyone.filter((u) => shownStatus(u) !== 'removed').length, 'person', 'people')} can sign in. With single sign-on, people at your organization’s domains join on their own as viewers.
        </span>
        <span className="flex-1" />
        <Pager page={at} size={PAGE_SIZE} matched={rows.length} noun="people" onPage={(p) => { setPage(p); search.current?.closest('main')?.scrollTo({ top: 0 }); }} />
      </div>

      {adding && <PersonDrawer onClose={() => setAdding(false)} onAdded={(person, invite) => { setAdding(false); setLink({ person, invite }); }} />}
      {link && <InviteLink person={link.person} invite={link.invite} onClose={() => setLink(null)} />}
      {resetFor && <ResetLink person={resetFor.person} token={resetFor.token} onClose={() => setResetFor(null)} />}
    </div>
  );
}
