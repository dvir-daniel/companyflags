// Flags as code through the console's API (/api/flags-as-code, server/api.ts) and the CLI over HTTP (--url and
// --token, server/cli.ts), and code references (flags unused, server/codeReferences.ts). The API pulls, plans and
// pushes as the token's person: an agent is recorded as an agent, production is a request, a viewer can't push.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { boot } from './helpers.ts';
import { main } from '../server/cli.ts';
import { FLAGS_SCHEMA_URL } from '../server/flagsAsCode.ts';

let t: Awaited<ReturnType<typeof boot>>;
let server: ServerType;
let url = '';
before(async () => {
  t = await boot();
  await t.db.query(`insert into app_user (key, name, role) values ('vera', 'Vera (viewer)', 'viewer')`);
  server = await new Promise<ServerType>((done) => { const s = serve({ fetch: t.app.fetch, port: 0, hostname: '127.0.0.1' }, () => done(s)); });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  await t.stop();
});

const token = async (user: string, body: Record<string, unknown>) => {
  const r = await t.as(user).post('/tokens', body);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.token as string;
};
const withToken = async (raw: string, method: string, path: string, body?: unknown) => {
  const res = await t.app.request(`/api${path}`, { method, headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json() as any };
};
async function run(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  let text = '';
  const print = (line: string) => { text += `${line}\n`; };
  return { code: await main(args, { cwd, env, out: print, err: print }), text };
}
const folders: string[] = [];
after(() => { for (const d of folders) rmSync(d, { recursive: true, force: true }); });
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-cli-http-'));
  folders.push(dir);
  return dir;
};

test('the API: pull, plan and push as an agent; production is a request; History says agent', async () => {
  const agent = await token('alice', { name: 'Claude in CI', agent: true });
  const pulled = await withToken(agent, 'GET', '/flags-as-code');
  assert.equal(pulled.status, 200);
  const file = pulled.json;
  assert.equal(file.flags.new_checkout.type, 'bool');

  const same = await withToken(agent, 'POST', '/flags-as-code/plan', file);
  assert.deepEqual([same.status, same.json.steps, same.json.problems], [200, [], []]);

  file.flags.agent_flag = { kind: 'ops', type: 'bool', services: { dev: ['web'] } };
  file.flags.new_checkout.services.prod = ['web'];
  const pushed = await withToken(agent, 'POST', '/flags-as-code/push', file);
  assert.equal(pushed.status, 200, JSON.stringify(pushed.json));
  const results = Object.fromEntries(pushed.json.done.map((d: { step: { do: string }; result: string }) => [d.step.do, d.result]));
  assert.deepEqual(results, { create: 'done', services: 'request' });
  const request = pushed.json.done.find((d: { result: string }) => d.result === 'request').request;
  const cs = await t.as('bob').get(`/change-sets/${request}`);
  assert.equal(cs.status, 200, 'a request a person can review');

  const h = (await t.as('alice').get('/history?flag=agent_flag')).json;
  const row = (Array.isArray(h) ? h : h.rows).find((r: { changeType: string }) => r.changeType === 'flag.create');
  assert.deepEqual([row.changedBy, row.actorType], ['alice', 'agent']);

  // a file with problems: 422 with the plan, nothing pushed
  const bad = await withToken(agent, 'POST', '/flags-as-code/push', { flags: { Bad: { kind: 'nope', type: 'bool' } } });
  assert.equal(bad.status, 422);
  assert.ok(bad.json.plan.problems.length);
});

test('the API: a viewer plans and pulls, but can’t push', async () => {
  const viewer = await token('vera', { name: 'read only' });
  const file = (await withToken(viewer, 'GET', '/flags-as-code')).json;
  assert.equal((await withToken(viewer, 'POST', '/flags-as-code/plan', file)).status, 200);
  assert.equal((await withToken(viewer, 'POST', '/flags-as-code/push', file)).status, 403);
  assert.equal((await t.as('vera').post('/flags-as-code/plan', file)).status, 200, 'signed in to the console too');
  assert.equal((await t.as('vera').post('/flags-as-code/push', file)).status, 403);
});

