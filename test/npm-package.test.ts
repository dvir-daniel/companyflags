// The npm package (packages/companyflags) is built from the root's sources: it must say what the root does, and list
// every package the server imports, since the build leaves them outside the bundle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const read = (f: string) => JSON.parse(readFileSync(join(root, f), 'utf8'));
const rootPkg = read('package.json');
const pkg = read('packages/companyflags/package.json');

test('the npm package has the root’s name, version, dependencies, engines and license', () => {
  for (const key of ['name', 'version', 'dependencies', 'engines', 'license', 'description']) assert.deepEqual(pkg[key], rootPkg[key], key);
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.bin.companyflags, 'dist/cli.js');
  assert.deepEqual(Object.keys(pkg.exports), Object.keys(rootPkg.exports));
});

test('every package the server imports is a dependency', () => {
  const imported = new Set<string>();
  for (const f of readdirSync(join(root, 'server'), { recursive: true, encoding: 'utf8' })) {
    if (!f.endsWith('.ts')) continue;
    const code = readFileSync(join(root, 'server', f), 'utf8');
    for (const m of [...code.matchAll(/^(?:import|export)\b[^;]*?\bfrom '([^.'][^']*)'/gm), ...code.matchAll(/\bimport\('([^.'][^']*)'\)/g)]) {
      const spec = m[1];
      if (spec.startsWith('node:') || spec.startsWith('companyflags/')) continue;
      imported.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
    }
  }
  assert.deepEqual([...imported].filter((d) => !(d in pkg.dependencies)), []);
});
