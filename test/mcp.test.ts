// The MCP plugin (server/plugins/mcp.ts): JSON-RPC at /mcp with an access token. Every tool goes through the
// console's API as the token's person, so roles, approvals and the agent in History hold; and the stdio bridge
// (companyflags mcp, server/cli.ts) forwards lines to it.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { boot } from './helpers.ts';
import { main } from '../server/cli.ts';

let t: Awaited<ReturnType<typeof boot>>;
let agent: string;
let viewer: string;
before(async () => {
  t = await boot();
  agent = (await t.as('alice').post('/tokens', { name: 'Claude', agent: true })).json.token;
  viewer = (await t.as('alice').post('/tokens', { name: 'read only', role: 'viewer' })).json.token;
});
after(async () => { await t.stop(); });

let next = 1;
const post = async (body: unknown, headers: Record<string, string> = {}) => {
  const res = await t.app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
};
const rpc = async (method: string, params?: unknown, token = agent) =>
  (await post({ jsonrpc: '2.0', id: next++, method, params }, { authorization: `Bearer ${token}` })).json;
/** A tool's answer: its JSON when it worked, its message when it didn't. */
const tool = async (name: string, args: Record<string, unknown>, token = agent) => {
  const r = await rpc('tools/call', { name, arguments: args }, token);
  assert.ok(r.result, JSON.stringify(r));
  const text = r.result.content[0].text;
  return { isError: r.result.isError as boolean, text, json: r.result.isError ? null : JSON.parse(text) };
};
const layers = async (flag: string, env: string) => (await t.as('alice').get(`/flags/${flag}`)).json.layers[env];
/** The newest History entry of a flag in one environment. */
const newest = async (flag: string, env: string) => {
  const h = (await t.as('alice').get(`/history?flag=${flag}&environment=${env}`)).json;
  return (Array.isArray(h) ? h : h.rows)[0];
};
const enabledIn = async (flag: string, env: string) => (await t.as('alice').get(`/flags/${flag}`)).json.layers[env].base.enabled as boolean;

test('initialize, then the tools', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-11-25');
  assert.deepEqual(Object.keys(init.result.capabilities).sort(), ['prompts', 'resources', 'tools']);
  assert.equal(init.result.serverInfo.name, 'companyflags');
  const note = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { authorization: `Bearer ${agent}` });
  assert.equal(note.status, 202);
  assert.deepEqual((await rpc('ping')).result, {});
  const names = (await rpc('tools/list')).result.tools.map((x: { name: string }) => x.name);
  for (const n of ['list_flags', 'get_flag', 'list_services', 'list_environments', 'list_dimensions', 'history', 'list_requests', 'stale_flags',
    'evaluate', 'explain', 'compare', 'request_status', 'create_flag', 'set_services', 'set_enabled', 'set_default', 'add_rule', 'remove_rule',
    'set_entity_value', 'rollout_step', 'archive_flag']) assert.ok(names.includes(n), n);
  assert.equal((await t.call('GET', '/mcp')).status, 405, 'no stream');
});

test('no token: 401 with WWW-Authenticate; a wrong Origin: 403', async () => {
  const none = await post({ jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal(none.status, 401);
  assert.match(none.headers.get('www-authenticate') ?? '', /^Bearer/);
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { authorization: 'Bearer cfp_madeup' })).status, 401);
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { authorization: `Bearer ${agent}`, origin: 'https://evil.example' })).status, 403);
});