test('the CLI over HTTP: pull, plan and push with --url and --token, or the environment', async () => {
  const dir = folder();
  const agent = await token('alice', { name: 'agent for the CLI', agent: true });
  const pulled = await run(['flags', 'pull', '--url', url, '--token', agent], dir);
  assert.equal(pulled.code, 0, pulled.text);
  assert.match(pulled.text, /^wrote \d+ flags to /);
  const file = JSON.parse(readFileSync(join(dir, 'flags.json'), 'utf8'));
  const env = { COMPANYFLAGS_URL: url, COMPANYFLAGS_TOKEN: agent };
  assert.match((await run(['flags', 'plan'], dir, env)).text, /^= \d+ unchanged\n(… request #\d+ on .+\n)*nothing to change\n$/, 'open requests are listed');

  file.flags.cli_http_flag = { kind: 'ops', type: 'bool', services: { dev: ['web'], prod: ['web'] } };
  file.flags.payments_enabled.description = 'Pushed over HTTP';
  file.flags.payments_enabled.services.prod = ['web'];
  writeFileSync(join(dir, 'flags.json'), JSON.stringify(file));
  const plan = await run(['flags', 'plan'], dir, env);
  assert.equal(plan.code, 0, plan.text);
  assert.match(plan.text, /^\+ create cli_http_flag \(ops, bool\)$/m);
  assert.match(plan.text, /^~ services of payments_enabled in prod: .* → web \(a request: it needs approval there\)$/m);
  const pushed = await run(['flags', 'push'], dir, env);
  assert.equal(pushed.code, 0, pushed.text);
  assert.match(pushed.text, /^✓ create cli_http_flag/m);
  assert.match(pushed.text, /^✓ change payments_enabled: description$/m);
  assert.match(pushed.text, /^→ request #\d+: services of payments_enabled in prod/m);
  assert.equal((await run(['flags', 'push', '--as', 'someone'], dir, env)).code, 1, '--as is for the database');

  // a file with problems: printed, exit 1
  file.flags.broken = { kind: 'feature', type: 'bool' };
  writeFileSync(join(dir, 'flags.json'), JSON.stringify(file));
  const bad = await run(['flags', 'push'], dir, env);
  assert.equal(bad.code, 1);
  assert.match(bad.text, /^! broken: kind is one of/m);
});

test('the CLI over HTTP: the server’s refusals are one line and exit 1', async () => {
  const dir = folder();
  writeFileSync(join(dir, 'flags.json'), JSON.stringify({ flags: {} }));
  const unknown = await run(['flags', 'plan', '--url', url, '--token', 'cfp_madeup'], dir);
  assert.deepEqual(unknown, { code: 1, text: `companyflags: ${url} answered 401: unknown, expired or revoked access token\n` });
  const viewer = await token('vera', { name: 'viewer for the CLI' });
  const refused = await run(['flags', 'push', '--url', url, '--token', viewer], dir);
  assert.equal(refused.code, 1);
  assert.match(refused.text, new RegExp(`^companyflags: ${url} answered 403: .+\\n$`));
  assert.match((await run(['flags', 'plan', '--url', url], dir)).text, /--url needs an access token/);
  assert.match((await run(['flags', 'plan', '--token', viewer], dir)).text, /--token goes with --url/);
  const away = await run(['flags', 'pull', '--url', 'http://127.0.0.1:1', '--token', viewer], dir);
  assert.equal(away.code, 1);
  assert.match(away.text, /^companyflags: can’t reach http:\/\/127\.0\.0\.1:1: /);
});

test('flags unused: flags no code mentions, and keys the code reads that aren’t flags', async () => {
  const dir = folder();
  writeFileSync(join(dir, 'flags.json'), JSON.stringify({ flags: { new_checkout: {}, dark_mode: {}, old_banner: {}, theme: {} } }));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'app.ts'), [
    `const on = await client.getBooleanValue('new_checkout', false);`,
    `const t = client.getObjectValueDetails( "theme", {});`,
    ``,
    `const x = await client.getStringValue('missing_flag', '');`,
  ].join('\n'));
  writeFileSync(join(dir, 'src', 'other.ts'), `// old_banner_v2 and xold_banner: not the whole word\n`);
  // where the search doesn't look: dependencies, builds, binaries and big files
  for (const d of ['node_modules', 'dist', 'build', '.git']) { mkdirSync(join(dir, d)); writeFileSync(join(dir, d, 'x.js'), 'dark_mode getBooleanValue("ghost", 1)'); }
  writeFileSync(join(dir, 'src', 'image.bin'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('dark_mode')]));
  writeFileSync(join(dir, 'src', 'big.txt'), `dark_mode ${'x'.repeat(1024 * 1024)}`);

  const r = await run(['flags', 'unused'], dir);
  assert.deepEqual(r, { code: 0, text: '? unused: dark_mode, old_banner\n! unknown: missing_flag (src/app.ts:4)\n' });
  assert.equal((await run(['flags', 'unused', '--strict', '--src', 'src'], dir)).code, 1);

  writeFileSync(join(dir, 'src', 'more.ts'), 'dark_mode; old_banner;');
  writeFileSync(join(dir, 'src', 'app.ts'), `client.getBooleanValue('new_checkout'); theme`);
  assert.deepEqual(await run(['flags', 'unused', '--strict'], dir), { code: 0, text: 'nothing to report: the code mentions all 4 flags and reads no others\n' });
  assert.match((await run(['flags', 'unused', 'nope.json'], dir)).text, /no .*nope\.json/);
});

