import type { ReactNode } from 'react';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { AskAI } from '@/components/ask-ai';
import { Logo } from '@/components/logo';
import { Version } from '@/components/version';
import { REPO } from '@/lib/source';
import { sidebarTree } from '@/lib/tree';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout tree={sidebarTree()} nav={{ title: <Logo />, url: '/' }} githubUrl={REPO} tabs={false}
      sidebar={{ banner: <Version /> }}>
      {children}
      <AskAI />
    </DocsLayout>
  );
}
