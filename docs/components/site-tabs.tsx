'use client';
// The bar across the top of the docs' pages on a wide screen, as better-auth.com's: the parts of the site as small
// capital cells divided by 1px lines, the open part underlined, PRODUCTS and RESOURCES menus, GitHub inverted. (On a phone the
// docs' own bar shows.)
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { BASE, REPO } from '@/lib/source';
import { PRODUCTS, RESOURCES } from '@/lib/resources';

const PARTS = ['/sdk/', '/self-hosting/', '/reference/'];
const TABS: { text: string; url: string; match: (p: string) => boolean }[] = [
  { text: 'Readme', url: '/', match: (p) => p === '/' },
  { text: 'Docs', url: '/guide/introduction', match: (p) => p.startsWith('/guide/') && p !== '/guide/enterprise' },
];
const AFTER: typeof TABS = [
  { text: 'Enterprise', url: '/guide/enterprise', match: (p) => p === '/guide/enterprise' },
];

function Menu({ label, items, active }: { label: string; items: { text: string; description: string; url: string; external?: boolean }[]; active?: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const path = usePathname();
  useEffect(() => { setOpen(false); }, [path]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    addEventListener('mousedown', away);
    addEventListener('keydown', esc);
    return () => { removeEventListener('mousedown', away); removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div ref={box} className="cf-tabs-menu" data-open={open || undefined} data-active={active || undefined}>
      <button type="button" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((o) => !o)}>
        {label}
        <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
      </button>
      {open && (
        <div className="cf-tabs-panel" role="menu">
          {items.map((r) => {
            const body = <><b>{r.text}</b><span>{r.description}</span></>;
            return r.external
              ? <a key={r.text} role="menuitem" href={r.url === '/llms.txt' ? `${BASE}/llms.txt` : r.url}>{body}</a>
              : <Link key={r.text} role="menuitem" href={r.url}>{body}</Link>;
          })}
        </div>
      )}
    </div>
  );
}

export function SiteTabs() {
  const path = usePathname();
  return (
    <nav aria-label="Site" className="cf-tabs">
      {TABS.map((t) => (
        <Link key={t.url} href={t.url} data-active={t.match(path) || undefined}>{t.text}</Link>
      ))}
      <Menu label="Products" items={PRODUCTS} active={PARTS.some((p) => path.startsWith(p))} />
      {AFTER.map((t) => (
        <Link key={t.url} href={t.url} data-active={t.match(path) || undefined}>{t.text}</Link>
      ))}
      <Menu label="Resources" items={RESOURCES} />
      <a href={REPO} className="cf-tabs-github">GitHub</a>
    </nav>
  );
}
