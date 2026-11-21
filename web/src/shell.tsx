import { useEffect, useState } from 'react';
import { title, type Meta, type User } from './api.ts';
import { Bone } from './loading.tsx';
import { dimensionHref, historyHref, preload } from './paths.ts';
import { readPersistent } from './persist.ts';
import { signOut } from './session.ts';
import {
  Avatar, Footer as Bar, FooterSlash, Sidebar as Nav, SidebarCount, SidebarFoot, SidebarGroup, SidebarItem, sidebarItemClass, SidebarLabel, SidebarSearch,
  TitleBar as Top, TitleBarBrand, TitleBarStatus,
} from '@companyflags/ui/components/app-frame';
import { ThemeToggle } from '@companyflags/ui/components/theme-toggle';
import { Button } from '@companyflags/ui/components/button';
import { Checkbox } from '@companyflags/ui/components/checkbox';
import { Drawer } from '@companyflags/ui/components/drawer';
import { Popover, PopoverContent, PopoverTrigger } from '@companyflags/ui/components/popover';
import { useBottomReserve } from '@companyflags/ui/components/toast';
import { setShortcutsOn, useShortcutsOn } from '@companyflags/ui/lib/shortcuts';
import { cn } from '@companyflags/ui/lib/utils';
import { roleInfo } from '../../server/policy.ts';
import { Brand, LookLinks } from './look.tsx';
import { lookName, useLook } from './appearanceKit.ts';

/* This console's window, built from @companyflags/ui's frame (app-frame.tsx): the title bar, the sidebar and the
   mono footer with who is signed in. On a phone the sidebar and the footer give way to a tab bar at the bottom
   (MobileNav), whose More opens the whole sidebar as a panel.
   Before the console knows who is signed in (`meta` null, the first load), they draw in the same shape with
   placeholders, so the window is there at once and nothing in it moves when /meta answers. */

