// What every platform's steps share: the server's settings, the two database roles, the admin account, single sign-on,
// Cloudflare, the checklist and the recipe link. Each platform (compose.ts, kubernetes.ts, aws.ts, google.ts, azure.ts)
// writes these in its own form.

import type { Choices, Where } from './choices.ts';
import { bash, file, lines, step, type Link, type Setting, type Step } from './plan.ts';

export const IMAGE = 'ghcr.io/dvir-daniel/companyflags:0.9';
export const cdnName = (c: Choices) => `cdn.${c.domain}`;
/** The host apps read CDN files from. */
export const filesHost = (c: Choices) => (c.cdnHost ? cdnName(c) : c.domain);

/** The integrations turned off, as FF_INTEGRATIONS_OFF takes them. */
export const offList = (c: Choices) => [...(c.mcp ? [] : ['mcp']), ...(c.webhooks ? [] : ['webhooks'])].join(',');

/** A placeholder the generated files and commands use where the reader's own value goes. */
export const CLOUDFLARE_RANGES = '$CLOUDFLARE_RANGES';

type Front = {
  /** FF_TRUSTED_PROXIES. */
  proxies: string;
  /** FF_CLIENT_IP_HEADER, when the proxy or load balancer sets one. */
  header?: string;
  /** Several instances: migrations are their own step (FF_MIGRATE=off) and the pool is set. */
  several: boolean;
  caFile?: string;
  /** The purge plugin's settings. */
  purge?: Setting[];
};

/** The settings the server gets, in order: secrets last. */
export function serverSettings(c: Choices, f: Front): Setting[] {
  const out: Setting[] = [{ name: 'FF_PUBLIC_URL', value: `https://${c.domain}` }, { name: 'FF_TRUSTED_PROXIES', value: f.proxies }];
  if (f.header) out.push({ name: 'FF_CLIENT_IP_HEADER', value: f.header });
  if (f.several) out.push({ name: 'FF_MIGRATE', value: 'off' }, { name: 'FF_DB_POOL', value: '10' });
  if (f.caFile) out.push({ name: 'FF_DATABASE_CA_FILE', value: f.caFile });
  out.push(...(f.purge ?? []));
  if (c.metrics) out.push({ name: 'FF_METRICS', value: 'on' });
  if (offList(c)) out.push({ name: 'FF_INTEGRATIONS_OFF', value: offList(c) });
  out.push({ name: 'FF_SECRET', value: 'openssl rand -base64 32', secret: true }, { name: 'DATABASE_URL', value: 'postgres://…', secret: true });
  if (c.metrics) out.push({ name: 'FF_METRICS_TOKEN', value: 'openssl rand -hex 32', secret: true });
  return out;
}

export const plain = (s: Setting[]) => s.filter((x) => !x.secret && !x.compose);

/** Cloudflare in front of the console's own host (no CDN host): its ranges are proxies, and it names the client. */
export const cloudflareWholeHost = (c: Choices) => c.cdn === 'cloudflare' && !c.cdnHost;

/** The command that reads Cloudflare's published ranges into $CLOUDFLARE_RANGES, comma-separated. */
export const CLOUDFLARE_RANGES_COMMAND = `CLOUDFLARE_RANGES=$( { curl -fsS https://www.cloudflare.com/ips-v4; echo; curl -fsS https://www.cloudflare.com/ips-v6; } | grep . | paste -sd, - )`;

/** The SQL that makes the database, btree_gist and the two roles, as the master user, with the passwords from psql
 *  variables (`-v owner_pw=… -v app_pw=…`), so no password is written in the file. */
export function rolesSql(o: { createDatabase: boolean; createOwner: boolean }) {
  return lines(
    o.createOwner && `CREATE ROLE flags_owner LOGIN PASSWORD :'owner_pw';   -- migrations`,
    o.createOwner && 'GRANT flags_owner TO CURRENT_USER;                    -- so you may give it the database and its defaults',
    `CREATE ROLE flags_app LOGIN PASSWORD :'app_pw';       -- the servers, with FF_MIGRATE=off`,
    o.createDatabase && 'CREATE DATABASE flags OWNER flags_owner;',
    o.createDatabase && '\\c flags',
    'CREATE EXTENSION IF NOT EXISTS btree_gist;',
    'GRANT CONNECT ON DATABASE flags TO flags_app;',
    'GRANT USAGE ON SCHEMA public TO flags_app;',
    'ALTER DEFAULT PRIVILEGES FOR ROLE flags_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO flags_app;',
    'ALTER DEFAULT PRIVILEGES FOR ROLE flags_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO flags_app;',
  );
}