test('an agent lists and gets flags, and explains them', async () => {
  const list = await tool('list_flags', { q: 'checkout' });
  assert.ok(list.json.flags.some((f: { key: string }) => f.key === 'new_checkout'));
  const flag = await tool('get_flag', { key: 'new_checkout' });
  assert.equal(flag.json.kind, 'release');
  assert.deepEqual(flag.json.environments.dev.services, ['android', 'ios', 'web']);
  assert.equal(flag.json.environments.dev.rules.length, 2);
  assert.ok((await tool('get_flag', { key: 'nope' })).isError);
  const envs = await tool('list_environments', {});
  assert.deepEqual(envs.json.map((e: { key: string; needsApproval: boolean }) => [e.key, e.needsApproval]), [['dev', false], ['prod', true]]);
  const why = await tool('explain', { flag: 'new_checkout', environment: 'dev', service: 'android', attrs: { 'app.version': '4.0.0' } });
  assert.equal(why.json.value, false);
  assert.ok(why.json.steps.length > 0);
  const all = await tool('evaluate', { environment: 'dev', service: 'web' });
  assert.ok(all.json.flags.some((f: { key: string }) => f.key === 'new_checkout'));
  assert.ok(!all.json.flags.some((f: { key: string }) => f.key === 'android_quick_share'), 'only what web is sent');
});

test('set_enabled: a plan without apply, a change in dev as an agent, a request in prod', async () => {
  const was = await enabledIn('android_quick_share', 'dev');
  const plan = await tool('set_enabled', { flag: 'android_quick_share', environment: 'dev', on: !was });
  assert.equal(plan.json.applied, false);
  assert.deepEqual(plan.json.plan.on, { from: was, to: !was });
  assert.equal(await enabledIn('android_quick_share', 'dev'), was, 'nothing changed');

  const done = await tool('set_enabled', { flag: 'android_quick_share', environment: 'dev', on: !was, apply: true });
  assert.equal(done.json.applied, true, done.text);
  assert.equal(await enabledIn('android_quick_share', 'dev'), !was);
  const h = (await t.as('alice').get('/history?flag=android_quick_share&environment=dev')).json;
  const row = (Array.isArray(h) ? h : h.rows)[0];
  assert.deepEqual([row.changedBy, row.actorType], ['alice', 'agent']);

  const prodWas = await enabledIn('android_quick_share', 'prod');
  const asked = await tool('set_enabled', { flag: 'android_quick_share', environment: 'prod', on: !prodWas, apply: true });
  assert.equal(asked.json.applied, false);
  assert.equal(typeof asked.json.request, 'number');
  assert.match(asked.json.message, /approv/);
  assert.equal(await enabledIn('android_quick_share', 'prod'), prodWas, 'nothing applied in prod');
  const waiting = await tool('list_requests', { status: 'in_review' });
  assert.ok(waiting.json.some((r: { id: number }) => r.id === asked.json.request));
});

test('a viewer’s token reads but can’t change', async () => {
  assert.ok((await tool('get_flag', { key: 'new_checkout' }, viewer)).json);
  const was = await enabledIn('api_base_url', 'dev');
  const r = await tool('set_enabled', { flag: 'api_base_url', environment: 'dev', on: !was, apply: true }, viewer);
  assert.equal(r.isError, true);
  assert.equal(await enabledIn('api_base_url', 'dev'), was);
});

test('create_flag and set_default go through the API', async () => {
  const plan = await tool('create_flag', { key: 'mcp_made', removeBy: '2027-06-30', services: ['web'] });
  assert.equal(plan.json.applied, false);
  assert.equal((await t.as('alice').get('/flags/mcp_made')).status, 404);
  assert.equal((await tool('create_flag', { key: 'mcp_made', removeBy: '2027-06-30', services: ['web'], apply: true })).json.applied, true);
  assert.equal((await tool('set_default', { flag: 'mcp_made', environment: 'dev', variant: 'on', apply: true })).json.applied, true);
  await t.settle();                                      // published
  assert.equal((await tool('evaluate', { environment: 'dev', service: 'web', flag: 'mcp_made' })).json.value, true);
  assert.ok((await tool('set_default', { flag: 'mcp_made', environment: 'dev', variant: 'maybe' })).isError);
  assert.ok((await tool('create_flag', { key: 'no_date', apply: true })).isError, 'a release needs a remove-by date');
});

