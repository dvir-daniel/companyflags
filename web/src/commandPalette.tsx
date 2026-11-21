import { useEffect, useMemo, useState } from 'react';
import {
  Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@companyflags/ui/components/command';
import { setShortcutsOn, shortcutsOn } from '@companyflags/ui/lib/shortcuts';
import { nextThemeChoice, setTheme } from '@companyflags/ui/lib/theme';
import { api, entityIndex, title, type Meta } from './api.ts';
import { go } from './app.ts';
import { entityHref, flagListPath, historyHref, pageEnv } from './paths.ts';
import { settingsPages } from './pages/settingsKit.ts';
import { signOut } from './session.ts';

/*
 * ⌘K (Ctrl+K elsewhere): one box to go anywhere. Flags (asked of the server as you type), the dimensions' entities
 * (with their dimension and parent, since the same name can be in two), the console's pages, Settings' pages, and a
 * few actions. Enter opens the one chosen; Esc closes it.
 */

type Page = { label: string; href: string; words?: string };
type FlagHit = { key: string; name?: string | null };

/** The console's pages, as the sidebar lists them. */
function pagesOf(meta: Meta): Page[] {
  return [
    { label: 'Flags', href: '#/flags' },
    { label: 'Releases', href: '#/releases' },
    { label: 'Approvals', href: '#/approvals', words: 'requests review' },
    { label: 'History: Changes', href: historyHref('changes'), words: 'audit log' },
    { label: 'History: Revisions', href: historyHref('revisions'), words: 'versions roll back publish' },
    { label: 'History: Requests', href: historyHref('requests'), words: 'approvals' },
    ...meta.dimensions.map((d) => ({ label: title(d), href: `#/dimensions/${encodeURIComponent(d.key)}`, words: 'dimension' })),
    { label: 'Compare', href: '#/compare' },
    { label: 'Services', href: '#/services', words: 'developers apps connect' },
    { label: 'API Keys', href: '#/keys', words: 'developers connect' },
    { label: 'Account', href: '#/tokens', words: 'access tokens two-factor 2fa cli mcp' },
    ...(meta.plugins.includes('webhooks') ? [{ label: 'Webhooks', href: '#/webhooks', words: 'developers connect' }] : []),
  ];
}

export function CommandPalette({ meta, open, onOpenChange, onSearchFlags }: {
  meta: Meta; open: boolean; onOpenChange: (open: boolean) => void; onSearchFlags: () => void;
}) {
  const [q, setQ] = useState('');
  const [flags, setFlags] = useState<FlagHit[]>([]);
  const env = pageEnv(meta);
  // flags are many: the server finds them, a moment after typing stops
  useEffect(() => {
    if (!open) return;
    let live = true;
    const t = setTimeout(() => {
      const path = flagListPath({ env, q: q.trim(), status: '', kind: '', owner: '', tag: '', sort: 'key', dir: 'asc' }, 0);
      api<{ rows: FlagHit[] }>('GET', path).then((r) => { if (live) setFlags(r.rows.slice(0, 8)); }, () => { if (live) setFlags([]); });
    }, q ? 150 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [open, q, env]);
  const byKey = useMemo(() => entityIndex(meta.entities), [meta.entities]);
  const dimName = (k: string) => { const d = meta.dimensions.find((x) => x.key === k); return d ? title(d) : k; };
  // entities only once something is typed: there can be thousands
  const needle = q.trim().toLowerCase();
  const entities = needle ? meta.entities.filter((e) => e.name.toLowerCase().includes(needle) || e.key.toLowerCase().includes(needle)).slice(0, 8) : [];
  const run = (fn: () => void) => { onOpenChange(false); setQ(''); fn(); };
  const to = (href: string) => run(() => { location.hash = href; });

  return (
    <CommandDialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) setQ(''); }}
      title="Go to" description="Search flags, entities, pages, settings and actions">
      {/* the server already matched the flags, so the box keeps them as they are; the rest it matches itself */}
      <Command loop>
        <CommandInput value={q} onValueChange={setQ} placeholder="Search flags, pages, settings…" aria-label="Search the console" />
        <CommandList>
          <CommandEmpty>Nothing matches “{q.trim()}”.</CommandEmpty>
          {flags.length > 0 && (
            <CommandGroup heading="Flags">
              {flags.map((f) => (
                <CommandItem key={f.key} value={`flag ${f.key} ${f.name ?? ''}`} onSelect={() => run(() => go(`flag/${f.key}/${env}`))}>
                  <span className="font-mono text-13">{f.key}</span>
                  {f.name && <span className="truncate text-ink-3">{f.name}</span>}
                </CommandItem>
              ))}
              <CommandItem value={`search flags list ${q}`} onSelect={() => run(onSearchFlags)}>
                <span>Search in the flag list</span>
              </CommandItem>
            </CommandGroup>
          )}
          {entities.length > 0 && (
            <CommandGroup heading="Entities">
              {entities.map((e) => {
                const parent = e.parent ? byKey.get(e.parent) : undefined;
                return (
                  <CommandItem key={`${e.dimension}/${e.key}`} value={`entity ${e.name} ${e.key} ${dimName(e.dimension)}`} onSelect={() => to(entityHref(e.dimension, e.key))}>
                    <span className="truncate">{e.name}</span>
                    <span className="truncate text-ink-3">{dimName(e.dimension)}{parent ? ` · in ${parent.name}` : ''}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          )}
          <CommandGroup heading="Pages">
            {pagesOf(meta).map((p) => (
              <CommandItem key={p.href} value={`page ${p.label} ${p.words ?? ''}`} onSelect={() => to(p.href)}>{p.label}</CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="Settings">
            {settingsPages(meta.plugins).map((s) => (
              <CommandItem key={s.key} value={`settings ${s.label}${s.key === 'migration' ? ' import export' : ''}`} onSelect={() => to(`#/settings/${s.key}`)}>Settings: {s.label}</CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="Actions">
            <CommandItem value="action theme light dark auto" onSelect={() => run(() => setTheme(nextThemeChoice()))}>
              Theme: switch to {nextThemeChoice() === 'auto' ? 'auto' : nextThemeChoice()}
            </CommandItem>
            <CommandItem value="action keyboard single-key shortcuts" onSelect={() => run(() => setShortcutsOn(!shortcutsOn()))}>
              {shortcutsOn() ? 'Turn single-key shortcuts off' : 'Turn single-key shortcuts on'}
            </CommandItem>
            {meta.signIn === 'accounts' && <CommandItem value="action sign out" onSelect={() => run(() => void signOut())}>Sign out</CommandItem>}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
