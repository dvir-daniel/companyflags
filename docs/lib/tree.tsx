// The sidebar: each group with its icon. Get Started and Reading Flags are open; the others open for the page
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
  integrations: icon(<path d="M9 3.5h6v3a1.5 1.5 0 1 0 3 0h2.5v6h-3a1.5 1.5 0 1 0 0 3h3v5h-17v-5h3a1.5 1.5 0 1 0 0-3h-3v-6h3a1.5 1.5 0 1 0 0-3z" />),
  migration: icon(<path d="M4 8h14M14 4l4 4-4 4M20 16H6M10 12l-4 4 4 4" />),
  deploy: icon(<><rect x="3" y="4" width="18" height="7" /><rect x="3" y="13" width="18" height="7" /><path d="M7 7.5h.01M7 16.5h.01" /></>),
  operate: icon(<path d="M3 12h4l3-7 4 14 3-7h4" />),
  reference: icon(<path d="M4 4v16M8 4v16M12 4l4 16M17 4h3v16h-3z" />),
};

// A caption between pages of one group (Clouds, The Console): small capitals, as the site's other labels.
const caption = (name: string) => (
  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.6px', textTransform: 'uppercase', color: 'var(--color-fd-muted-foreground)' }}>{name}</span>
);

type Entry = [label: string, url: string] | { caption: string };

const GROUPS: { name: string; icon: keyof typeof ICONS; open?: boolean; pages: Entry[] }[] = [
  { name: 'Get Started', icon: 'start', open: true, pages: [
    ['Introduction', '/guide/introduction'], ['Quickstart', '/guide/quickstart'], ['Installation', '/guide/installation'],
  ] },
  { name: 'Reading Flags', icon: 'reading', open: true, pages: [
    ['Overview', '/reading/overview'], ['Evaluation Context', '/reading/context'], ['Remote Evaluation in Apps', '/reading/remote-apps'],
    ['Remote Evaluation in Backends', '/reading/remote-backends'], ['Local Evaluation in Apps', '/reading/local-apps'],
    ['Local Evaluation in Backends', '/reading/local-backends'], ['Testing', '/reading/testing'], ['Examples', '/guide/examples'],
  ] },
  { name: 'Concepts', icon: 'concepts', pages: [
    ['How It Fits Together', '/guide/concepts'], ['Architecture', '/guide/architecture'], ['Dimensions', '/guide/dimensions'],
    ['Flags and Rules', '/guide/flags-and-rules'], ['Services', '/guide/services'],
  ] },
  { name: 'Changing Flags', icon: 'changing', pages: [
    ['Releases', '/guide/releases'], ['Approvals and History', '/guide/approvals'], ['Flags as Code', '/guide/flags-as-code'],
    ['Flags in the Age of AI', '/guide/ai'], ['AI Resources', '/guide/ai-resources'],
  ] },
  // Each Deploy page is a whole recipe, top to bottom; Choose Your Setup picks one.
  { name: 'Deploy', icon: 'deploy', pages: [
    ['Choose Your Setup', '/deploy/builder'], ['Docker Compose', '/deploy/docker-compose'], ['Kubernetes', '/deploy/kubernetes'],
    { caption: 'Clouds' },
    ['AWS', '/deploy/aws'], ['Google Cloud', '/deploy/google-cloud'], ['Azure', '/deploy/azure'],
  ] },
  { name: 'Operate', icon: 'operate', pages: [
    ['Production Checklist', '/operate/production'], ['Monitoring', '/operate/monitoring'], ['Backups', '/operate/backups'],
    ['Upgrading', '/operate/upgrading'],
    { caption: 'The Console' },
    ['Sign-In and People', '/operate/sign-in'], ['Single Sign-On', '/operate/single-sign-on'], ['Appearance', '/operate/appearance'],
  ] },
  // What users turn on and off. "Plugin" is only for people writing their own (Reference → Writing a Plugin).
  { name: 'Integrations', icon: 'integrations', pages: [
    ['Overview', '/integrations/overview'], ['OFREP', '/integrations/ofrep'], ['flagd', '/integrations/flagd'],
    ['CDN Files', '/integrations/cdn-files'], ['CDN Purge', '/integrations/cdn-purge'], ['Webhooks', '/integrations/webhooks'],
    ['Metrics', '/integrations/metrics'], ['AI Agents (MCP)', '/integrations/mcp'],
  ] },
  { name: 'Reference', icon: 'reference', pages: [
    ['Configuration', '/reference/configuration'], ['CLI', '/reference/cli'], ['HTTP API', '/reference/http-api'],
    ['Attributes', '/reference/attributes'], ['Security Model', '/reference/security'], ['Writing a Plugin', '/reference/writing-a-plugin'],
  ] },
  { name: 'More', icon: 'migration', pages: [
    ['Moving from Another System', '/guide/migration'], ['Compared with Others', '/guide/comparison'], ['Enterprise', '/guide/enterprise'],
  ] },
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
      children: g.pages.map((e): PageTree.Node => {
        if (!Array.isArray(e)) return { type: 'separator', name: caption(e.caption) };
        const [name, url] = e;
        if (!known.has(url)) throw new Error(`the sidebar links to ${url}, which isn't a page in content/docs`);
        return { type: 'page', name, url };
      }),
    })),
  };
}
