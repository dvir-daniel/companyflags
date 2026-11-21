// Renamed settings (server/renamed.ts): an old name set without its new one stops the server before it starts, and
// the sign-in library's own names are taken out of the environment, so it reads only what the server hands it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authSettingsFromEnv, SetupError } from '../server/accounts.ts';
import { resolveConfig } from '../server/configFile.ts';
import { hideLibrarySettings, RENAMED, renamedProblem } from '../server/renamed.ts';
import { browser, startApp } from './helpers.ts';

const SECRET = 'Zq8vR2mXc5LpT9wKa3NdF7hJs1BgY4uE';

test('each old name, set without its new one, says what to rename', () => {
  assert.deepEqual(RENAMED, { BETTER_AUTH_SECRET: 'FF_SECRET', BETTER_AUTH_URL: 'FF_PUBLIC_URL', BETTER_AUTH_TRUSTED_ORIGINS: 'FF_TRUSTED_ORIGINS' });
  for (const [old, now] of Object.entries(RENAMED)) {
    const said = `${old} is now ${now}: rename it in your environment`;
    assert.equal(renamedProblem({ [old]: 'x' }), said);
    assert.throws(() => authSettingsFromEnv({ [old]: 'x' }), (e: Error) => e instanceof SetupError && e.message === said);
    assert.throws(() => resolveConfig({}, { [old]: 'x' }), { message: said }, 'with or without a config file');
    assert.equal(renamedProblem({ [old]: 'x', [now]: 'y' }), null, 'both set: the new one is used');
  }
  assert.equal(renamedProblem({}), null);
  assert.equal(renamedProblem({ BETTER_AUTH_SECRET: '' }), null, 'set but empty is not set');
});

test('the server refuses to start with an old name, and names the new one', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-renamed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, BETTER_AUTH_SECRET: SECRET, FF_DATA_DIR: join(dir, 'data'), PORT: '0', NODE_ENV: 'production' };
  for (const name of ['FF_SECRET', 'FF_PUBLIC_URL', 'FF_TRUSTED_ORIGINS', 'DATABASE_URL']) delete env[name];
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../server/index.ts', import.meta.url))], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /BETTER_AUTH_SECRET is now FF_SECRET: rename it in your environment/);
  assert.doesNotMatch(r.stdout, /listening|on http/);
});

test('the sign-in library’s own names are taken out of the environment', () => {
  const env: NodeJS.ProcessEnv = {
    BETTER_AUTH_SECRET: 'a', BETTER_AUTH_SECRETS: '1:b', BETTER_AUTH_URL: 'c', NEXT_PUBLIC_BETTER_AUTH_URL: 'd', AUTH_SECRET: 'e',
    BETTER_AUTH_TRUSTED_ORIGINS: 'f', BETTER_AUTH_TELEMETRY: '1', FF_SECRET: SECRET, PATH: '/bin', DATABASE_URL: 'postgres://x',
  };
  hideLibrarySettings(env);
  assert.deepEqual(env, { FF_SECRET: SECRET, PATH: '/bin', DATABASE_URL: 'postgres://x' });
});

test('an origin the library would read from the environment isn’t trusted: only FF_TRUSTED_ORIGINS is', async (t) => {
  process.env.BETTER_AUTH_TRUSTED_ORIGINS = 'https://evil.example';
  process.env.BETTER_AUTH_SECRETS = '1:another-secret-the-library-would-use-instead-0123456789';
  const ctx = await startApp({ signIn: { kind: 'accounts', settings: { secret: SECRET, trustedOrigins: ['https://idp.example'] } } });
  t.after(() => ctx.stop());
  assert.equal(process.env.BETTER_AUTH_TRUSTED_ORIGINS, undefined);
  assert.equal(process.env.BETTER_AUTH_SECRETS, undefined);
  const signUp = (origin: string) => browser(ctx, origin)('POST', '/api/auth/sign-up/email', {
    body: { email: 'lee@corp.com', name: 'Lee', password: 'correct horse battery' }, headers: { 'x-setup': ctx.setupToken! },
  });
  assert.equal((await signUp('https://evil.example')).status, 403, 'refused from an origin only the old variable named');
  const made = await signUp('http://localhost');
  assert.equal(made.status, 200, JSON.stringify(made.json));
  assert.match(made.cookie, /companyflags\.session_token=/, 'the session cookie is named after the server');
});