/** Sidebar icons, drawn on an 18px grid with a 1.25 stroke. */
const PATHS = {
  flags: <><path d="M4 16V2.5" /><path d="M4 3h9.5l-2 3.5 2 3.5H4" /></>,
  releases: <><path d="M2.5 15.5h4v-4h4v-4h4v-4h1" /><path d="M2.5 15.5h13" /></>,
  entities: <><rect x="3" y="5" width="7" height="10.5" /><path d="M10 8.5h5v7h-5M5.5 8h2M5.5 11h2" /></>,
  compare: <><rect x="2.5" y="3.5" width="5.5" height="11" /><rect x="10" y="3.5" width="5.5" height="11" /></>,
  approvals: <><rect x="3" y="3" width="12" height="12" /><path d="m6 9.2 2.1 2.1L12.2 7" /></>,
  services: <><rect x="2.5" y="3" width="13" height="4.5" /><rect x="2.5" y="10.5" width="13" height="4.5" /><path d="M5 5.25h1.5M5 12.75h1.5" /></>,
  keys: <><circle cx="6" cy="9" r="3.2" /><path d="M9.2 9H16M13.5 9v2.6M15.6 9v2" /></>,
  tokens: <><rect x="2.5" y="4.5" width="13" height="9" /><path d="M5.5 9h7M5.5 11.5h4" /></>,
  history: <><circle cx="9" cy="9" r="6.3" /><path d="M9 5.4V9l2.6 1.6" /></>,
  migration: <><path d="M2.5 6h11M10.5 3l3 3-3 3" /><path d="M15.5 12h-11M7.5 9l-3 3 3 3" /></>,
  webhooks: <><circle cx="5" cy="13" r="2.2" /><circle cx="13" cy="13" r="2.2" /><circle cx="9" cy="5" r="2.2" /><path d="M8 7l-2.2 4M10 7l2.2 4M7.2 13h3.6" /></>,
  settings: <><circle cx="9" cy="9" r="2.4" /><path d="M9 2.5v2.2M9 13.3v2.2M2.5 9h2.2M13.3 9h2.2M4.4 4.4l1.6 1.6M12 12l1.6 1.6M4.4 13.6 6 12M12 6l1.6-1.6" /></>,
  search: <><circle cx="8" cy="8" r="4.5" /><path d="m11.4 11.4 3.6 3.6" /></>,
  more: <><path d="M3 5h12M3 9h12M3 13h12" /></>,
} as const;
export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 15 }: { name: IconName; size?: number }) {
  return (
    <svg viewBox="0 0 18 18" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

// A page in the sidebar. `href`: its address (#/<key> when not given); `current`: whether the page at this address is it.
type NavItem = { key: string; label: string; icon: IconName; href?: string; current: (page: string, sub?: string) => boolean };
const plainPage = (key: string, also?: string): Pick<NavItem, 'key' | 'current'> => ({ key, current: (p) => p === key || p === also });

// The sidebar: each item a short noun in Title Case, the same words as the page's title
// and the tab's, an icon on each, and a small caption over each group that holds one kind of thing.
//   (no caption)  what the console is for, every day: the flags, their releases, what waits for review, what happened,
//                 and Compare (who gets what, side by side)
//   Audience      the installation's own dimensions, top to bottom ("Regions", "Stores"); none until there is one
//   Developers    what apps and backends connect with: their services, their API keys, and webhooks
//   Settings      on its own at the end, with its own menu (environments, dimensions, people, sign-in, migration…)
// Each person's own access tokens and two-factor sign-in are in the account menu (Account), not here.
// Before /meta answers, the parts that depend on it (how many dimensions, whether webhooks run) draw as they did last
// time (shell.dims, shell.webhooks), so nothing moves when it answers.
type NavGroup = { group?: string; items: NavItem[]; bones?: number };
function navOf(meta: Meta | null): NavGroup[] {
  const dims = meta?.dimensions ?? [];
  const webhooks = meta ? meta.plugins.includes('webhooks') : readPersistent('shell.webhooks', true);
  return [
    { items: [
      { ...plainPage('flags', 'flag'), label: 'Flags', icon: 'flags' },
      { ...plainPage('releases', 'release'), label: 'Releases', icon: 'releases' },
      { ...plainPage('approvals'), label: 'Approvals', icon: 'approvals' },
      { ...plainPage('history'), label: 'History', icon: 'history' },
      { ...plainPage('compare'), label: 'Compare', icon: 'compare' },
    ] },
    ...(meta ? (dims.length ? [{ group: 'Audience', items: dims.map((d): NavItem => ({
      key: `dimensions/${d.key}`, label: title(d), icon: 'entities', href: dimensionHref(d.key),
      current: (p, sub) => p === 'dimensions' && sub === d.key,
    })) }] : []) : readPersistent('shell.dims', 0) > 0 ? [{ group: 'Audience', items: [], bones: readPersistent('shell.dims', 0) }] : []),
    { group: 'Developers', items: [
      { ...plainPage('services'), label: 'Services', icon: 'services' },
      { ...plainPage('keys'), label: 'API Keys', icon: 'keys' },
      ...(webhooks ? [{ ...plainPage('webhooks'), label: 'Webhooks', icon: 'webhooks' as const }] : []),
    ] },
    { items: [
      { key: 'settings', label: 'Settings', icon: 'settings', current: (p) => p === 'settings' },
    ] },
  ];
}

// "Alice (editor)" → "Alice": the role is shown on its own line
const shortName = (u: User) => u.name.replace(/\s*\([^)]*\)\s*$/, '');
const PERSON = ['ana', 'kai', 'ben', 'dana', '5', '6', '7', '8'];
const personColor = (meta: Meta, u: User) => `var(--person-${PERSON[Math.max(0, meta.users.findIndex((x) => x.key === u.key)) % PERSON.length]})`;
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function TitleBar({ synced }: { synced: boolean }) {
  const look = useLook();
  return (
    <Top>
      {/* the first stop for the keyboard: past the title bar and the sidebar, to the page (MainPane, id "main"). The
          address doesn't change: it's the console's router */}
      <a href="#main" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}
        className="sr-only focus:not-sr-only focus:absolute focus:top-1.5 focus:left-1.5 focus:z-[80] focus:bg-background focus:px-3 focus:py-2 focus:text-13 focus:text-ink focus:outline-1 focus:outline-ink">
        Skip to content
      </a>
      <TitleBarBrand>
        <a href="#/flags" className="flex min-w-0 items-center text-ink hover:no-underline" aria-label={`${lookName(look)}, go to flags`}>
          <Brand />
        </a>
      </TitleBarBrand>
      <span className="flex-1" />
      <ThemeToggle />
      <TitleBarStatus warn={!synced} role="status">{synced ? 'Synced' : 'Reconnecting'}</TitleBarStatus>
    </Top>
  );
}

