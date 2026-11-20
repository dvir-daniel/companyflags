'use client';
// The site's bar on a wide screen, as better-auth.com's: in the root layout, so it stays while you move between the
// landing page and the docs. The logo's cell on the left is as wide as the column under it (the hero's 40% on the
// landing page, the sidebar's width in the docs) and eases from one to the other; the parts of the site share the
// rest in equal cells, the open one underlined. It comes in once, when the site opens. (On a phone each page keeps its
// own bar.)
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Logo } from './logo';
import { BASE, REPO } from '@/lib/source';
import { RESOURCES } from '@/lib/resources';

type Item = { text: string; description: string; url: string; external?: boolean };

function Menu({ label, items, active }: { label: string; items: Item[]; active?: boolean }) {
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
    <div ref={box} className="cf-bar-cell cf-bar-menu" data-open={open || undefined} data-active={active || undefined}>
      <button type="button" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((o) => !o)}>
        <span>{label}</span>
        <svg viewBox="0 0 16 16" width="8" height="8" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
      </button>
      {open && (
        <div className="cf-bar-panel" role="menu">
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

function Tab({ text, url, active }: { text: string; url: string; active: boolean }) {
  return (
    <div className="cf-bar-cell">
      <Link href={url} data-active={active || undefined}><span>{text}</span></Link>
    </div>
  );
}

export function SiteBar() {
  const path = usePathname() || '/';
  const docs = path !== '/';
  return (
    <div className="cf-bar" data-docs={docs || undefined}>
      <div className="cf-bar-left">
        <Link href="/" aria-label="CompanyFlags, the landing page"><Logo /></Link>
      </div>
      <nav className="cf-bar-right" aria-label="Site">
        <Tab text="Readme" url="/" active={path === '/'} />
        <Tab text="Docs" url="/guide/introduction" active={path !== '/' && path !== '/guide/enterprise'} />
        <Tab text="Enterprise" url="/guide/enterprise" active={path === '/guide/enterprise'} />
        <Menu label="Resources" items={RESOURCES} />
        <div className="cf-bar-cell cf-bar-github"><a href={REPO}><span>GitHub</span></a></div>
      </nav>
    </div>
  );
}
