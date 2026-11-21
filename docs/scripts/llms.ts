// After `next build`: the docs for AI agents, beside the site in out/ (as vitepress-plugin-llms made them before).
//   /llms.txt        an index of every page, with a link to its Markdown
//   /llms-full.txt   every page in one file
//   /<page>.md       each page as Markdown: /guide/quickstart.md
// DOCS_SITE (the site's origin, from GitHub Pages) and DOCS_BASE make the links full addresses: in llms.txt, and the
// pages' own links (/guide/services) in every Markdown file, which would otherwise miss the base path (/companyflags).
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const root = join(import.meta.dirname, '..');
const content = join(root, 'content/docs');
const out = join(root, 'out');
const base = (process.env.DOCS_BASE ?? '/').replace(/\/$/, '');
const site = `${process.env.DOCS_SITE ?? ''}${base}`;

// A page's own links start at the site's root ("](/guide/services#keys)", "href=\"/llms.txt\""): give them the site's
// address. Code blocks are left as they are.
const linkHere = (md: string) => md.split(/(^```[\s\S]*?^```$)/m).map((part, i) => (i % 2 ? part : part
  .replace(/\]\(\/(?!\/)/g, `](${site}/`)
  .replace(/(href|src)="\/(?!\/)/g, `$1="${site}/`))).join('');

const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? files(p) : /\.mdx?$/.test(n) ? [p] : [];
});

type Page = { url: string; title: string; description: string; markdown: string };
const pages: Page[] = files(content).sort().map((file) => {
  const raw = readFileSync(file, 'utf8');
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  const field = (k: string) => {
    const m = fm && new RegExp(`^${k}: (.*)$`, 'm').exec(fm[1]);
    return m ? (JSON.parse(m[1].startsWith('"') ? m[1] : JSON.stringify(m[1])) as string) : '';
  };
  const title = field('title');
  const description = field('description');
  let body = fm ? raw.slice(fm[0].length) : raw;
  body = body
    .replace(/^<Illus[A-Za-z]+ \/>\n?/gm, '')                                  // drawings: the words around them say it
    .replace(/^<SetupBuilder \/>\n?/gm, '')                                     // the setup builder: its recipes are linked below it
    .replace(/^:::(warning|tip|info|danger)(?:\[(.*)\])?\n([\s\S]*?)^:::\n?/gm, (_m, kind: string, label: string | undefined, text: string) =>
      `> **${label || kind[0].toUpperCase() + kind.slice(1)}**\n>\n${text.trimEnd().split('\n').map((l) => `> ${l}`.trimEnd()).join('\n')}\n`)
    .replace(/^(```[a-z]*) tab="([^"]+)"$/gm, '$1 title="$2"');
  const markdown = `# ${title}\n\n${description ? `> ${description}\n\n` : ''}${linkHere(body.trim())}\n`;
  return { url: `/${relative(content, file).replace(/\.mdx?$/, '')}`, title, description, markdown };
});

// in the sidebar's order (lib/tree.tsx), then any page it doesn't list
const order = [...readFileSync(join(root, 'lib/tree.tsx'), 'utf8').matchAll(/\['[^']*', '(\/[^']+)'\]/g)].map((m) => m[1]);
const rank = (url: string) => (order.includes(url) ? order.indexOf(url) : order.length);
pages.sort((a, b) => rank(a.url) - rank(b.url) || a.url.localeCompare(b.url));

for (const p of pages) {
  const file = join(out, `${p.url}.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, p.markdown);
}
const index = [
  '# CompanyFlags',
  '',
  '> Feature flags and remote config you run yourself: rules, releases, reviewed changes and history, per any dimension you define, read with OpenFeature.',
  '',
  '## Docs',
  '',
  ...pages.map((p) => `- [${p.title}](${site}${p.url}.md)${p.description ? `: ${p.description}` : ''}`),
  '',
].join('\n');
writeFileSync(join(out, 'llms.txt'), index);
writeFileSync(join(out, 'llms-full.txt'), pages.map((p) => p.markdown).join('\n---\n\n'));
console.log(`llms: ${pages.length} pages, llms.txt and llms-full.txt in ${relative(root, out)}/`);
