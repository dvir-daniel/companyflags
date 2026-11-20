import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DocsBody, DocsDescription, DocsPage, DocsTitle, MarkdownCopyButton, ViewOptionsPopover } from 'fumadocs-ui/layouts/docs/page';
import { getMDXComponents } from '@/mdx-components';
import { BASE, REPO, source } from '@/lib/source';

type Props = { params: Promise<{ slug: string[] }> };

export default async function Page({ params }: Props) {
  const page = source.getPage((await params).slug);
  if (!page) notFound();
  const MDX = page.data.body;
  // each page's Markdown is written beside it at build time (scripts/llms.ts): /guide/quickstart.md
  const markdownUrl = `${BASE}${page.url}.md`;
  return (
    <DocsPage toc={page.data.toc} breadcrumb={{ enabled: false }}>
      <div className="cf-title-row">
        <DocsTitle>{page.data.title}</DocsTitle>
        <div className="cf-page-actions">
          <MarkdownCopyButton markdownUrl={markdownUrl} />
          <ViewOptionsPopover markdownUrl={markdownUrl} githubUrl={`${REPO}/blob/main/docs/content/docs/${page.path}`} />
        </div>
      </div>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = source.getPage((await params).slug);
  if (!page) notFound();
  return { title: page.data.title, description: page.data.description };
}
