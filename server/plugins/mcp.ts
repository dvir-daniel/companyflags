// The MCP plugin: CompanyFlags for AI agents, over the Model Context Protocol (docs/design/ai.md, section 3).
//   POST /mcp   JSON-RPC 2.0 in, application/json out (Streamable HTTP, stateless: no sessions, no streams)
//   GET  /mcp   405: this server doesn't stream
//
// The caller sends an access token (Authorization: Bearer cfp_…, ../tokens.ts). Every tool calls the console's API
// with that token (PluginContext.request), so its role, the approvals and History hold as for any script: an agent's
// change in an environment that needs approval is a request a person approves. The token goes to this server's own
// API and nowhere else. A request from a web page on another site (its Origin header) is refused, against DNS
// rebinding.

import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { definePlugin, type PluginContext } from '../plugin.ts';
import { FLAG_KINDS } from '../flagsAsCode.ts';

export const MCP_PROTOCOL = '2025-11-25';
const PROTOCOLS = new Set([MCP_PROTOCOL, '2025-06-18', '2025-03-26']);
const VERSION = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;

const INSTRUCTIONS = `CompanyFlags: feature flags and remote config, read by apps with OpenFeature.
Read and explain freely. Each change tool shows what it would change; call it again with apply: true to do it.
Where an environment needs approval, a change is a request a person approves: say its number, and never try to get around it.`;

// ------------------------------------------------------------------ JSON-RPC
type Id = string | number;
type Message = { jsonrpc?: unknown; id?: Id | null; method?: unknown; params?: unknown };
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const NO_METHOD = -32601;
const INVALID_PARAMS = -32602;
const NO_RESOURCE = -32002;

/** A protocol error: answered as a JSON-RPC error, not as a tool's result. */
class RpcError extends Error {
  code: number;
  constructor(code: number, message: string) { super(message); this.code = code; }
}
/** A tool that couldn't do what it was asked: answered as its result, with isError, so the agent reads why. */
class ToolError extends Error {}

