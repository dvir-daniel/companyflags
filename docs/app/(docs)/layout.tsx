import type { ReactNode } from 'react';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { AskAI } from '@/components/ask-ai';
import { Logo } from '@/components/logo';
import { SiteLinks } from '@/components/site-links';
import { Version } from '@/components/version';
import { REPO } from '@/lib/source';
import { sidebarTree } from '@/lib/tree';

// The sidebar's logo hides where the site's bar shows it (1024px and up); below that, its foot lists the bar's links.
// It doesn't collapse: on a wide screen it sits under the bar, at the logo's width.
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout tree={sidebarTree()} nav={{ title: <Logo className="cf-nav-logo" />, url: '/' }} githubUrl={REPO} tabs={false}
      sidebar={{ banner: <Version />, footer: <SiteLinks />, collapsible: false }}>
      {children}
      <AskAI />
    </DocsLayout>
  );
}