export const PASSWORDS = 'OWNER_PW=$(openssl rand -hex 24)   # flags_owner: the migrate step only\nAPP_PW=$(openssl rand -hex 24)     # flags_app: the servers';

export const SAME_SHELL = 'Run the steps in one shell: later steps use the passwords this one keeps in `$OWNER_PW` and `$APP_PW`. Nothing writes them to a file.';

export const ROLES_NOTE = 'The migrate step connects as `flags_owner`; the servers as `flags_app`, which only reads and writes rows ([Database → Two roles](/reference/configuration#two-roles-one-that-migrates-one-that-serves)).';

/** Make the admin account with the setup link in the log. */
export function adminStep(c: Choices, where: string, command: string): Step {
  return step('Make the admin account', {
    prose: [
      `While nobody has an account, the server prints a setup link at every start. Find it in ${where}, open it, and make the admin account at once. Until then, whoever has the link can make it.`,
    ],
    code: [bash(command), file('text', 'The line to look for', `[companyflags] nobody has an account yet: make the admin account at https://${c.domain}/api/setup/<secret>`)],
    after: ['Then invite everyone else from **Settings → People**. See [Sign-In → The first account](/operate/sign-in#the-first-account).'],
  });
}

export function ssoStep(c: Choices): Step {
  const base = `https://${c.domain}`;
  return step('Add single sign-on', {
    prose: [
      'Single sign-on is set up in the console, not on the server. Once you are signed in as the admin, open **Settings → Single Sign-On** and add a connection. The drawer shows what to enter on the identity provider’s side.',
      'For an identity provider on a private network, add its origin to `FF_TRUSTED_ORIGINS` as you set the other settings.',
    ],
    code: [file('text', 'On the identity provider’s side', lines(
      `OIDC redirect URI   ${base}/api/auth/sso/callback/<connection id>`,
      `SAML ACS URL        ${base}/api/auth/sso/saml2/sp/acs/<connection id>`,
      `SAML entity ID      ${base}/api/auth/sso/saml2/sp/metadata?providerId=<connection id>`,
    ))],
    after: ['Then require it, with a break-glass admin who keeps a password: [Single Sign-On](/operate/single-sign-on#require-single-sign-on).'],
  });
}

/** Cloudflare as the CDN: DNS, the cache rule, the country header and the purge. `origin` says where Cloudflare
 *  sends requests: the server's machine or the platform's load balancer. */
export function cloudflareStep(c: Choices, origin: string): Step {
  const host = filesHost(c);
  const onHost = c.cdnHost ? `http.host eq "${host}" and ` : '';
  return step('Put Cloudflare in front', {
    prose: [
      c.cdnHost
        ? `In your Cloudflare zone, add \`${host}\` as a proxied record (orange cloud) to ${origin}. Keep \`${c.domain}\` DNS only (grey cloud): OFREP and its streams go straight to the server. Set SSL/TLS to **Full (strict)**.`
        : `In your Cloudflare zone, make \`${c.domain}\` a proxied record (orange cloud) to ${origin}, and set SSL/TLS to **Full (strict)**. Let only Cloudflare’s ranges reach ${origin}: the server believes the \`CF-Connecting-IP\` header from them.`,
      'Then add these rules. The cache rule caches only the CDN files, by the headers the server sends; never use “Cache Everything” on the host.',
    ],
    list: [
      '**Caching → Cache Rules**: when the expression below matches, **Eligible for cache**; Edge TTL **Use cache-control header if present, bypass cache if not**; Browser TTL **Respect origin TTL**.',
      '**Rules → Transform Rules → Modify Response Header**, on the same expression: set the dynamic header `CF-IPCountry` to `ip.src.country`, so rules on `geo.country` work in apps.',
      ...(c.cdnHost ? ['**Security → WAF → Custom rules**: **Block** when the second expression matches, so the CDN host serves CDN files only.'] : []),
    ],
    code: [
      file('text', 'Cache rule and country header', `${onHost}starts_with(http.request.uri.path, "/cdn/v1/flags/")`),
      ...(c.cdnHost ? [file('text', 'WAF block rule', `http.host eq "${host}" and not starts_with(http.request.uri.path, "/cdn/v1/flags/")`)] : []),
    ],
    after: [
      '**Purge on publish:** once you are signed in, open **Settings → CDN** and enter the zone’s ID and an API token with only **Zone → Cache Purge → Purge** on this zone. Your plan must offer purge by cache tag. The token stays on the server, sealed with a key from `FF_SECRET`.',
      `Apps read CDN files from \`https://${host}\`, at the path their app link gives. See [Docker Compose → A CDN with Cloudflare](/deploy/docker-compose#a-cdn-with-cloudflare).`,
    ],
  });
}

