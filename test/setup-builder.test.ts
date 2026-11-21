// The docs' setup builder (docs/deploy/builder.mdx, docs/lib/setup): every set of answers gives complete steps, every
// setting it gives the server is one the server reads, its Compose files and manifests parse, and Kubernetes gets the
// probes and FF_MIGRATE=off. The generator is plain TypeScript, imported here as the page imports it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseAllDocuments } from 'yaml';
import { DEFAULTS, everyChoice, fromQuery, generate, normalize, RECIPES, toQuery, type Plan } from '../docs/lib/setup/index.ts';
import { inline } from '../docs/lib/setup/inline.ts';

const root = new URL('..', import.meta.url).pathname;
const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
});
/** The server's source, to check a setting's name against what it reads. */
const server = files(join(root, 'server')).map((f) => readFileSync(f, 'utf8')).join('\n');
const reads = (name: string) => new RegExp(`\\b${name}\\b`).test(server);
/** What Docker Compose reads, never the server: the repository's own Compose file uses each. */
const repoCompose = readFileSync(join(root, 'docker-compose.yml'), 'utf8');

const all = everyChoice();
const plans: Plan[] = all.map((c) => generate(c));
const texts = (p: Plan) => p.steps.flatMap((s) => [s.title, ...s.prose, ...(s.list ?? []), ...(s.after ?? []), ...s.code.flatMap((k) => [k.filename, k.code])]);
const label = (p: Plan) => toQuery(p.choices) || '(defaults)';

test('there are combinations for every platform, and each is valid as it is', () => {
  assert.ok(all.length > 100, `${all.length} combinations`);
  for (const where of ['compose', 'kubernetes', 'aws', 'google', 'azure']) assert.ok(all.some((c) => c.where === where), where);
  for (const c of all) assert.deepEqual(normalize(c), c, 'every combination is already normal');
});

