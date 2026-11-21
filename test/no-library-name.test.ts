// The sign-in library is ours to know about, not the reader's: nothing people read or set names it. Its package
// imports stay (server/accounts.ts, web/src/authClient.ts), and so do the old setting names in two places only:
// the guard that refuses them (server/renamed.ts) and the upgrade note in CHANGELOG.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const NAME = /better auth|better-auth\.com|better_auth_/i;
const TEXT = /\.(md|mdx|ts|tsx|js|mjs|css|json|ya?ml|sh|html|txt|example)$|^Dockerfile$/;
const SKIP = new Set(['node_modules', 'dist', 'out', 'build', 'coverage']);
/** An import of the library's packages: `from 'better-auth…'` or `from '@better-auth/…'`. */
const IMPORT = /\bfrom ['"]@?better-auth[/'"]/;

const files = (path: string): string[] => {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((f) => (SKIP.has(f) || f.startsWith('.') ? [] : files(join(path, f))));
};

const READ = [
  'README.md', 'CONTRIBUTING.md', 'AGENTS.md', 'SECURITY.md', 'GLOSSARY.md', '.env.example', 'Dockerfile', 'docker-compose.yml',
  '.github', 'docs/content', 'docs/components', 'docs/app', 'docs/lib', 'packages/ui', 'web/src', 'server', 'examples',
];
const EXCEPT = new Set(['server/renamed.ts']);

test('nothing people read or set names the sign-in library', () => {
  const hits: string[] = [];
  for (const file of READ.flatMap(files)) {
    if (EXCEPT.has(file) || file.startsWith('server/migrations/')) continue;
    if (NAME.test(file)) hits.push(`${file}: the file's name`);
    if (!TEXT.test(file.split('/').pop()!)) continue;
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (NAME.test(line) && !IMPORT.test(line)) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(hits, [], `the sign-in library named where people read it:\n${hits.join('\n')}`);
});

test('the changelog names the old settings only in the upgrade note', () => {
  const lines = readFileSync('CHANGELOG.md', 'utf8').split('\n');
  const note = /^- `BETTER_AUTH_[A-Z_]+` is now `FF_[A-Z_]+`[;.]$/;
  const hits = lines.flatMap((line, i) => (NAME.test(line) && !note.test(line) ? [`CHANGELOG.md:${i + 1}: ${line.trim()}`] : []));
  assert.deepEqual(hits, [], hits.join('\n'));
  assert.equal(lines.filter((l) => note.test(l)).length, 3, 'the upgrade note lists the three renamed settings');
});