test('flags unused with --url: the server’s flags', async () => {
  const dir = folder();
  writeFileSync(join(dir, 'app.ts'), `client.getBooleanValue('new_checkout', false); client.getNumberValue('not_a_flag', 1)`);
  const viewer = await token('vera', { name: 'viewer for unused' });
  const r = await run(['flags', 'unused', '--url', url, '--token', viewer], dir);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /^\? unused: .+/m);
  assert.doesNotMatch(r.text.split('\n')[0], /\bnew_checkout\b/);
  assert.match(r.text, /^! unknown: not_a_flag \(app\.ts:1\)$/m);
});

test('the CLI over HTTP: --json and --exit-code; a push’s reason, and the pull request’s link from CI', async () => {
  const dir = folder();
  const agent = await token('alice', { name: 'agent for --json', agent: true });
  const env = { COMPANYFLAGS_URL: url, COMPANYFLAGS_TOKEN: agent,
    GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'acme/web', GITHUB_REF: 'refs/pull/7/merge', GITHUB_SHA: 'f00d' };
  const file = { owns: ['services'], flags: { cli_json_flag: { kind: 'ops', type: 'bool', services: { dev: ['web'], prod: [] as string[] } } } };
  writeFileSync(join(dir, 'flags.json'), JSON.stringify(file));
  const planned = await run(['flags', 'plan', '--json', '--exit-code'], dir, env);
  assert.equal(planned.code, 2, 'changes');
  assert.deepEqual(JSON.parse(planned.text).steps.map((s: { do: string }) => s.do), ['create']);
  const created = await run(['flags', 'push', '--json', '--exit-code'], dir, env);
  assert.equal(created.code, 0, 'done, nothing waits');
  assert.deepEqual(JSON.parse(created.text).done.map((d: { result: string }) => d.result), ['done']);
  assert.equal((await run(['flags', 'plan', '--exit-code'], dir, env)).code, 0, 'no changes');

  file.flags.cli_json_flag.services.prod = ['web'];
  writeFileSync(join(dir, 'flags.json'), JSON.stringify(file));
  const pushed = await run(['flags', 'push', '--reason', 'Web gets it in production', '--exit-code'], dir, env);
  assert.equal(pushed.code, 2, `a change waits for approval: ${pushed.text}`);
  const request = Number(/^→ request #(\d+): services of cli_json_flag in prod/m.exec(pushed.text)![1]);
  const cs = await t.db.query<{ reason: string }>(`select reason from change_set where id = $1`, [request]);
  assert.equal(cs.rows[0].reason, 'Web gets it in production: services of cli_json_flag in prod: none → web (https://github.com/acme/web/pull/7)');
  const again = await run(['flags', 'push', '--exit-code'], dir, env);
  assert.match(again.text, new RegExp(`^→ request #${request} \\(already open\\)`, 'm'));
  assert.equal((await run(['flags', 'push', '--link', 'not a link'], dir, env)).code, 1);
});

test('the CLI over HTTP: pull keeps the file’s source, owns and scope; unused takes the server’s flags in that scope', async () => {
  const dir = folder();
  const viewer = await token('vera', { name: 'viewer for pull' });
  const env = { COMPANYFLAGS_URL: url, COMPANYFLAGS_TOKEN: viewer };
  writeFileSync(join(dir, 'flags.json'), JSON.stringify({ source: 'acme/web', owns: ['description'], scope: { prefix: 'payments_' }, flags: {} }));
  assert.equal((await run(['flags', 'pull'], dir, env)).code, 0);
  const pulled = JSON.parse(readFileSync(join(dir, 'flags.json'), 'utf8'));
  assert.deepEqual([pulled.$schema, pulled.source, pulled.owns, pulled.scope], [FLAGS_SCHEMA_URL, 'acme/web', ['description'], { prefix: 'payments_' }]);
  assert.deepEqual(Object.keys(pulled.flags), ['payments_enabled']);
  assert.deepEqual(Object.keys(pulled.flags.payments_enabled).sort(), ['description', 'kind', 'type']);
  writeFileSync(join(dir, 'app.ts'), 'nothing here');
  assert.match((await run(['flags', 'unused', '--url', url, '--token', viewer], dir)).text, /^\? unused: payments_enabled\n$/);
  // an empty secret is a mistake, never the database instead
  for (const empty of [{ COMPANYFLAGS_URL: '' }, { COMPANYFLAGS_URL: url, COMPANYFLAGS_TOKEN: '' }]) {
    const r = await run(['flags', 'plan'], dir, empty);
    assert.equal(r.code, 1);
    assert.match(r.text, /is empty: is the secret set for this job\?/);
  }
});
