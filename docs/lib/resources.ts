// The RESOURCES menu in the site's bars (better-auth.com has the same menu): pages and files about the project
// rather than a part of the docs.
import { REPO } from './source';

export const RESOURCES: { text: string; description: string; url: string; external?: boolean }[] = [
  { text: 'Changelog', description: 'What changed in each release', url: `${REPO}/blob/main/CHANGELOG.md`, external: true },
  { text: 'Examples', description: 'A React app, a Node server and flagd, ready to run', url: '/guide/examples' },
  { text: 'AI resources', description: 'The docs for agents, a skill and the MCP server', url: '/guide/ai-resources' },
  { text: 'llms.txt', description: 'Every page as Markdown, for AI tools', url: '/llms.txt', external: true },
  { text: 'Security', description: 'The security model, and how to report a problem', url: '/guide/security' },
  { text: 'Releases', description: 'Docker images and release notes on GitHub', url: `${REPO}/releases`, external: true },
];
