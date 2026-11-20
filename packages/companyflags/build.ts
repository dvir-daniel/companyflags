// Builds the companyflags package for npm from the repository's sources: `pnpm pack:npm` (after vite build).
// Node won't strip types under node_modules, so the package ships JavaScript, made here with esbuild:
//
//   dist/cli.js            the companyflags command (bin)
//   dist/config.js         companyflags/config
//   dist/plugins.js        companyflags/plugins
//   dist/server.js         the server (node dist/server.js, as node server/index.ts)
//   dist/jsonataWorker.js  the JSONata worker (transform.ts starts it beside itself)
//   dist/chunk-*.js        what they share, loaded once, so a config's plugins and the server's are the same modules
//   dist/migrations/       the schema (migrate.ts reads it beside itself)
//   dist/types/            the declarations for companyflags/config and /plugins
//   web/dist/              the console (packageFolder.ts)
//
// The dependencies stay outside (package.json lists them, as the root's does): pglite finds its wasm in its own folder.

import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';

const here = import.meta.dirname;
const root = join(here, '..', '..');
const dist = join(here, 'dist');
const fail = (m: string) => { console.error(`build: ${m}`); process.exit(1); };

// the package says what the root does: its version and its dependencies. hono is a peer dependency there (PEERS), so
// a plugin's own `import { Hono } from 'hono'` gets the server's copy, and its types match.
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
for (const key of ['version', 'engines', 'license'] as const) {
  if (JSON.stringify(pkg[key]) !== JSON.stringify(rootPkg[key])) fail(`packages/companyflags/package.json "${key}" differs from the root's: copy it over`);
}
const PEERS = ['hono'];
const sorted = (o: Record<string, string>) => JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b))));
if (sorted({ ...pkg.dependencies, ...pkg.peerDependencies }) !== sorted(rootPkg.dependencies)
  || JSON.stringify(Object.keys(pkg.peerDependencies ?? {}).sort()) !== JSON.stringify(PEERS)) {
  fail(`packages/companyflags/package.json: "dependencies" and "peerDependencies" (${PEERS.join(', ')}) together must be the root's "dependencies": copy them over`);
}
if (!existsSync(join(root, 'web', 'dist', 'index.html'))) fail('no web/dist: run vite build first (pnpm pack:npm does)');

rmSync(dist, { recursive: true, force: true });
rmSync(join(here, 'web'), { recursive: true, force: true });

await build({
  entryPoints: {
    cli: join(root, 'server', 'cli.ts'),
    config: join(root, 'server', 'config.ts'),
    plugins: join(root, 'server', 'plugins', 'index.ts'),
    server: join(root, 'server', 'index.ts'),
    jsonataWorker: join(root, 'server', 'jsonataWorker.ts'),
  },
  outdir: dist,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
  chunkNames: 'chunk-[hash]',
  legalComments: 'none',
  logLevel: 'warning',
});

// the bin: a #! line (esbuild keeps the source's, but say it once for sure) and executable
const cli = join(dist, 'cli.js');
const code = readFileSync(cli, 'utf8');
if (!code.startsWith('#!')) writeFileSync(cli, `#!/usr/bin/env node\n${code}`);
chmodSync(cli, 0o755);

cpSync(join(root, 'server', 'migrations'), join(dist, 'migrations'), { recursive: true });
cpSync(join(root, 'web', 'dist'), join(here, 'web', 'dist'), { recursive: true });
for (const f of ['README.md', 'LICENSE.md']) cpSync(join(root, f), join(here, f));

execFileSync(join(root, 'node_modules', '.bin', 'tsc'), ['-p', join(here, 'tsconfig.types.json')], { stdio: 'inherit' });
for (const f of ['config.d.ts', join('plugins', 'index.d.ts')]) {
  if (!existsSync(join(dist, 'types', f))) fail(`no dist/types/${f}`);
}
// the declarations keep the sources' './x.ts': a project reading them wants './x.js' (which finds x.d.ts)
for (const f of readdirSync(join(dist, 'types'), { recursive: true, encoding: 'utf8' })) {
  if (!f.endsWith('.d.ts')) continue;
  const file = join(dist, 'types', f);
  writeFileSync(file, readFileSync(file, 'utf8').replace(/((?:from |import\()\s*['"]\.{1,2}\/[^'"]+)\.ts(['"])/g, '$1.js$2'));
}
console.log(`built ${dist} (npm pack in ${here} makes the tarball)`);