test('add_rule and remove_rule: a plan, then the whole layer saved by an agent; a request in prod; a bad rule is an error', async () => {
  await tool('create_flag', { key: 'mcp_rules', removeBy: '2027-06-30', services: ['web'], apply: true });
  const rule = { conditions: [{ field: 'app.version', op: 'semver_gte', values: ['5.0.0'] }], serve: 'on' };
  const plan = await tool('add_rule', { flag: 'mcp_rules', environment: 'dev', rule, name: 'New apps' });
  assert.equal(plan.json.applied, false);
  assert.match(plan.json.plan.add.when, /5\.0\.0/);
  assert.equal(plan.json.plan.add.gives, 'on');
  assert.equal((await layers('mcp_rules', 'dev')).base.rules.length, 0, 'nothing changed');

  const done = await tool('add_rule', { flag: 'mcp_rules', environment: 'dev', rule, name: 'New apps', apply: true });
  assert.equal(done.json.applied, true, done.text);
  const base = (await layers('mcp_rules', 'dev')).base;
  assert.deepEqual(base.rules.map((r: { name: string }) => r.name), ['New apps']);
  assert.equal(base.rules[0].ruleKey, done.json.ruleKey);
  assert.equal((await newest('mcp_rules', 'dev')).actorType, 'agent');

  // first, for one entity: a % of its devices, in settings of its own made for it
  const split = await tool('add_rule', { flag: 'mcp_rules', environment: 'dev', entity: 'acme', rule: { split: { on: 25 } }, name: 'A quarter', position: 1, apply: true });
  assert.equal(split.json.applied, true, split.text);
  const own = (await layers('mcp_rules', 'dev')).entities.find((e: { entity: string }) => e.entity === 'acme').layer;
  assert.deepEqual(own.rules[0].split.ranges.map((g: { variation: string; from: number; to: number }) => [g.variation, g.from, g.to]), [['on', 0, 2500]]);

  const bad = await tool('add_rule', { flag: 'mcp_rules', environment: 'dev', rule: { conditions: [{ field: 'shoe.size', op: 'in', values: ['44'] }], serve: 'on' }, apply: true });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /unknown attribute “shoe\.size”/);
  assert.ok((await tool('add_rule', { flag: 'mcp_rules', environment: 'dev', rule: { serve: 'maybe' } })).isError, 'an unknown variant');

  const asked = await tool('add_rule', { flag: 'mcp_rules', environment: 'prod', rule, apply: true });
  assert.equal(asked.json.applied, false);
  assert.equal(typeof asked.json.request, 'number');
  assert.equal((await layers('mcp_rules', 'prod')).base.rules.length, 0, 'nothing applied in prod');

  const keep = await tool('remove_rule', { flag: 'mcp_rules', environment: 'dev', name: 'New apps' });
  assert.equal(keep.json.applied, false);
  assert.equal((await layers('mcp_rules', 'dev')).base.rules.length, 1, 'nothing changed');
  assert.equal((await tool('remove_rule', { flag: 'mcp_rules', environment: 'dev', name: 'New apps', apply: true })).json.applied, true);
  assert.equal((await layers('mcp_rules', 'dev')).base.rules.length, 0);
  assert.equal((await newest('mcp_rules', 'dev')).actorType, 'agent');
  assert.equal((await tool('remove_rule', { flag: 'mcp_rules', environment: 'dev', entity: 'acme', ruleKey: own.rules[0].ruleKey, apply: true })).json.applied, true);
  assert.ok((await tool('remove_rule', { flag: 'mcp_rules', environment: 'dev', name: 'nope' })).isError);
});