test('every combination gives numbered steps with prose, and no empty code, no undefined and no literal secret', () => {
  for (const p of plans) {
    const at = label(p);
    assert.ok(p.steps.length >= 6, `${at}: ${p.steps.length} steps`);
    assert.ok(p.summary.length > 20, at);
    const ids = p.steps.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, `${at}: step ids are unique: ${ids.join(', ')}`);
    for (const s of p.steps) {
      assert.ok(s.title.trim() && s.id, `${at}: a step has a title`);
      assert.ok(s.prose.length > 0 && s.prose.every((x) => x.trim()), `${at} / ${s.title}: prose`);
      for (const k of s.code) {
        assert.ok(k.code.trim(), `${at} / ${s.title}: ${k.filename} is empty`);
        assert.ok(k.filename.trim() && k.lang, `${at} / ${s.title}: a code block has a file name and a language`);
        assert.doesNotMatch(k.code, /\n\s*\n\s*\n/, `${at} / ${k.filename}: no run of empty lines`);
      }
    }
    for (const t of texts(p)) {
      assert.doesNotMatch(t, /undefined|(?<!\/dev\/)\bnull\b|\bNaN\b|\[object Object\]|(?<!--[a-z-]+ )\bfalse\b/, `${at}: “${t.slice(0, 200)}”`);
    }
    // a secret is made by a command in the steps, never written out
    const code = p.steps.flatMap((s) => s.code.map((k) => k.code)).join('\n');
    assert.match(code, /openssl rand -base64 32/, `${at}: FF_SECRET is made`);
    assert.doesNotMatch(code, /FF_SECRET=(?!"?\$\(openssl rand)(?!secretref:)(?!flags-auth-secret)[A-Za-z0-9+/]{8,}/, `${at}: no literal FF_SECRET`);
    assert.doesNotMatch(code, /[A-Za-z0-9+/]{43}=/, `${at}: no base64 secret`);
    for (const s of p.settings.filter((x) => x.secret)) {
      assert.ok(code.includes(s.name), `${at}: the secret ${s.name} is given to the server in the steps`);
    }
    if (p.choices.metrics) assert.match(code, /openssl rand -hex 32/, `${at}: the metrics token is made`);
  }
});

test('a missing secret makes no step: every password a step uses was made by a step before it', () => {
  for (const p of plans) {
    const made = new Set<string>();
    for (const s of p.steps) {
      const code = s.code.map((k) => k.code).join('\n');
      for (const m of code.matchAll(/\b([A-Z_]+_PW)=\$\(openssl rand/g)) made.add(m[1]);
      for (const m of code.matchAll(/\$\{?([A-Z_]+_PW)\b/g)) assert.ok(made.has(m[1]), `${label(p)} / ${s.title}: $${m[1]} is used before a step makes it`);
    }
  }
});

test('every setting the generator gives is one the server reads, or Compose', () => {
  const names = new Set<string>();
  for (const p of plans) {
    for (const s of p.settings) {
      names.add(s.name);
      if (s.compose) assert.match(repoCompose, new RegExp(`\\$\\{${s.name}\\b`), `${s.name} is read by Compose`);
      else assert.ok(reads(s.name), `${label(p)}: the server doesn't read ${s.name}`);
    }
    // and every FF_ name anywhere in the steps, prose included
    for (const t of texts(p)) for (const m of t.matchAll(/\bFF_[A-Z0-9_]+\b/g)) assert.ok(reads(m[0]), `${label(p)}: ${m[0]} in “${t.slice(0, 120)}”`);
    // Compose's own variables in the generated Compose file
    for (const k of p.steps.flatMap((s) => s.code).filter((k) => k.filename === 'docker-compose.yml')) {
      for (const m of k.code.matchAll(/\$\{([A-Z_]+)/g)) assert.match(repoCompose, new RegExp(`\\$\\{${m[1]}\\b`), `${m[1]} is a Compose variable`);
    }
  }
  for (const name of ['FF_SECRET', 'FF_PUBLIC_URL', 'FF_TRUSTED_PROXIES', 'DATABASE_URL', 'FF_MIGRATE', 'FF_METRICS', 'FF_METRICS_TOKEN', 'FF_INTEGRATIONS_OFF',
    'FF_CLOUDFRONT_DISTRIBUTION_ID', 'FF_CLOUD_CDN_PROJECT', 'FF_CLOUD_CDN_URL_MAP', 'FF_CLIENT_IP_HEADER', 'FF_DATABASE_CA_FILE']) {
    assert.ok(names.has(name), `some setup sets ${name}`);
  }
});

test('the integrations turned off are the ones the server can turn off', () => {
  for (const p of plans) {
    const off = p.settings.find((s) => s.name === 'FF_INTEGRATIONS_OFF');
    const want = [...(p.choices.mcp ? [] : ['mcp']), ...(p.choices.webhooks ? [] : ['webhooks'])].join(',');
    assert.equal(off?.value ?? '', want, label(p));
    assert.equal(p.settings.some((s) => s.name === 'FF_METRICS' && s.value === 'on'), p.choices.metrics, label(p));
  }
});

test('every YAML file parses: the Compose files, the manifests and the cloud files', () => {
  let compose = 0;
  for (const p of plans) {
    for (const k of p.steps.flatMap((s) => s.code).filter((k) => k.lang === 'yaml')) {
      const docs = parseAllDocuments(k.code);
      assert.ok(Array.isArray(docs), `${label(p)} / ${k.filename}`);
      for (const d of docs) assert.deepEqual(d.errors, [], `${label(p)} / ${k.filename}: ${d.errors.map((e) => e.message).join('; ')}`);
      if (k.filename !== 'docker-compose.yml') continue;
      compose++;
      const file = docs[0].toJS();
      const services = Object.keys(file.services);
      assert.ok(services.includes('companyflags') && services.includes('caddy'), `${label(p)}: ${services}`);
      assert.equal(services.includes('postgres'), p.choices.database === 'bundled', label(p));
      assert.equal(file.networks.default.ipam.config[0].subnet, '172.30.0.0/24');
      for (const s of services) for (const dep of [file.services[s].depends_on ?? []].flatMap((d) => (Array.isArray(d) ? d : Object.keys(d)))) {
        assert.ok(services.includes(dep), `${label(p)}: ${s} depends on ${dep}`);
      }
      for (const v of Object.keys(file.volumes)) assert.ok(JSON.stringify(file.services).includes(`${v}:/`), `${label(p)}: volume ${v} is used`);
    }
    for (const k of p.steps.flatMap((s) => s.code).filter((k) => k.lang === 'json')) {
      assert.doesNotThrow(() => JSON.parse(k.code), `${label(p)} / ${k.filename}`);
    }
  }
  assert.ok(compose > 0);
});

test('Kubernetes: the servers have the probes and FF_MIGRATE=off, and the migrate Job migrates', () => {
  for (const p of plans.filter((x) => x.choices.where === 'kubernetes')) {
    const code = p.steps.flatMap((s) => s.code);
    const manifests = code.filter((k) => k.lang === 'yaml').flatMap((k) => parseAllDocuments(k.code)).map((d) => d.toJS());
    const deployment = manifests.find((m) => m?.kind === 'Deployment');
    assert.ok(deployment, label(p));
    const container = deployment.spec.template.spec.containers[0];
    assert.equal(container.startupProbe.httpGet.path, '/readyz', label(p));
    assert.equal(container.livenessProbe.httpGet.path, '/healthz', label(p));
    assert.equal(container.readinessProbe.httpGet.path, '/healthz', label(p));
    const migrate = container.env.find((e: { name: string }) => e.name === 'FF_MIGRATE');
    assert.equal(migrate?.value, 'off', `${label(p)}: FF_MIGRATE is the string "off"`);
    assert.ok(deployment.spec.replicas >= 2);
    const job = manifests.find((m) => m?.kind === 'Job');
    assert.deepEqual(job.spec.template.spec.containers[0].command, ['companyflags', 'migrate'], label(p));
    assert.ok(manifests.some((m) => m?.kind === 'Service') && manifests.some((m) => m?.kind === 'HTTPRoute'), label(p));
    // the Job comes before the Deployment
    const order = p.steps.map((s) => s.code.map((k) => k.code).join('\n'));
    assert.ok(order.findIndex((t) => t.includes('kind: Job')) < order.findIndex((t) => t.includes('kind: Deployment')), label(p));
  }
});

test('every cloud runs its servers with FF_MIGRATE=off and a migrate step first; one server migrates as it starts', () => {
  for (const p of plans) {
    const off = p.settings.some((s) => s.name === 'FF_MIGRATE' && s.value === 'off');
    assert.equal(off, p.choices.where !== 'compose', label(p));
    const code = p.steps.flatMap((s) => s.code.map((k) => k.code)).join('\n');
    assert.match(code, p.choices.where === 'compose' ? /companyflags migrate --check/ : /companyflags(["',\s]+|\s--args[= ])migrate/, label(p));
  }
});

test('the CDN follows the platform and the CDN host, and the purge is set where one exists', () => {
  for (const p of plans) {
    const { where, cdn, cdnHost } = p.choices;
    if (cdn === 'cloudfront') assert.equal(where, 'aws');
    if (cdn === 'cloud-cdn') assert.equal(where, 'google');
    if (cdn === 'front-door') { assert.equal(where, 'azure'); assert.ok(cdnHost); }
    if (cdn === 'none') assert.ok(!cdnHost);
    const has = (n: string) => p.settings.some((s) => s.name === n);
    assert.equal(has('FF_CLOUDFRONT_DISTRIBUTION_ID'), cdn === 'cloudfront', label(p));
    assert.equal(has('FF_CLOUD_CDN_PROJECT') && has('FF_CLOUD_CDN_URL_MAP'), cdn === 'cloud-cdn', label(p));
    const all = texts(p).join('\n');
    if (cdn === 'cloudflare') assert.match(all, /Settings → CDN/, label(p));
    if (cdn === 'front-door') assert.match(all, /No purge on publish/, label(p));
    if (cdnHost) assert.match(all, /cdn\.flags\.example\.com/, label(p));
  }
});

test('the answers survive a link, and a hand-edited link still opens a valid setup', () => {
  for (const c of all) assert.deepEqual(fromQuery(`?${toQuery(c)}`), c, toQuery(c));
  assert.equal(toQuery(DEFAULTS), '');
  assert.deepEqual(fromQuery('where=azure&cdn=cloudfront&db=bundled&domain=Not%20a%20host'), normalize({ where: 'azure' }));
  assert.equal(fromQuery('domain=flags.acme.example').domain, 'flags.acme.example');
  const custom = generate(fromQuery('where=kubernetes&domain=flags.acme.example'));
  assert.ok(texts(custom).some((t) => t.includes('https://flags.acme.example')));
  assert.ok(!texts(custom).some((t) => t.includes('flags.example.com')));
});

test('the prose’s links go to recipe pages or docs pages, and each platform links its recipe', () => {
  const docs = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? docs(p) : /\.mdx?$/.test(n) ? [p] : [];
  });
  const known = new Set(docs(join(root, 'docs/content/docs')).map((f) => f.slice(join(root, 'docs/content/docs').length).replace(/\.mdx?$/, '')));
  const recipes = new Set(RECIPES.map((r) => r.url));
  for (const p of plans) {
    assert.ok(recipes.has(p.recipe.url));
    const links = p.steps.flatMap((s) => [...s.prose, ...(s.list ?? []), ...(s.after ?? [])]).flatMap(inline).filter((x) => x.kind === 'link');
    assert.ok(links.some((l) => l.kind === 'link' && l.url === p.recipe.url), `${label(p)} links its recipe`);
    for (const l of links) {
      if (l.kind !== 'link') continue;
      const path = l.url.split('#')[0];
      assert.ok(recipes.has(path) || known.has(path), `${label(p)}: ${l.url} isn't a page`);
    }
  }
});

test('the inline marks: code, bold and links, and plain text around them', () => {
  assert.deepEqual(inline('Set `FF_SECRET` in **Settings**, see [Secrets](/self-hosting/secrets).'), [
    { kind: 'text', text: 'Set ' }, { kind: 'code', text: 'FF_SECRET' }, { kind: 'text', text: ' in ' }, { kind: 'bold', text: 'Settings' },
    { kind: 'text', text: ', see ' }, { kind: 'link', text: 'Secrets', url: '/self-hosting/secrets' }, { kind: 'text', text: '.' },
  ]);
  assert.deepEqual(inline('plain'), [{ kind: 'text', text: 'plain' }]);
});

test('nothing the builder writes names a business word', () => {
  const WORD = /\b(customers?|compan(y|ies)|brands?|tenants?)\b/i;
  for (const p of plans) for (const t of texts(p)) assert.doesNotMatch(t.replace(/companyflags/gi, ''), WORD, `${label(p)}: “${t.slice(0, 120)}”`);
});