const rpcError = (id: Id | null, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

// ------------------------------------------------------------------ the console's API, as the caller
type Answer = { status: number; json: any };
type Api = {
  get: (path: string, query?: Record<string, unknown>) => Promise<any>;
  send: (method: string, path: string, body: unknown) => Promise<Answer>;
};

function apiFor(request: PluginContext['request'], token: string) {
  const call = async (method: string, path: string, body?: unknown): Promise<Answer> => {
    const res = await request(`/api${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { error: text }; }
    return { status: res.status, json };
  };
  const ok = (r: Answer) => {
    if (r.status >= 400) throw new ToolError(r.json?.error ?? `the API answered ${r.status}`);
    return r.json;
  };
  const api: Api = {
    get: async (path, query = {}) => {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
      return ok(await call('GET', `${path}${q.size ? `?${q}` : ''}`));
    },
    send: call,
  };
  return { api, call, ok };
}
const seg = (s: unknown) => encodeURIComponent(String(s));

// ------------------------------------------------------------------ tools
type Schema = { type: 'object'; properties: Record<string, { type: string; description?: string; enum?: readonly string[]; items?: unknown }>; required?: string[] };
type Args = Record<string, any>;
type Tool = {
  name: string; description: string; inputSchema: Schema; readOnly: boolean; destructive?: boolean;
  run: (a: Args, api: Api, ok: (r: Answer) => any) => Promise<unknown>;
};

const str = (description: string) => ({ type: 'string', description });
const APPLY = { type: 'boolean', description: 'false (the default): only say what would change. true: change it.' };
const REASON = str('Why, for History and for the person who approves a request');
const TARGET = {
  environment: str('Environment key, e.g. dev'),
  service: str('Service key: the app or backend asking, e.g. web'),
  entity: str('Entity key, e.g. acme (none: what everyone gets before sign-in)'),
  attrs: { type: 'object', description: 'What the app reports, flat, e.g. {"app.version": "5.2.0", "device.id": "d-1"}' },
};

/** Checks the arguments against the tool's schema: what's required is there, and each has its type. */
function checkArgs(schema: Schema, a: unknown): Args {
  if (a === undefined || a === null) a = {};
  if (typeof a !== 'object' || Array.isArray(a)) throw new ToolError('arguments: an object');
  const args = a as Args;
  for (const k of schema.required ?? []) if (args[k] === undefined || args[k] === null || args[k] === '') throw new ToolError(`${k} is required`);
  for (const [k, v] of Object.entries(args)) {
    const p = schema.properties[k];
    if (!p) throw new ToolError(`unknown argument ${k}`);
    if (v === undefined || v === null) continue;
    const is = Array.isArray(v) ? 'array' : typeof v === 'number' && Number.isInteger(v) ? 'integer' : typeof v;
    const fits = is === p.type || (p.type === 'number' && is === 'integer') || (p.type === 'integer' && is === 'integer');
    if (!fits) throw new ToolError(`${k}: a${/^[aeiou]/.test(p.type) ? 'n' : ''} ${p.type}`);
    if (p.enum && !p.enum.includes(v)) throw new ToolError(`${k}: one of ${p.enum.join(', ')}`);
  }
  return args;
}

/** The environments, and which need approval. */
async function environments(api: Api) {
  const meta = await api.get('/meta');
  return (meta.environments as { key: string; name: string; minApprovals: number }[])
    .map((e) => ({ key: e.key, name: e.name, needsApproval: e.minApprovals > 0, approvals: e.minApprovals }));
}
async function environment(api: Api, key: string) {
  const e = (await environments(api)).find((x) => x.key === key);
  if (!e) throw new ToolError(`no environment "${key}" (list_environments)`);
  return e;
}

/** A flag's defaults in one environment, as a layer to save (without its version and who changed it last). */
async function baseOf(api: Api, flag: string, env: string) {
  const f = await api.get(`/flags/${seg(flag)}`);
  const base = f.layers?.[env]?.base;
  if (!base) throw new ToolError(`${flag} has no settings in ${env}`);
  const { version, updatedAt: _a, updatedBy: _b, ...layer } = base;
  return { f, version: version as number, layer: layer as Args };
}

/** What a change tool answers once it called the API: applied, or a request where approval is needed. */
function outcome(r: Answer, ok: (r: Answer) => any, env: string) {
  const j = ok(r);
  if (j?.applied === false) {
    return { applied: false, request: j.changeSetId,
      message: `${env} needs approval: request #${j.changeSetId} waits for a person to approve it. Nothing changed yet (list_requests).` };
  }
  return { applied: true, ...(j?.revision !== undefined ? { revision: j.revision } : {}) };
}

/** What a change tool answers before it is applied. */
const plan = (env: { key: string; needsApproval: boolean } | null, change: Record<string, unknown>) => ({
  applied: false, plan: change,
  then: env?.needsApproval
    ? `${env.key} needs approval: with apply: true this becomes a request a person approves.`
    : 'Call again with apply: true to change it.',
});

const flagRow = (f: any) => ({
  key: f.key, name: f.name, kind: f.kind, type: f.valueType, owner: f.owner, tags: f.tags, removeBy: f.removeBy, description: f.description,
  services: Object.values(f.delivery ?? {})[0] ?? [],
  environments: Object.fromEntries(Object.entries(f.envs ?? {}).map(([k, v]: [string, any]) =>
    [k, { on: v.enabled, default: v.defaultVariation, rules: v.rules, entities: v.entityLayers }])),
});

const flagDoc = (f: any) => ({
  key: f.key, name: f.name, kind: f.kind, type: f.valueType, description: f.description, owner: f.owner, tags: f.tags,
  removeBy: f.removeBy, archived: !!f.archivedAt, freeValues: f.freeValues,
  variants: Object.fromEntries((f.variations ?? []).map((v: { key: string; value: unknown }) => [v.key, v.value])),
  environments: Object.fromEntries(Object.entries(f.layers ?? {}).map(([env, l]: [string, any]) => {
    const { updatedAt: _a, updatedBy: _b, ...base } = l.base ?? {};
    return [env, { services: f.delivery?.[env] ?? [], ...base, entities: l.entities }];
  })),
});

const TOOLS: Tool[] = [
  // ---------------------------------------------------------------- read
  {
    name: 'list_flags', readOnly: true,
    description: 'List flags: key, kind, owner, tags, and whether each is on per environment. Search and filter.',
    inputSchema: { type: 'object', properties: {
      q: str('Part of a key, name, description or tag'), tag: str('Only flags with this tag'), owner: str('Only flags with this owner'),
      environment: str('The environment whose services are shown (default: the first)'),
    } },
    run: async (a, api) => {
      const r = await api.get('/flags', { q: a.q, tag: a.tag, owner: a.owner, environment: a.environment, page: 0, size: 200 });
      return { matched: r.matched, flags: r.rows.map(flagRow) };
    },
  },
  {
    name: 'get_flag', readOnly: true,
    description: 'One flag: its variants, and per environment its services, on or off, default, rules and entities with settings of their own.',
    inputSchema: { type: 'object', properties: { key: str('Flag key') }, required: ['key'] },
    run: async (a, api) => flagDoc(await api.get(`/flags/${seg(a.key)}`)),
  },
  {
    name: 'list_services', readOnly: true,
    description: 'The services (apps and backends) flags are sent to.',
    inputSchema: { type: 'object', properties: {} },
    run: async (_a, api) => (await api.get('/meta')).projects,
  },
  {
    name: 'list_environments', readOnly: true,
    description: 'The environments, and which need approval for changes.',
    inputSchema: { type: 'object', properties: {} },
    run: async (_a, api) => environments(api),
  },
  {
    name: 'list_dimensions', readOnly: true,
    description: 'The dimensions entities are in, top to bottom. With a dimension: its entities.',
    inputSchema: { type: 'object', properties: { dimension: str('A dimension key: list its entities'), q: str('Part of an entity key or name') } },
    run: async (a, api) => {
      const meta = await api.get('/meta');
      if (!a.dimension) return meta.dimensions;
      const q = String(a.q ?? '').toLowerCase();
      const entities = (meta.entities as { key: string; name: string; dimension: string; parent: string | null }[])
        .filter((e) => e.dimension === a.dimension && (!q || e.key.includes(q) || e.name.toLowerCase().includes(q)));
      return { matched: entities.length, entities: entities.slice(0, 200).map(({ key, name, parent }) => ({ key, name, parent })) };
    },
  },
  {
    name: 'history', readOnly: true,
    description: 'Recent changes, newest first: who (a person or an agent), what, where and why.',
    inputSchema: { type: 'object', properties: {
      flag: str('Only this flag'), environment: str('Only this environment'), limit: { type: 'integer', description: 'How many (default 20, at most 200)' },
    } },
    run: async (a, api) => {
      const rows = await api.get('/history', { flag: a.flag, environment: a.environment, limit: Math.min(Math.max(a.limit ?? 20, 1), 200) });
      return rows.map((h: any) => ({
        id: h.id, at: h.changedAt, environment: h.environment, revision: h.revision, by: h.changedBy, actorType: h.actorType,
        change: h.changeType, flag: h.flag, entity: h.entity, comment: h.comment, request: h.changeSetId, before: h.before, after: h.after,
      }));
    },
  },
  {
    name: 'list_requests', readOnly: true,
    description: 'Change requests: changes waiting for approval, or decided. Newest first.',
    inputSchema: { type: 'object', properties: {
      status: { type: 'string', description: 'Only this status', enum: ['in_review', 'approved', 'scheduled', 'applied', 'failed', 'conflict', 'rejected', 'cancelled'] },
    } },
    run: async (a, api) => (await api.get('/change-sets', { status: a.status })).slice(0, 50).map((r: any) => ({
      id: r.id, environment: r.environment, status: r.status, author: r.author, reason: r.reason, createdAt: r.createdAt,
      appliedAt: r.appliedAt, items: r.items, reviews: r.reviews,
    })),
  },
  {
    name: 'stale_flags', readOnly: true,
    description: 'Releases to clean up: past their remove-by date, or done (everyone gets the same value everywhere).',
    inputSchema: { type: 'object', properties: {} },
    run: async (_a, api) => {
      const r = await api.get('/releases');
      return r.rows.filter((f: any) => f.overdue || f.ready).map((f: any) => ({
        key: f.key, name: f.name, owner: f.owner, removeBy: f.removeBy, overdue: f.overdue, ready: f.ready,
        environments: Object.fromEntries(Object.entries(f.envs).map(([k, v]: [string, any]) => [k, v?.text ?? null])),
      }));
    },
  },
  // ---------------------------------------------------------------- explain
  {
    name: 'evaluate', readOnly: true,
    description: 'What a service gets: one flag, or every flag sent to it, for an entity and what the app reports.',
    inputSchema: { type: 'object', properties: { ...TARGET, flag: str('One flag key (default: every flag)') }, required: ['environment', 'service'] },
    run: async (a, api, ok) => {
      const r = ok(await api.send('POST', '/trace', { environment: a.environment, project: a.service, entity: a.entity ?? null, attrs: a.attrs ?? {}, flag: a.flag }));
      const answer = (x: any) => ({ key: x.key, value: x.codeDefault ? null : x.value, variant: x.variant, codeDefault: !!x.codeDefault, reason: x.reason,
        ...(x.errorCode ? { error: x.errorCode } : {}) });
      if (a.flag) return answer(r.result);
      const sent = r.results.filter((x: any) => x.errorCode !== 'FLAG_NOT_FOUND');
      return { revision: r.revision, flags: sent.map(answer), notSent: r.results.length - sent.length };
    },
  },
  {
    name: 'explain', readOnly: true,
    description: 'Why a flag gives what it does: the evaluator’s steps, rule by rule, for an entity and what the app reports.',
    inputSchema: { type: 'object', properties: { flag: str('Flag key'), ...TARGET }, required: ['flag', 'environment', 'service'] },
    run: async (a, api, ok) => {
      const r = ok(await api.send('POST', '/trace', { environment: a.environment, project: a.service, entity: a.entity ?? null, attrs: a.attrs ?? {}, flag: a.flag })).result;
      return {
        key: r.key, value: r.codeDefault ? null : r.value, variant: r.variant, codeDefault: !!r.codeDefault, reason: r.reason, decidedBy: r.decidedBy,
        steps: r.trace.map((s: any) => ({ stage: s.stage, outcome: s.outcome, detail: s.detail, rule: s.ruleName ?? undefined, owner: s.owner,
          conditions: s.conditions, split: s.split })),
      };
    },
  },
  // ---------------------------------------------------------------- change
  {
    name: 'create_flag', readOnly: false,
    description: 'Create a flag in every environment, with no rules. Where an environment needs approval it starts off.',
    inputSchema: { type: 'object', properties: {
      key: str('Flag key, lowercase with underscores, e.g. new_checkout'), name: str('A readable name'), description: str('What it does'),
      kind: { type: 'string', description: 'Its purpose (default release)', enum: FLAG_KINDS },
      type: { type: 'string', description: 'Its values (default bool)', enum: ['bool', 'string', 'number', 'json'] },
      variants: { type: 'object', description: 'Variant → value (default for bool: {"on": true, "off": false})' },
      default: str('The variant everyone gets (default for bool: off)'),
      owner: str('Who owns it, e.g. payments-team'), tags: { type: 'array', items: { type: 'string' }, description: 'Tags' },
      removeBy: str('YYYY-MM-DD: release and experiment flags need one'),
      services: { type: 'array', items: { type: 'string' }, description: 'The services it is sent to, in every environment' },
      on: { type: 'boolean', description: 'On where no approval is needed (default true)' },
      apply: APPLY,
    }, required: ['key'] },
    run: async (a, api, ok) => {
      const type = a.type ?? 'bool';
      const variants: Record<string, unknown> = a.variants ?? (type === 'bool' ? { on: true, off: false } : {});
      const keys = Object.keys(variants);
      if (!keys.length) throw new ToolError('variants: at least one, e.g. {"a": "value"}');
      const def = a.default ?? (type === 'bool' ? 'off' : keys[0]);
      if (!keys.includes(def)) throw new ToolError(`default: one of the variants (${keys.join(', ')})`);
      const envs = await environments(api);
      const services: string[] = a.services ?? [];
      const body = {
        key: a.key, name: a.name ?? null, description: a.description, kind: a.kind ?? 'release', valueType: type, owner: a.owner, tags: a.tags,
        removeBy: a.removeBy ?? null, variations: keys.map((k) => ({ key: k, value: variants[k] })),
        delivery: Object.fromEntries(envs.map((e) => [e.key, services])),
        base: { enabled: a.on ?? true, defaultVariation: def, rules: [] },
      };
      if (!a.apply) {
        return { applied: false, plan: { create: a.key, kind: body.kind, type, variants, default: def, services,
          environments: Object.fromEntries(envs.map((e) => [e.key, e.needsApproval ? 'off (needs approval to turn on)' : body.base.enabled ? 'on' : 'off'])) },
        then: 'Call again with apply: true to create it.' };
      }
      ok(await api.send('POST', '/flags', body));
      return { applied: true, created: a.key };
    },
  },
  {
    name: 'set_services',
    readOnly: false,
    description: 'Set the services a flag is sent to in one environment. A service it isn’t sent to never sees the flag.',
    inputSchema: { type: 'object', properties: {
      flag: str('Flag key'), environment: str('Environment key'), services: { type: 'array', items: { type: 'string' }, description: 'Every service it is sent to after this' },
      reason: REASON, apply: APPLY,
    }, required: ['flag', 'environment', 'services'] },
    run: async (a, api, ok) => {
      const env = await environment(api, a.environment);
      const f = await api.get(`/flags/${seg(a.flag)}`);
      const before: string[] = f.delivery?.[env.key] ?? [];
      const after = [...new Set(a.services as string[])];
      if ([...before].sort().join() === [...after].sort().join()) return { applied: false, unchanged: true, message: `${a.flag} is already in exactly these services in ${env.key}` };
      if (!a.apply) return plan(env, { flag: a.flag, environment: env.key, services: { from: before, to: after } });
      return outcome(await api.send('PUT', `/flags/${seg(a.flag)}/delivery`, { environment: env.key, projects: after, before, reason: a.reason }), ok, env.key);
    },
  },
  {
    name: 'set_enabled',
    readOnly: false,
    description: 'Turn a flag on or off in one environment. Off, every app gets its code default (or the variant for off).',
    inputSchema: { type: 'object', properties: {
      flag: str('Flag key'), environment: str('Environment key'), on: { type: 'boolean', description: 'true: on, false: off' }, reason: REASON, apply: APPLY,
    }, required: ['flag', 'environment', 'on'] },
    run: async (a, api, ok) => {
      const env = await environment(api, a.environment);
      const { version, layer } = await baseOf(api, a.flag, env.key);
      const now = !!layer.enabled;
      if (now === a.on) return { applied: false, unchanged: true, message: `${a.flag} is already ${now ? 'on' : 'off'} in ${env.key}` };
      if (!a.apply) return plan(env, { flag: a.flag, environment: env.key, on: { from: now, to: a.on } });
      const reason = a.reason ?? `Turn ${a.flag} ${a.on ? 'on' : 'off'} in ${env.key}`;
      return outcome(await api.send('PUT', `/flags/${seg(a.flag)}/layers/${seg(env.key)}/base`, { layer: { ...layer, enabled: a.on }, expectedVersion: version, reason }), ok, env.key);
    },
  },
  {
    name: 'set_default',
    readOnly: false,
    description: 'Set the variant a flag gives in one environment when no rule matches.',
    inputSchema: { type: 'object', properties: {
      flag: str('Flag key'), environment: str('Environment key'), variant: str('A variant key of the flag (get_flag)'), reason: REASON, apply: APPLY,
    }, required: ['flag', 'environment', 'variant'] },
    run: async (a, api, ok) => {
      const env = await environment(api, a.environment);
      const { f, version, layer } = await baseOf(api, a.flag, env.key);
      const variants = (f.variations as { key: string }[]).map((v) => v.key);
      if (!f.freeValues && !variants.includes(a.variant)) throw new ToolError(`${a.flag} has no variant "${a.variant}": its variants are ${variants.join(', ')}`);
      if (layer.defaultVariation === a.variant) return { applied: false, unchanged: true, message: `${a.flag} already gives ${a.variant} by default in ${env.key}` };
      if (!a.apply) return plan(env, { flag: a.flag, environment: env.key, default: { from: layer.defaultVariation ?? null, to: a.variant } });
      const reason = a.reason ?? `Give ${a.variant} by default for ${a.flag} in ${env.key}`;
      return outcome(await api.send('PUT', `/flags/${seg(a.flag)}/layers/${seg(env.key)}/base`, { layer: { ...layer, defaultVariation: a.variant }, expectedVersion: version, reason }), ok, env.key);
    },
  },
  {
    name: 'archive_flag',
    readOnly: false, destructive: true,
    description: 'Archive a flag: it is no longer sent anywhere. Only once no code reads it.',
    inputSchema: { type: 'object', properties: { flag: str('Flag key'), apply: APPLY }, required: ['flag'] },
    run: async (a, api, ok) => {
      const f = flagDoc(await api.get(`/flags/${seg(a.flag)}`));
      if (f.archived) return { applied: false, unchanged: true, message: `${a.flag} is already archived` };
      if (!a.apply) {
        const sentTo = Object.fromEntries(Object.entries(f.environments).map(([k, v]: [string, any]) => [k, { services: v.services, on: !!v.enabled }]));
        return { applied: false, plan: { archive: a.flag, sentTo }, then: 'Check no code reads it, then call again with apply: true.' };
      }
      ok(await api.send('POST', `/flags/${seg(a.flag)}/archive`, {}));
      return { applied: true, archived: a.flag };
    },
  },
];
const TOOL = new Map(TOOLS.map((t) => [t.name, t]));

// ------------------------------------------------------------------ resources
const ATTRIBUTES = 'companyflags://attributes';
const FLAG_URI = /^companyflags:\/\/flags\/([^/?#]+)$/;

// ------------------------------------------------------------------ prompts
type Prompt = { name: string; description: string; arguments: { name: string; description: string; required?: boolean }[]; text: (a: Record<string, string>) => string };
const PROMPTS: Prompt[] = [
  {
    name: 'put_behind_a_flag',
    description: 'Put a code change behind a new release flag, with the old path as the code default.',
    arguments: [
      { name: 'change', description: 'What the change does', required: true },
      { name: 'service', description: 'The service that reads the flag, e.g. web' },
    ],
    text: (a) => `Put this change behind a new release flag: ${a.change}

1. Pick a key in lowercase with underscores that says what it turns on, e.g. new_checkout. Check with list_flags that it is free.
2. Create it with create_flag: kind release, type bool, variants on and off, default off, an owner, a remove-by date about three months ahead, and the services that read it${a.service ? ` (${a.service})` : ''}. Read the plan, then call it again with apply: true.
3. In the code, read the flag with OpenFeature, e.g. client.getBooleanValue('<key>', false). The code default, false, is the old path: when the flag can't be read, the app does what it did before. Keep the old path working and put the new one where the flag is true.
4. Add the flag to flags.json in the same change (its name, kind, type, removeBy, variants, default and services), so \`companyflags flags plan\` has nothing to do.
5. Don't turn it on where an environment needs approval. There set_enabled makes a request a person approves: say its number.`,
  },
  {
    name: 'clean_up_releases',
    description: 'Find releases that are done or past their remove-by date, and remove them from the code.',
    arguments: [],
    text: () => `Clean up finished releases.

1. Call stale_flags. It lists releases past their remove-by date (overdue) and those everyone gets the same value of everywhere (ready).
2. For each one, call get_flag to see what each environment gives, and search the code for its key.
3. For a ready one, keep the path everyone gets and remove the other path and the flag read. Remove it from flags.json too.
4. For an overdue one that isn't ready, don't change the code: tell its owner, with what each environment gives.
5. Once the code without the flag is shipped everywhere, call archive_flag: read the plan, then call it again with apply: true. Never archive a flag that code still reads.`,
  },
];
const PROMPT = new Map(PROMPTS.map((p) => [p.name, p]));

// ------------------------------------------------------------------ one message
const obj = (p: unknown): Record<string, any> => {
  if (p === undefined || p === null) return {};
  if (typeof p !== 'object' || Array.isArray(p)) throw new RpcError(INVALID_PARAMS, 'params: an object');
  return p as Record<string, any>;
};

async function answer(method: string, params: unknown, api: Api, ok: (r: Answer) => any): Promise<unknown> {
  const p = obj(params);
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOLS.has(p.protocolVersion) ? p.protocolVersion : MCP_PROTOCOL,
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: { name: 'companyflags', title: 'CompanyFlags', version: VERSION },
        instructions: INSTRUCTIONS,
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema,
        annotations: { readOnlyHint: t.readOnly, ...(t.readOnly ? {} : { destructiveHint: !!t.destructive }), openWorldHint: false } })) };
    case 'tools/call': {
      const tool = TOOL.get(p.name);
      if (!tool) throw new RpcError(INVALID_PARAMS, `unknown tool: ${String(p.name)}`);
      try {
        const out = await tool.run(checkArgs(tool.inputSchema, p.arguments), api, ok);
        return { content: [{ type: 'text', text: JSON.stringify(out) }], isError: false };
      } catch (e) {
        if (e instanceof ToolError) return { content: [{ type: 'text', text: e.message }], isError: true };
        throw e;
      }
    }
    case 'resources/list': {
      const flags = await api.get('/flags', { page: 0, size: 200 });
      return { resources: [
        { uri: ATTRIBUTES, name: 'attributes', title: 'Attributes', description: 'Every attribute a rule can check', mimeType: 'application/json' },
        ...flags.rows.map((f: any) => ({ uri: `companyflags://flags/${f.key}`, name: f.key, title: f.name ?? f.key, description: f.description ?? undefined, mimeType: 'application/json' })),
      ] };
    }
    case 'resources/templates/list':
      return { resourceTemplates: [{ uriTemplate: 'companyflags://flags/{key}', name: 'flag', title: 'A flag', description: 'One flag as JSON', mimeType: 'application/json' }] };
    case 'resources/read': {
      const uri = String(p.uri ?? '');
      const json = (data: unknown) => ({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data) }] });
      if (uri === ATTRIBUTES) return json((await api.get('/meta')).fields);
      const m = uri.match(FLAG_URI);
      if (!m) throw new RpcError(NO_RESOURCE, `resource not found: ${uri}`);
      try {
        return json(flagDoc(await api.get(`/flags/${seg(decodeURIComponent(m[1]))}`)));
      } catch (e) {
        if (e instanceof ToolError) throw new RpcError(NO_RESOURCE, `${uri}: ${e.message}`);
        throw e;
      }
    }
    case 'prompts/list':
      return { prompts: PROMPTS.map(({ name, description, arguments: args }) => ({ name, description, arguments: args })) };
    case 'prompts/get': {
      const prompt = PROMPT.get(p.name);
      if (!prompt) throw new RpcError(INVALID_PARAMS, `unknown prompt: ${String(p.name)}`);
      const args = obj(p.arguments) as Record<string, string>;
      const missing = prompt.arguments.find((x) => x.required && !args[x.name]);
      if (missing) throw new RpcError(INVALID_PARAMS, `${missing.name} is required`);
      return { description: prompt.description, messages: [{ role: 'user', content: { type: 'text', text: prompt.text(args) } }] };
    }
    default:
      throw new RpcError(NO_METHOD, `method not found: ${method}`);
  }
}