test('set_entity_value: an entity’s own default, then its own settings removed', async () => {
  const ownOf = async () => (await layers('welcome_message', 'dev')).entities.find((e: { entity: string }) => e.entity === 'initech')?.layer ?? null;
  assert.equal(await ownOf(), null);
  const plan = await tool('set_entity_value', { flag: 'welcome_message', environment: 'dev', entity: 'initech', variant: 'beta' });
  assert.deepEqual(plan.json.plan.default, { from: null, to: 'beta' });
  assert.equal(await ownOf(), null, 'nothing changed');
  assert.equal((await tool('set_entity_value', { flag: 'welcome_message', environment: 'dev', entity: 'initech', variant: 'beta', apply: true })).json.applied, true);
  const own = await ownOf();
  assert.deepEqual([own.inherit, own.defaultVariation], ['base_rules_then_customer_default', 'beta']);
  assert.equal((await newest('welcome_message', 'dev')).actorType, 'agent');
  await t.settle();
  assert.equal((await tool('evaluate', { environment: 'dev', service: 'web', flag: 'welcome_message', entity: 'initech' })).json.variant, 'beta');

  assert.equal((await tool('set_entity_value', { flag: 'welcome_message', environment: 'dev', entity: 'initech', variant: null })).json.applied, false);
  assert.ok(await ownOf(), 'nothing changed');
  assert.equal((await tool('set_entity_value', { flag: 'welcome_message', environment: 'dev', entity: 'initech', variant: null, apply: true })).json.applied, true);
  assert.equal(await ownOf(), null);
  assert.ok((await tool('set_entity_value', { flag: 'welcome_message', environment: 'dev', entity: 'nobody', variant: 'beta' })).isError);
  assert.ok((await tool('set_entity_value', { flag: 'welcome_message', environment: 'dev', entity: 'initech', variant: 'nope' })).isError);
});

test('rollout_step: the release’s steps in dev, a request in prod, and request_status on it', async () => {
  await tool('create_flag', { key: 'mcp_rollout', removeBy: '2027-06-30', services: ['web'], apply: true });
  /** Where the Releases page says it is (read from what's published) */
  const step = async (env: string) => {
    await t.settle();
    return (await t.as('alice').get('/releases')).json.rows.find((r: { key: string }) => r.key === 'mcp_rollout').envs[env].text as string;
  };
  assert.equal(await step('dev'), 'Not started');
  const plan = await tool('rollout_step', { flag: 'mcp_rollout', environment: 'dev', step: 'next' });
  assert.deepEqual(plan.json.plan.step, { from: 'Not started', to: '1% of devices' });
  assert.equal(await step('dev'), 'Not started', 'nothing changed');

  assert.equal((await tool('rollout_step', { flag: 'mcp_rollout', environment: 'dev', step: 'next', apply: true })).json.step, '1% of devices');
  assert.equal((await newest('mcp_rollout', 'dev')).actorType, 'agent');
  assert.equal((await tool('rollout_step', { flag: 'mcp_rollout', environment: 'dev', step: 25, apply: true })).json.step, '25% of devices');
  assert.equal((await tool('rollout_step', { flag: 'mcp_rollout', environment: 'dev', step: 'back', apply: true })).json.step, '5% of devices');
  assert.equal((await tool('rollout_step', { flag: 'mcp_rollout', environment: 'dev', pause: true, apply: true })).json.step, 'Paused · 5% of devices');
  assert.ok((await tool('rollout_step', { flag: 'mcp_rollout', environment: 'dev', step: 'next' })).isError, 'no next step while paused');
  assert.equal((await tool('rollout_step', { flag: 'mcp_rollout', environment: 'dev', pause: false, apply: true })).json.step, '5% of devices');
  assert.equal((await tool('rollout_step', { flag: 'mcp_rollout', environment: 'dev', step: 'everyone', apply: true })).json.step, 'Everyone');
  assert.equal(await step('dev'), 'Everyone');
  assert.ok((await tool('rollout_step', { flag: 'welcome_message', environment: 'dev', step: 'next' })).isError, 'not a release');

  const asked = await tool('rollout_step', { flag: 'mcp_rollout', environment: 'prod', step: 'next', apply: true });
  assert.equal(asked.json.applied, false, asked.text);
  assert.equal(typeof asked.json.request, 'number');
  assert.equal(await step('prod'), 'Not started', 'nothing applied in prod');

  const status = await tool('request_status', { id: asked.json.request });
  assert.equal(status.json.status, 'in_review');
  assert.equal(status.json.byAgent, true);
  assert.deepEqual(status.json.approvals, { has: 0, needs: 1 });
  assert.deepEqual(status.json.items.map((i: { flag: string }) => i.flag), ['mcp_rollout']);
  assert.ok((await tool('request_status', { id: 999999 })).isError);
});