// `sub`: the address's second part (which dimension a dimension page is for)
export function Sidebar({ meta, page, sub, pending, onSearch, className }: {
  meta: Meta | null; page: string; sub?: string; pending: number; onSearch: () => void; className?: string;
}) {
  const me = meta?.me;
  const ahead = (href: string) => { if (meta) void preload(href, meta); };
  return (
    <Nav aria-label="Console" className={className}>
      <SidebarSearch onClick={onSearch} icon={<Icon name="search" />} shortcut={isMac ? '⌘K' : 'Ctrl K'} aria-keyshortcuts={isMac ? 'Meta+K' : 'Control+K'}>Search</SidebarSearch>
      {navOf(meta).map((g, i) => (
        <SidebarGroup key={g.group ?? i} label={g.group}>
          {Array.from({ length: g.bones ?? 0 }, (_, b) => (
            <div key={`bone-${b}`} aria-hidden className={cn(sidebarItemClass, 'pointer-events-none')}><Icon name="entities" /><Bone className="w-20" /></div>
          ))}
          {g.items.map((n) => (
            <SidebarItem key={n.key} href={n.href ?? `#/${n.key}`} aria-current={n.current(page, sub) ? 'page' : undefined}
              onPointerEnter={() => ahead(n.href ?? `#/${n.key}`)} onFocus={() => ahead(n.href ?? `#/${n.key}`)}>
              <Icon name={n.icon} />
              {n.label}
              {n.key === 'approvals' && pending > 0 && <SidebarCount aria-label={`${pending} waiting for your review`}>{pending}</SidebarCount>}
            </SidebarItem>
          ))}
        </SidebarGroup>
      ))}
      <SidebarFoot>
        <SidebarLabel className="px-0">Published</SidebarLabel>
        {meta ? meta.environments.map((e) => {
          // the revision each environment is on, leading to its revisions (History → Revisions)
          const v = meta.dataPlane[e.key]?.revision;
          return (
            <a key={e.key} href={historyHref('revisions', { env: e.key })} aria-label={`${e.name}: ${v == null ? 'nothing published yet' : `revision ${v}`}. Open its revisions`}
              className="flex justify-between py-px text-13 text-ink-2 no-underline hover:text-ink hover:no-underline">
              <span>{e.name}</span>
              <span className="font-mono text-xs text-ink-3">{v == null ? '—' : `#${v}`}</span>
            </a>
          );
        }) : Array.from({ length: readPersistent('shell.envs', 2) }, (_, i) => (
          // as many environments as last time, so the block doesn't grow when they arrive
          <div key={i} className="flex items-center justify-between py-px text-13"><span className="flex h-[19.5px] items-center"><Bone className="w-20" /></span><Bone className="w-10" /></div>
        ))}
        {meta && me ? <AccountMenu meta={meta} me={me} /> : (
          <div aria-hidden className="mt-3 flex items-center gap-2.5 leading-[1.35]">
            <Bone className="size-6" />
            <div className="grid min-w-0">
              <span className="flex h-[18.9px] items-center"><Bone className="w-20" /></span>
              <span className="flex h-[17.55px] items-center"><Bone className="w-12" /></span>
            </div>
          </div>
        )}
      </SidebarFoot>
    </Nav>
  );
}