// ------------------------------------------------------------------ the plugin
export const mcp = () => definePlugin({
  id: 'mcp',
  setup: ({ request, baseURL, log }) => {
    const own = (() => { try { return baseURL ? new URL(baseURL).origin : null; } catch { return null; } })();
    const routes = new Hono();

    routes.post('/mcp', async (c) => {
      // against DNS rebinding: a web page on another site can't reach this through someone's browser
      const origin = c.req.header('origin');
      if (origin && origin !== new URL(c.req.url).origin && origin !== own) return c.json({ error: 'this Origin may not use /mcp' }, 403);
      const token = c.req.header('authorization')?.match(/^Bearer\s+(cfp_\S+)$/i)?.[1];
      if (!token) {
        c.header('WWW-Authenticate', 'Bearer realm="companyflags"');
        return c.json({ error: 'an access token is needed: Authorization: Bearer cfp_…' }, 401);
      }
      const version = c.req.header('mcp-protocol-version');
      if (version && !PROTOCOLS.has(version)) return c.json({ error: `unsupported MCP-Protocol-Version: ${version} (this server speaks ${MCP_PROTOCOL})` }, 400);

      let msg: Message;
      try { msg = JSON.parse(await c.req.text()); } catch { return c.json(rpcError(null, PARSE_ERROR, 'the body isn’t valid JSON'), 400); }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return c.json(rpcError(null, INVALID_REQUEST, 'one JSON-RPC message per request (no batches)'), 400);

      const { api, call, ok } = apiFor(request, token);
      // the token itself: unknown, expired or revoked is a 401 before anything else
      const who = await call('GET', '/dimensions');
      if (who.status === 401) {
        c.header('WWW-Authenticate', 'Bearer realm="companyflags", error="invalid_token"');
        return c.json({ error: who.json?.error ?? 'unknown, expired or revoked access token' }, 401);
      }
      // a notification, or the client's answer to something: nothing to answer
      const id = msg.id;
      if (typeof msg.method !== 'string' || id === undefined || id === null) {
        if (typeof msg.method === 'string' || 'result' in msg || 'error' in msg) return c.body(null, 202);
        return c.json(rpcError(null, INVALID_REQUEST, 'not a JSON-RPC 2.0 message'), 400);
      }
      if (msg.jsonrpc !== '2.0' || (typeof id !== 'string' && typeof id !== 'number')) return c.json(rpcError(null, INVALID_REQUEST, 'not a JSON-RPC 2.0 request'));
      try {
        return c.json({ jsonrpc: '2.0', id, result: await answer(msg.method, msg.params, api, ok) });
      } catch (e) {
        if (e instanceof RpcError) return c.json(rpcError(id, e.code, e.message));
        if (e instanceof ToolError) return c.json(rpcError(id, -32603, e.message));
        log(`mcp: ${msg.method}: ${(e as Error).stack ?? String(e)}`);
        return c.json(rpcError(id, -32603, 'internal error'));
      }
    });
    // a stateless server: it opens no stream and keeps no session
    routes.get('/mcp', (c) => { c.header('Allow', 'POST'); return c.json({ error: 'this server doesn’t stream: POST JSON-RPC messages to /mcp' }, 405); });
    routes.delete('/mcp', (c) => { c.header('Allow', 'POST'); return c.json({ error: 'this server keeps no sessions' }, 405); });

    return { routes, prefixes: ['/mcp'] };
  },
});
