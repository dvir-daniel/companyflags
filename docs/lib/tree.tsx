// The sidebar: each group with its icon. Getting started and Reading flags are open; the others open for the page
// you're on. Its order is the pages' previous/next order too, so the quickstart leads on to reading flags.
// Pages are found by address in the loaded source, so a page that's renamed or removed fails the build here, and so
// does a page with no description.
import type * as PageTree from 'fumadocs-core/page-tree';
import type { ReactNode } from 'react';
import { source } from './source';

const icon = (d: ReactNode) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);

const ICONS = {
  start: icon(<><circle cx="12" cy="12" r="9" /><path d="M10 8.5v7l5.5-3.5z" /></>),
  concepts: icon(<><path d="M3 5.5h6a3 3 0 0 1 3 3V20a2.5 2.5 0 0 0-2.5-2.5H3z" /><path d="M21 5.5h-6a3 3 0 0 0-3 3V20a2.5 2.5 0 0 1 2.5-2.5H21z" /></>),
  reading: icon(<path d="M8 3v5M16 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4" />),
  changing: icon(<><rect x="2.5" y="7" width="19" height="10" rx="5" /><circle cx="16.5" cy="12" r="2.5" /></>),
  plugins: icon(<path d="M9 3.5h6v3a1.5 1.5 0 1 0 3 0h2.5v6h-3a1.5 1.5 0 1 0 0 3h3v5h-17v-5h3a1.5 1.5 0 1 0 0-3h-3v-6h3a1.5 1.5 0 1 0 0-3z" />),
  migration: icon(<path d="M4 8h14M14 4l4 4-4 4M20 16H6M10 12l-4 4 4 4" />),
  hosting: icon(<><rect x="3" y="4" width="18" height="7" /><rect x="3" y="13" width="18" height="7" /><path d="M7 7.5h.01M7 16.5h.01" /></>),
  reference: icon(<path d="M4 4v16M8 4v16M12 4l4 16M17 4h3v16h-3z" />),
};

const GROUPS: { name: string; icon: keyof typeof ICONS; open?: boolean; pages: [string, string][] }[] = [
  { name: 'Getting started', icon: 'start', open: true, pages: [['Introduction', '/guide/introduction'], ['Quickstart', '/guide/quickstart']] },
  { name: 'Reading flags', icon: 'reading', open: true, pages: [['Overview', '/reading/overview'], ['Evaluation context', '/reading/context'], ['Remote evaluation in apps', '/reading/remote-apps'], ['Remote evaluation in backends', '/reading/remote-backends'], ['Local evaluation in apps', '/reading/local-apps'], ['Local evaluation in backends', '/reading/local-backends'], ['Testing', '/reading/testing'], ['Examples', '/guide/examples']] },
  { name: 'Concepts', icon: 'concepts', pages: [['How it fits together', '/guide/concepts'], ['Architecture', '/guide/architecture'], ['Dimensions', '/guide/dimensions'], ['Flags and rules', '/guide/flags-and-rules'], ['Services', '/guide/services']] },
  { name: 'Changing flags', icon: 'changing', pages: [['Releases', '/guide/releases'], ['Approvals and history', '/guide/approvals'], ['Flags as code', '/guide/flags-as-code'], ['Flags in the age of AI', '/guide/ai'], ['AI resources', '/guide/ai-resources']] },
  { name: 'Plugins', icon: 'plugins', pages: [['Plugins', '/reference/plugins'], ['Webhooks', '/guide/webhooks']] },
  { name: 'Self-hosting', icon: 'hosting', pages: [['Docker', '/self-hosting/docker'], ['Configuration', '/self-hosting/configuration'], ['Sign-in and single sign-on', '/self-hosting/sign-in'], ['CDN', '/self-hosting/cdn'], ['Appearance', '/self-hosting/appearance'], ['Production checklist', '/self-hosting/production'], ['AWS', '/self-hosting/aws'], ['Google Cloud', '/self-hosting/google-cloud'], ['Azure', '/self-hosting/azure'], ['Backups', '/self-hosting/backups'], ['Upgrading', '/self-hosting/upgrading']] },
  { name: 'Reference', icon: 'reference', pages: [['HTTP API', '/reference/http-api'], ['CLI', '/reference/cli'], ['Attributes', '/reference/attributes'], ['Security model', '/guide/security']] },
  { name: 'More', icon: 'migration', pages: [['Moving from another system', '/guide/migration'], ['Compared with others', '/guide/comparison'], ['Enterprise', '/guide/enterprise']] },
];

export function sidebarTree(): PageTree.Root {
  const pages = source.getPages();
  const bare = pages.filter((p) => !p.data.description).map((p) => p.url);
  if (bare.length) throw new Error(`every page needs a description in its front matter: ${bare.join(', ')}`);
  const known = new Set(pages.map((p) => p.url));
  return {
    name: 'Docs',
    children: GROUPS.map((g): PageTree.Folder => ({
      type: 'folder',
      name: g.name,
      icon: ICONS[g.icon],
      defaultOpen: g.open ?? false,
      children: g.pages.map(([name, url]): PageTree.Item => {
        if (!known.has(url)) throw new Error(`the sidebar links to ${url}, which isn't a page in content/docs`);
        return { type: 'page', name, url };
      }),
    })),
  };
}
