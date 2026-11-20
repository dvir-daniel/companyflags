// Serves the built site (out/) the way GitHub Pages does: /guide/quickstart answers with guide/quickstart.html.
// PORT (default 4173). For a look at the build: `pnpm --filter docs build && pnpm --filter docs start`.
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const out = join(import.meta.dirname, '..', 'out');
const base = (process.env.DOCS_BASE ?? '/').replace(/\/$/, '');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.ico': 'image/x-icon',
};
const file = (path: string) => {
  const p = normalize(join(out, path));
  if (!p.startsWith(out)) return null;
  for (const c of [p, `${p}.html`, join(p, 'index.html')]) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
};
createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  if (base && path.startsWith(base)) path = path.slice(base.length) || '/';
  const f = file(path);
  const found = f ?? file('/404');
  res.writeHead(f ? 200 : 404, { 'content-type': TYPES[extname(found ?? '.html')] ?? 'application/octet-stream' });
  res.end(found ? readFileSync(found) : 'not found');
}).listen(Number(process.env.PORT ?? 4173), () => console.log(`docs on http://localhost:${process.env.PORT ?? 4173}${base}/`));