test('compare: two entities, two environments', async () => {
  const two = await tool('compare', { environment: 'dev', service: 'web', a: 'acme', b: 'globex', onlyDiff: true });
  assert.ok(two.json.different > 0);
  assert.ok(two.json.flags.every((f: { same: boolean }) => !f.same));
  const dark = two.json.flags.find((f: { key: string }) => f.key === 'dark_mode_v2');
  assert.equal(dark.b.value, true, 'globex is a beta customer');
  const envs = await tool('compare', { service: 'web', a: 'dev', b: { environment: 'prod' } });
  assert.deepEqual([envs.json.a.environment, envs.json.b.environment], ['dev', 'prod']);
  assert.ok(envs.json.flags.length > 0);
  assert.ok((await tool('compare', { service: 'web', a: 'acme', b: 'globex' })).isError, 'an entity needs an environment');
});

test('resources and prompts', async () => {
  const flag = await rpc('resources/read', { uri: 'companyflags://flags/new_checkout' });
  assert.equal(JSON.parse(flag.result.contents[0].text).key, 'new_checkout');
  const attrs = await rpc('resources/read', { uri: 'companyflags://attributes' });
  assert.ok(JSON.parse(attrs.result.contents[0].text).some((f: { name: string }) => f.name === 'app.version'));
  assert.equal((await rpc('resources/read', { uri: 'companyflags://flags/nope' })).error.code, -32002);
  assert.ok((await rpc('resources/list')).result.resources.some((r: { uri: string }) => r.uri === 'companyflags://attributes'));
  const names = (await rpc('prompts/list')).result.prompts.map((p: { name: string }) => p.name);
  assert.deepEqual(names, ['put_behind_a_flag', 'clean_up_releases']);
  const p = await rpc('prompts/get', { name: 'put_behind_a_flag', arguments: { change: 'a new search page' } });
  assert.match(p.result.messages[0].content.text, /flags\.json/);
  assert.equal((await rpc('prompts/get', { name: 'put_behind_a_flag' })).error.code, -32602);
});

test('unknown method or tool: a JSON-RPC error', async () => {
  const r = await rpc('flags/explode');
  assert.equal(r.error.code, -32601);
  assert.equal((await rpc('tools/call', { name: 'nope', arguments: {} })).error.code, -32602);
  assert.equal((await post('{nope', { authorization: `Bearer ${agent}` })).json.error.code, -32700);
});

test('companyflags mcp forwards stdin lines to /mcp with the token, and prints only answers', async () => {
  const lines: string[] = [];
  const errs: string[] = [];
  const stdin = Readable.from([
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`,
    `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_flag', arguments: { key: 'new_checkout' } } })}\n`,
  ]);
  const seen: string[] = [];
  const code = await main(['mcp', '--url', 'http://flags.test/'], {
    env: { COMPANYFLAGS_TOKEN: agent }, stdin, out: (l) => lines.push(l), err: (l) => errs.push(l),
    fetch: (async (url: string, init: RequestInit) => { seen.push(url); return t.app.request('/mcp', init); }) as typeof fetch,
  });
  assert.equal(code, 0, errs.join('\n'));
  assert.deepEqual(seen, ['http://flags.test/mcp', 'http://flags.test/mcp', 'http://flags.test/mcp']);
  assert.equal(lines.length, 2, 'nothing for the notification');
  assert.deepEqual(lines.map((l) => JSON.parse(l).id), [1, 2]);
  assert.equal(JSON.parse(JSON.parse(lines[1]).result.content[0].text).key, 'new_checkout');
  // a wrong token: the client is told, as a JSON-RPC error
  const bad: string[] = [];
  await main(['mcp', '--url', 'http://flags.test', '--token', 'cfp_wrong'], {
    stdin: Readable.from([`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' })}\n`]), out: (l) => bad.push(l), err: () => {},
    fetch: (async (_url: string, init: RequestInit) => t.app.request('/mcp', init)) as typeof fetch,
  });
  assert.equal(JSON.parse(bad[0]).id, 7);
  assert.match(JSON.parse(bad[0]).error.message, /401/);
});
