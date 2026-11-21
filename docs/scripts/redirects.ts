// After `next build`: a small page at each address a page used to have, sending the reader to where it is now, so old
// links and bookmarks keep working. GitHub Pages has no redirects of its own, so each is a static page: a refresh tag,
// a canonical link and a script that keeps the #part of the address.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const out = join(import.meta.dirname, '..', 'out');
const base = (process.env.DOCS_BASE ?? '/').replace(/\/$/, '');

/** Old address → the page that has its content now. Add a line when a page moves or goes. */
export const REDIRECTS: Record<string, string> = {
  '/guide/apps': '/guide/services',                 // apps became flag sets (0.3), then services
  '/guide/flag-sets': '/guide/services',
  '/guide/backends': '/reading/remote-backends',    // 0.8: "Reading flags" by who decides
  '/sdk/openfeature': '/reading/overview',
  '/sdk/app-file': '/reading/local-apps',
  '/sdk/cdn-file': '/reading/local-apps',
  // after 0.9: Installation, Deploy (a whole recipe per page), Operate, Integrations (no more Plugins group), Reference
  '/self-hosting/overview': '/guide/installation',
  '/self-hosting/docker': '/deploy/docker-compose',
  '/self-hosting/aws': '/deploy/aws',
  '/self-hosting/google-cloud': '/deploy/google-cloud',
  '/self-hosting/azure': '/deploy/azure',
  '/self-hosting/database': '/reference/configuration',     // its parts kept their anchors there, and in the recipes
  '/self-hosting/proxies': '/reference/configuration',
  '/self-hosting/secrets': '/reference/configuration',
  '/self-hosting/configuration': '/reference/configuration',
  '/self-hosting/cdn': '/integrations/cdn-files',           // the purge is /integrations/cdn-purge
  '/self-hosting/production': '/operate/production',
  '/self-hosting/monitoring': '/operate/monitoring',
  '/self-hosting/backups': '/operate/backups',
  '/self-hosting/upgrading': '/operate/upgrading',
  '/self-hosting/sign-in': '/operate/sign-in',
  '/self-hosting/single-sign-on': '/operate/single-sign-on',
  '/self-hosting/appearance': '/operate/appearance',
  '/reference/plugins': '/reference/writing-a-plugin',      // the built-in ones are each an /integrations/ page
  '/guide/webhooks': '/integrations/webhooks',
  '/guide/security': '/reference/security',
};

const page = (to: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>This page moved</title>
<meta name="robots" content="noindex">
<link rel="canonical" href="${to}">
<meta http-equiv="refresh" content="0; url=${to}">
<script>location.replace(${JSON.stringify(to)} + location.hash)</script>
</head>
<body><p>This page moved to <a href="${to}">${to}</a>.</p></body>
</html>
`;

for (const [from, to] of Object.entries(REDIRECTS)) {
  if (!existsSync(join(out, `${to}.html`))) throw new Error(`redirect ${from}: ${to} isn't a page of the site`);
  const file = join(out, `${from}.html`);
  if (existsSync(file)) throw new Error(`redirect ${from}: a page has that address again; remove the redirect`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, page(`${base}${to}`));
}
console.log(`redirects: ${Object.keys(REDIRECTS).length} old addresses`);