/** Check the CDN answers from its cache. */
export function cdnCheck(c: Choices, hit: string) {
  return bash(lines(
    `curl -sI https://${filesHost(c)}/cdn/v1/flags/prod/web | grep -iE 'cache-control|etag|age|cache-status|x-cache|cf-ipcountry'`,
    `# run it twice: the second answer comes from the cache (${hit})`,
  ), 'Check the CDN');
}

const RECIPE: Record<Where, Link> = {
  compose: { label: 'Docker Compose', url: '/deploy/docker-compose' },
  kubernetes: { label: 'Kubernetes', url: '/deploy/kubernetes' },
  aws: { label: 'AWS', url: '/deploy/aws' },
  google: { label: 'Google Cloud', url: '/deploy/google-cloud' },
  azure: { label: 'Azure', url: '/deploy/azure' },
};
export const recipe = (c: Choices): Link => RECIPE[c.where];
export const RECIPES = Object.values(RECIPE);

/** The checks to go through before people and apps depend on it, for this setup. */
export function checklistStep(c: Choices, extra: string[] = []): Step {
  const several = c.where !== 'compose';
  return step('Check before go-live', {
    prose: ['Go through these before people and apps depend on it. The [Production Checklist](/operate/production) explains each one.'],
    list: [
      '`FF_SECRET` is stored with your backups, and pinned to one version: [Secrets](/reference/configuration).',
      'The admin account is made, and few people can read the logs: [Sign-In](/operate/sign-in#the-first-account).',
      '`https://' + c.domain + '` answers with HSTS, and `FF_TRUSTED_PROXIES` matches what is in front: [Proxies and HTTPS](/reference/configuration).',
      c.metrics
        ? '`/metrics` asks for `FF_METRICS_TOKEN`, and `/readyz` is reachable from your network only: [Monitoring → Metrics](/operate/monitoring#metrics).'
        : '`/readyz` is reachable from your network only: [Proxies and HTTPS → What to expose](/reference/configuration#what-to-expose).',
      ...(c.signIn === 'sso' ? ['Single sign-on is required, with a break-glass admin: [Single Sign-On](/operate/single-sign-on#require-single-sign-on).'] : []),
      ...(c.cdn !== 'none'
        ? [c.cdn === 'front-door'
          ? 'The CDN caches only `/cdn/v1/flags/*`. Front Door has no purge: a change reaches apps within about a minute: [CDN](/integrations/cdn-files).'
          : 'The CDN caches only `/cdn/v1/flags/*`, and a publish shows its purge went through in **Settings → CDN** or the log: [CDN](/integrations/cdn-files).']
        : []),
      'Alerts on `failing`, `warnings` and `lagSeconds` from `/readyz`: [Monitoring → Alerts](/operate/monitoring#alerts).',
      'Backups run, and a restore was tested: [Backups](/operate/backups#testing-a-restore).',
      ...(several ? ['The connection budget fits, with old and new instances side by side during a deploy: [Database → Connection pool and budget](/reference/configuration#connection-pool-and-budget).'] : []),
      ...extra,
      'The image is pinned to `0.9`, and you have an upgrade plan: [Upgrading](/operate/upgrading).',
    ],
  });
}

export function recipeStep(c: Choices): Step {
  const r = recipe(c);
  return step('Read the full recipe', {
    prose: [`These steps are trimmed to your answers. The [${r.label} recipe](${r.url}) has every step with the reasons, the upgrades and the pitfalls.`],
  });
}
