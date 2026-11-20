// Sets up a new CompanyFlags server for the examples, through its console API (/api), and prints the keys.
//
//   FLAGS_URL=http://localhost:8787 FLAGS_TOKEN=cfp_… node examples/seed.ts
//
// FLAGS_TOKEN is an admin's access token: in the console, your name at the foot of the sidebar → Access tokens →
// + New token, with the role Admin.
// It makes, unless they are there already:
//   - the environment dev (Development)
//   - the dimension company, with acme (Acme Corp) and globex (Globex)
//   - the services web (an app) and api (a backend)
//   - the flags new_checkout (on/off), welcome_message (text) and max_upload_mb (a number)
//   - an API key for web and one for api, in dev
// Run it again and it makes new keys only. Node 22.18 or later runs it as is.

const base = (process.env.FLAGS_URL ?? 'http://localhost:8787').replace(/\/+$/, '');
const token = process.env.FLAGS_TOKEN;
if (!token) {
  console.error('Set FLAGS_TOKEN to an admin access token (cfp_…): console → Access tokens → + New token.');
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
const rule = (name: string, companies: string[], serveVariation: string) => ({
  ruleKey: crypto.randomUUID(), name, conditions: [{ field: 'company', op: 'in', values: companies }], serveVariation,
});

console.log(`Setting up ${base}`);
await make('environment dev', '/environments', { key: ENV, name: 'Development' });

const dims = await call('GET', '/dimensions');
if (!dims.body.some((d: { key: string }) => d.key === 'company')) {
  const r = await call('PUT', '/dimensions', { dimensions: [...dims.body, { key: 'company', singular: 'company', plural: 'companies' }] });
  if (r.status >= 300) throw new Error(`dimension company: ${r.status} ${JSON.stringify(r.body)}`);
  console.log('  dimension company: made');
} else console.log('  dimension company: there already');
await make('company acme', '/dimensions/company', { key: 'acme', name: 'Acme Corp' });
await make('company globex', '/dimensions/company', { key: 'globex', name: 'Globex' });

await make('service web (app)', '/services', { key: 'web', kind: 'client' });
await make('service api (backend)', '/services', { key: 'api', kind: 'server' });

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

const key = async (project: string) => {
  const r = await call('POST', '/api-keys', { environment: ENV, project, scope: 'all', label: `examples: ${project}` });
  if (r.status >= 300) throw new Error(`key for ${project}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.key as string;
};
const web = await key('web');
const api = await key('api');

console.log(`
Done. Each key is shown once.

examples/react/.env.local
  VITE_FLAGS_URL=${base}
  VITE_FLAGS_KEY=${web}

examples/node/.env
  FLAGS_URL=${base}
  FLAGS_API_KEY=${api}

examples/flagd/.env (beside BETTER_AUTH_SECRET)
  FLAGS_API_KEY=${api}
`);