/** Get help, where the installation set a link for it (Settings → Appearance). */
function HelpLink() {
  const { helpUrl } = useLook();
  if (!helpUrl) return null;
  return <a href={helpUrl} target="_blank" rel="noopener noreferrer" className="-mt-1 text-13 text-ink underline decoration-ink-4 underline-offset-4 hover:decoration-ink">Get help</a>;
}

/** Single-key shortcuts (j, k, x and / in lists), on or off in this browser (WCAG 2.1.4). */
function ShortcutsChoice() {
  const on = useShortcutsOn();
  return (
    <label className="flex cursor-default items-start gap-2.5 border-t border-rule pt-3 text-13 text-ink">
      <Checkbox checked={on} onCheckedChange={(v) => setShortcutsOn(v === true)} className="mt-0.5" />
      <span className="grid gap-0.5">
        Single-key shortcuts
        <span className="text-ink-3">J, K and X in lists, / to search. The arrow keys always work in a list.</span>
      </span>
    </label>
  );
}

/** Who is signed in, at the foot of the sidebar: a button that opens their account menu, with their access tokens,
 *  the keyboard shortcuts and Sign out. */
function AccountMenu({ meta, me }: { meta: Meta; me: User }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="mt-3 -mx-2 flex w-[calc(100%+16px)] cursor-pointer items-center gap-2.5 border-0 bg-transparent px-2 py-1.5 text-left leading-[1.35] text-ink hover:bg-wash aria-expanded:bg-wash"
        aria-label={`${shortName(me)}, ${roleInfo(me.role).label}: account menu`}>
        <Avatar initials={shortName(me).slice(0, 2).toUpperCase()} color={personColor(meta, me)} />
        <div className="min-w-0 flex-1">
          <b className="block truncate font-medium" title={me.key}>{shortName(me)}</b>
          <div className="text-13 text-ink-2">{roleInfo(me.role).label}</div>
        </div>
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" className="shrink-0 text-ink-3"><path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="grid w-64 gap-3">
        <div className="grid gap-0.5">
          <b className="truncate font-medium text-ink">{me.name || shortName(me)}</b>
          <span className="truncate text-ink-2">{me.key}</span>
          <span className="text-ink-3">{roleInfo(me.role).label}</span>
        </div>
        <a href="#/tokens" onClick={() => setOpen(false)} className="border-t border-rule pt-3 text-13 text-ink underline decoration-ink-4 underline-offset-4 hover:decoration-ink">Account: two-factor and access tokens</a>
        <HelpLink />
        <ShortcutsChoice />
        {meta.signIn === 'accounts' ? (
          <Button variant="secondary" className="w-full" disabled={busy} onClick={() => { setBusy(true); void signOut(); }}>{busy ? 'Signing out…' : 'Sign out'}</Button>
        ) : (
          <p className="m-0 border-t border-rule pt-3 text-ink-3">This server signs people in itself, so there’s nothing to sign out of here.</p>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function Footer({ meta }: { meta: Meta | null }) {
  const me = meta?.me;
  return (
    <Bar className="max-md:hidden">
      <span>CompanyFlags {__APP_VERSION__}</span>
      <span className="contents max-md:hidden">
        <FooterSlash />
        {me ? <span className="min-w-0 truncate">Signed in as {me.key}, {roleInfo(me.role).label.toLowerCase()}</span> : <Bone className="w-48" />}
      </span>
      <span className="flex-1" />
      <LookLinks />
      {meta?.signIn === 'accounts' && <button type="button" onClick={() => void signOut()} className="cursor-pointer text-ink hover:underline">Sign out</button>}
    </Bar>
  );
}

// The phone's tab bar: the four pages people use most (the top dimension's, or History before there is one), and More
// for the rest (the whole sidebar, in a panel).
function tabsOf(meta: Meta | null): NavItem[] {
  const top = meta?.dimensions[0];
  return [
    { ...plainPage('flags', 'flag'), label: 'Flags', icon: 'flags' },
    { ...plainPage('approvals'), label: 'Approvals', icon: 'approvals' },
    top ? { key: `dimensions/${top.key}`, label: title(top), icon: 'entities', href: dimensionHref(top.key), current: (p, sub) => p === 'dimensions' && sub === top.key }
      : { ...plainPage('history'), label: 'History', icon: 'history' },
    { ...plainPage('compare'), label: 'Compare', icon: 'compare' },
  ];
}
const tabClass = cn('relative flex h-14 min-w-0 cursor-default flex-col items-center justify-center gap-1 border-0 bg-transparent px-1',
  'text-[11px] leading-none text-ink-nav no-underline hover:text-ink hover:no-underline aria-[current=page]:text-ink');

/** Shown only on a phone (narrower than 768px), at the bottom of the window. */
export function MobileNav({ meta, page, sub, pending, onSearch }: { meta: Meta | null; page: string; sub?: string; pending: number; onSearch: () => void }) {
  const [open, setOpen] = useState(false);
  // toasts stay above the tab bar, as above other bars pinned to the bottom (on a computer it's hidden: 0px)
  const reserve = useBottomReserve();
  // going anywhere closes the menu
  useEffect(() => {
    const close = () => setOpen(false);
    addEventListener('hashchange', close);
    return () => removeEventListener('hashchange', close);
  }, []);
  const tabs = tabsOf(meta);
  const inMore = !tabs.some((t) => t.current(page, sub));
  const marker = <span aria-hidden className="absolute inset-x-4 top-0 h-0.5 bg-tint" />;
  return (
    <>
      <nav ref={reserve} aria-label="Console" className="hidden shrink-0 grid-cols-5 border-t border-rule bg-sidebar pb-[env(safe-area-inset-bottom)] max-md:grid">
        {tabs.map((t) => {
          const current = t.current(page, sub);
          const href = t.href ?? `#/${t.key}`;
          return (
            <a key={t.key} href={href} aria-current={current ? 'page' : undefined} className={tabClass}
              onPointerDown={() => { if (meta) void preload(href, meta); }}>
              {current && marker}
              <span className="relative">
                <Icon name={t.icon} size={20} />
                {t.key === 'approvals' && pending > 0 && (
                  <span aria-label={`${pending} waiting for your review`}
                    className="absolute -top-1.5 left-3.5 grid h-4 min-w-4 place-items-center bg-flag px-1 font-mono text-[10px] leading-none text-background">{pending}</span>
                )}
              </span>
              <span className="max-w-full truncate">{t.label}</span>
            </a>
          );
        })}
        <button type="button" onClick={() => setOpen(!!meta)} aria-haspopup="dialog" aria-current={inMore ? 'page' : undefined} className={tabClass}>
          {inMore && marker}
          <Icon name="more" size={20} />
          <span>More</span>
        </button>
      </nav>
      {meta && <Drawer open={open} onClose={() => setOpen(false)} title="Menu" subtitle={`Signed in as ${meta.me.key}`}
        footer={meta.signIn === 'accounts' ? <Button variant="secondary" onClick={() => void signOut()}>Sign out</Button> : undefined}>
        {/* the whole sidebar, as on a computer: search, every page, what's published and who you are */}
        <Sidebar meta={meta} page={page} sub={sub} pending={pending} onSearch={() => { setOpen(false); onSearch(); }}
          className="-mx-1 border-r-0 bg-transparent px-0 py-0 [&_[data-slot=sidebar-item]]:py-3 [&_[data-slot=sidebar-search]]:h-11 [&_kbd]:hidden" />
      </Drawer>}
    </>
  );
}
