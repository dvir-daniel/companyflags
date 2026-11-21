// Fills a CompanyFlags server with what the examples read, through its console API (/api), with an Editor's token.
//
//   FLAGS_URL=http://localhost:8787 FLAGS_TOKEN=cfp_… node examples/seed.ts
//
// FLAGS_TOKEN is an access token with the role Editor: in the console, your name at the foot of the sidebar →
// Account → + New token. A token never changes settings, so an admin makes these in the console first:
//   - the environment dev (Settings → Environments)
//   - the dimension company (Settings → Dimensions)
//   - the services web (an app) and api (a backend) (Services)
// The seed checks they are there, and says what is missing. Then it makes, unless they are there already:
//   - the companies acme (Acme Corp) and globex (Globex)
//   - the flags new_checkout (on/off), welcome_message (text) and max_upload_mb (a number)
// API keys are settings too: it ends by saying which two to make (API Keys → + New key) and where each goes.
// Node 22.18 or later runs it as is.

const base = (process.env.FLAGS_URL ?? 'http://localhost:8787').replace(/\/+$/, '');
const token = process.env.FLAGS_TOKEN;
if (!token) {
  console.error('Set FLAGS_TOKEN to an access token with the role Editor (cfp_…): your name → Account → + New token.');
  process.exit(1);
}

type Answer = { status: number; body: any };
async function call(method: string, path: string, body?: unknown): Promise<Answer> {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Makes something, unless `found` (a GET) finds it or the server answers 409: it is there already. */
async function make(what: string, path: string, body: unknown, found?: string) {
  if (found && (await call('GET', found)).status === 200) return console.log(`  ${what}: there already`);
  const r = await call('POST', path, body);
  if (r.status === 409) return console.log(`  ${what}: there already`);
  if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
  console.log(`  ${what}: made`);
}

const ENV = 'dev';
console.log(`Setting up ${base}`);

// What an admin makes in the console: the seed only checks it.
const meta = await call('GET', '/meta');
if (meta.status !== 200) throw new Error(`reading the server: ${meta.status} ${JSON.stringify(meta.body)}`);
const has = (list: { key: string; kind?: string }[], key: string, kind?: string) => list.some((x) => x.key === key && (!kind || x.kind === kind));
const missing = [
  !has(meta.body.environments, ENV) && 'Settings → Environments → add Development, key dev.',
  !has(meta.body.dimensions, 'company') && 'Settings → Dimensions → add company (one company, many companies).',
  !has(meta.body.services, 'web', 'client') && 'Services → add web, kind App.',
  !has(meta.body.services, 'api', 'server') && 'Services → add api, kind Backend.',
].filter((s): s is string => !!s);
if (missing.length) {
  console.error(`\nA token can't change settings. Sign in as an admin and make these first, then run the seed again:\n${missing.map((s) => `  - ${s}`).join('\n')}`);
  process.exit(1);
}
console.log('  environment dev, dimension company, services web and api: there');

await make('company acme', '/dimensions/company', { key: 'acme', name: 'Acme Corp' }, '/dimensions/company/acme');
await make('company globex', '/dimensions/company', { key: 'globex', name: 'Globex' }, '/dimensions/company/globex');

const rule = (name: string, companies: string[], serveVariation: string) => ({
  ruleKey: crypto.randomUUID(), name, conditions: [{ field: 'company', op: 'in', values: companies }], serveVariation,
});
await make('flag new_checkout', '/flags', {
  key: 'new_checkout', name: 'New checkout', valueType: 'bool', kind: 'config',
  variations: [{ key: 'on', value: true }, { key: 'off', value: false }],
  delivery: { [ENV]: ['web', 'api'] },
  base: { enabled: true, defaultVariation: 'on', variationWhenOff: 'off', rules: [] },
}, '/flags/new_checkout');
await make('flag welcome_message', '/flags', {
  key: 'welcome_message', name: 'Welcome message', valueType: 'string', kind: 'config',
  variations: [{ key: 'everyone', value: 'Welcome!' }, { key: 'acme', value: 'Welcome back, Acme Corp.' }],
  delivery: { [ENV]: ['web'] },
  base: { enabled: true, defaultVariation: 'everyone', rules: [rule('Acme', ['acme'], 'acme')] },
}, '/flags/welcome_message');
await make('flag max_upload_mb', '/flags', {
  key: 'max_upload_mb', name: 'Largest upload', valueType: 'number', kind: 'config',
  variations: [{ key: 'standard', value: 100 }, { key: 'large', value: 1000 }],
  delivery: { [ENV]: ['api'] },
  base: { enabled: true, defaultVariation: 'standard', rules: [rule('Large uploads', ['acme'], 'large')] },
}, '/flags/max_upload_mb');

console.log(`
Done. Now make the two API keys, as an admin: API Keys → + New key. Each is shown once.

  Environment dev, service web → examples/react/.env.local
    VITE_FLAGS_URL=${base}
    VITE_FLAGS_KEY=<the web key>

  Environment dev, service api → examples/node/.env
    FLAGS_URL=${base}
    FLAGS_API_KEY=<the api key>
  and examples/flagd/.env (beside FF_SECRET)
    FLAGS_API_KEY=<the api key>
`);
