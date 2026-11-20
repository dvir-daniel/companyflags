import type { ReactNode } from 'react';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { Logo } from '@/components/logo';
import { SiteTabs } from '@/components/site-tabs';
import { Version } from '@/components/version';
import { REPO } from '@/lib/source';
import { sidebarTree } from '@/lib/tree';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout tree={sidebarTree()} nav={{ title: <Logo />, url: '/' }} githubUrl={REPO} tabs={false}
      sidebar={{ banner: <Version /> }}>
      <SiteTabs />
      {children}
    </DocsLayout>
  );
}
