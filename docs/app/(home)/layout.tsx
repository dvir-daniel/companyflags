import type { ReactNode } from 'react';
import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { Logo } from '@/components/logo';
import { REPO } from '@/lib/source';

// The landing page's bar: the name, then the parts of the site in small capitals, as better-auth.com's. No search here:
// it's on the docs' pages.
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <HomeLayout nav={{ title: <Logo />, url: '/' }} searchToggle={{ enabled: false }}
      links={[
        { text: 'Readme', url: '/', active: 'url' },
        { text: 'Docs', url: '/guide/introduction' },
        { text: 'OpenFeature', url: '/sdk/openfeature' },
        { text: 'Self-hosting', url: '/self-hosting/docker' },
        { text: 'Reference', url: '/reference/http-api' },
        { text: 'GitHub', url: REPO, external: true },
      ]}>
      {children}
    </HomeLayout>
  );
}
