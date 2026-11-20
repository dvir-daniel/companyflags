'use client';
// The bar across the top of the docs' pages on a wide screen, as better-auth.com's: the parts of the site as small
// capital cells divided by 1px lines, the open part underlined, GitHub inverted. (On a phone the docs' own bar shows.)
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { REPO } from '@/lib/source';

const TABS: { text: string; url: string; match: (p: string) => boolean }[] = [
  { text: 'Readme', url: '/', match: (p) => p === '/' },
  { text: 'Docs', url: '/guide/introduction', match: (p) => p.startsWith('/guide/') && p !== '/guide/security' },
  { text: 'OpenFeature', url: '/sdk/openfeature', match: (p) => p.startsWith('/sdk/') },
  { text: 'Self-hosting', url: '/self-hosting/docker', match: (p) => p.startsWith('/self-hosting/') },
  { text: 'Reference', url: '/reference/http-api', match: (p) => p.startsWith('/reference/') || p === '/guide/security' },
];

export function SiteTabs() {
  const path = usePathname();
  return (
    <nav aria-label="Site" className="cf-tabs">
      {TABS.map((t) => (
        <Link key={t.url} href={t.url} data-active={t.match(path) || undefined}>{t.text}</Link>
      ))}
      <a href={REPO} className="cf-tabs-github">GitHub</a>
    </nav>
  );
}
