'use client';
// The bar across the top of the docs' pages on a wide screen, as better-auth.com's: the parts of the site as small
// capital cells divided by 1px lines, the open part underlined, a RESOURCES menu, GitHub inverted. (On a phone the
// docs' own bar shows.)
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { BASE, REPO } from '@/lib/source';
import { RESOURCES } from '@/lib/resources';

const TABS: { text: string; url: string; match: (p: string) => boolean }[] = [
  { text: 'Readme', url: '/', match: (p) => p === '/' },
  { text: 'Docs', url: '/guide/introduction', match: (p) => p.startsWith('/guide/') && p !== '/guide/security' },
  { text: 'OpenFeature', url: '/sdk/openfeature', match: (p) => p.startsWith('/sdk/') },
  { text: 'Self-hosting', url: '/self-hosting/docker', match: (p) => p.startsWith('/self-hosting/') },
  { text: 'Reference', url: '/reference/http-api', match: (p) => p.startsWith('/reference/') || p === '/guide/security' },
];

function Resources() {
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
    <div ref={box} className="cf-tabs-menu" data-open={open || undefined}>
      <button type="button" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((o) => !o)}>
        Resources
        <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
      </button>
      {open && (
        <div className="cf-tabs-panel" role="menu">
          {RESOURCES.map((r) => {
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
      <Resources />
      <a href={REPO} className="cf-tabs-github">GitHub</a>
    </nav>
  );
}
