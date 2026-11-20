// The RESOURCES menu in the site's bars (better-auth.com has the same menu): pages and files about the project
// rather than a part of the docs. Each name is used for one destination only: "Releases" is a docs page about
// rolling out, so GitHub's are "GitHub releases".
import { BASE, REPO } from './source';

export type Resource = { text: string; description: string; url: string; external?: boolean };

export const RESOURCES: Resource[] = [
  { text: 'Changelog', description: 'What changed in each release', url: `${REPO}/blob/main/CHANGELOG.md`, external: true },
  { text: 'GitHub releases', description: 'Docker images and release notes', url: `${REPO}/releases`, external: true },
  { text: 'Examples', description: 'A React app, a Node server and flagd, ready to run', url: '/guide/examples' },
  { text: 'AI resources', description: 'The docs for agents, a skill and the MCP server', url: '/guide/ai-resources' },
  { text: 'llms.txt', description: 'Every page as Markdown, for AI tools', url: '/llms.txt', external: true },
  { text: 'Security model', description: 'How it keeps flags safe, and how to report a problem', url: '/guide/security' },
];

/** A resource's address as a link: the site's own files (llms.txt) need the base path, as they aren't pages. */
export const resourceHref = (r: Resource) => (r.url === '/llms.txt' ? `${BASE}/llms.txt` : r.url);
