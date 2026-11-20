import type { ReactNode } from 'react';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { Logo } from '@/components/logo';
import { REPO } from '@/lib/source';
import { sidebarTree } from '@/lib/tree';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout tree={sidebarTree()} nav={{ title: <Logo />, url: '/' }} githubUrl={REPO}
      links={[{ text: 'Readme', url: '/' }]} tabs={false}>
      {children}
    </DocsLayout>
  );
}
