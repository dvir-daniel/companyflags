import type { ReactNode } from 'react';
import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { Logo } from '@/components/logo';
import { BASE, REPO } from '@/lib/source';
import { PRODUCTS, RESOURCES } from '@/lib/resources';

// The landing page's bar: the name, then the parts of the site in small capitals, as better-auth.com's. No search here:
// it's on the docs' pages.
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <HomeLayout nav={{ title: <Logo />, url: '/' }} searchToggle={{ enabled: false }}
      links={[
        { text: 'Readme', url: '/', active: 'url' },
        { text: 'Docs', url: '/guide/introduction' },
        { type: 'menu', text: 'Products', items: PRODUCTS.map((r) => ({ text: r.text, description: r.description, url: r.url })) },
        { text: 'Enterprise', url: '/guide/enterprise' },
        { type: 'menu', text: 'Resources', items: RESOURCES.map((r) => ({
          text: r.text, description: r.description, url: r.url === '/llms.txt' ? `${BASE}/llms.txt` : r.url, external: r.external,
        })) },
        { text: 'GitHub', url: REPO, external: true },
      ]}>
      {children}
    </HomeLayout>
  );
}
