import type { ReactNode } from 'react';
import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { Logo } from '@/components/logo';
import { REPO } from '@/lib/source';
import { RESOURCES, resourceHref } from '@/lib/resources';

// The landing page's bar below 1024px (above it, the site's bar takes over): the name, then the parts of the site in
// small capitals, and light or dark in the phone's menu. No search here: it's on the docs' pages.
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <HomeLayout nav={{ title: <Logo />, url: '/' }} searchToggle={{ enabled: false }}
      links={[
        { text: 'Home', url: '/', active: 'url' },
        { text: 'Docs', url: '/guide/introduction' },
        { text: 'Enterprise', url: '/guide/enterprise' },
        { type: 'menu', text: 'Resources', items: RESOURCES.map((r) => ({
          text: r.text, description: r.description, url: resourceHref(r), external: r.external,
        })) },
        { text: 'GitHub', url: REPO, external: true },
      ]}>
      {children}
    </HomeLayout>
  );
}
