// The setup builder's questions (deploy/builder.mdx): where it runs, the database, the address, sign-in, the CDN and
// the extras. Each answer narrows the next: the database follows the platform, and the CDN follows the platform and
// whether apps read CDN files from a host of their own. normalize() makes any input a valid set of answers, so a
// shared link with an old or a hand-edited query still opens a setup. Plain TypeScript: no React, no DOM.

export type Where = 'compose' | 'kubernetes' | 'aws' | 'google' | 'azure';
/** `bundled`: Postgres in Compose. `managed`: the cloud's own (RDS, Cloud SQL, Flexible Server). `own`: yours. */
export type Database = 'bundled' | 'managed' | 'own';
export type SignIn = 'passwords' | 'sso';
export type Cdn = 'none' | 'cloudflare' | 'cloudfront' | 'cloud-cdn' | 'front-door';

export type Choices = {
  where: Where;
  database: Database;
  /** The console's host name, e.g. flags.example.com. */
  domain: string;
  /** Apps read CDN files from cdn.<domain> rather than from the console's host. */
  cdnHost: boolean;
  signIn: SignIn;
  cdn: Cdn;
  metrics: boolean;
  /** The MCP server for AI agents, on by default. */
  mcp: boolean;
  /** Webhooks in and out, on by default. */
  webhooks: boolean;
};

export type Option<T> = { value: T; label: string; hint: string };

export const DEFAULT_DOMAIN = 'flags.example.com';

export const DEFAULTS: Choices = {
  where: 'compose', database: 'bundled', domain: DEFAULT_DOMAIN, cdnHost: false, signIn: 'passwords', cdn: 'none',
  metrics: false, mcp: true, webhooks: true,
};

export const WHERE: Option<Where>[] = [
  { value: 'compose', label: 'One server', hint: 'Docker Compose on one machine' },
  { value: 'kubernetes', label: 'Kubernetes', hint: 'Any cluster, two or more pods' },
  { value: 'aws', label: 'AWS', hint: 'ECS on Fargate' },
  { value: 'google', label: 'Google Cloud', hint: 'Cloud Run' },
  { value: 'azure', label: 'Azure', hint: 'Container Apps' },
];

const MANAGED: Record<Where, Option<Database>> = {
  compose: { value: 'managed', label: 'Managed Postgres', hint: '' },
  kubernetes: { value: 'managed', label: 'Managed Postgres', hint: 'RDS, Cloud SQL, Flexible Server or another' },
  aws: { value: 'managed', label: 'Amazon RDS', hint: 'RDS for PostgreSQL 18, Multi-AZ' },
  google: { value: 'managed', label: 'Cloud SQL', hint: 'Cloud SQL for PostgreSQL 18, over its socket' },
  azure: { value: 'managed', label: 'Flexible Server', hint: 'Azure Database for PostgreSQL 18' },
};

/** The databases a platform offers: Compose brings its own Postgres; a cloud uses its managed one. */
export function databaseOptions(where: Where): Option<Database>[] {
  if (where === 'compose') {
    return [
      { value: 'bundled', label: 'Postgres in Compose', hint: 'Postgres 18 beside the server, in a volume' },
      { value: 'own', label: 'Your own Postgres', hint: 'Postgres 15 or later you already run' },
    ];
  }
  if (where === 'kubernetes') {
    return [MANAGED.kubernetes, { value: 'own', label: 'Your own Postgres', hint: 'Postgres 15 or later you run' }];
  }
  return [MANAGED[where]];
}

/** Whether the platform can serve CDN files from the console's own host through a CDN. */
const SAME_HOST_CDN: Record<Where, Cdn[]> = {
  compose: ['cloudflare'], kubernetes: ['cloudflare'], aws: [], google: ['cloud-cdn'], azure: [],
};
const OWN_CDN: Partial<Record<Where, Cdn>> = { aws: 'cloudfront', google: 'cloud-cdn', azure: 'front-door' };

const CDN_LABEL: Record<Cdn, Omit<Option<Cdn>, 'value'>> = {
  none: { label: 'No CDN', hint: 'Apps read flags with OFREP, or read CDN files from the server' },
  cloudflare: { label: 'Cloudflare', hint: 'Purged on publish' },
  cloudfront: { label: 'CloudFront', hint: 'Purged on publish, with the task’s role' },
  'cloud-cdn': { label: 'Cloud CDN', hint: 'Purged on publish, with the service account' },
  'front-door': { label: 'Front Door', hint: 'No purge: a change reaches apps within a minute' },
};

/** The CDNs for a platform. Without a CDN host, only a CDN in front of the console's own host fits (or none). */
export function cdnOptions(where: Where, cdnHost: boolean): Option<Cdn>[] {
  const own = OWN_CDN[where];
  const values: Cdn[] = cdnHost ? [...(own ? [own] : []), 'cloudflare'] : ['none', ...SAME_HOST_CDN[where]];
  return values.map((value) => ({
    value, ...CDN_LABEL[value],
    hint: value === 'cloudflare' && !cdnHost ? 'In front of the whole host, purged on publish' : CDN_LABEL[value].hint,
  }));
}

const HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** A host name people can type: lowercase letters, digits and dashes, with a dot. */
export const validDomain = (domain: string) => HOST.test(domain);

/** Any input as a valid set of answers: an unknown value takes the default, and an answer the earlier ones rule out
 *  takes the first one they allow. */
export function normalize(input: Partial<Record<keyof Choices, unknown>>): Choices {
  const pick = <T>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? (value as T) : fallback);
  const where = pick(input.where, WHERE.map((o) => o.value), DEFAULTS.where);
  const dbs = databaseOptions(where).map((o) => o.value);
  const database = pick(input.database, dbs, dbs[0]);
  const raw = typeof input.domain === 'string' ? input.domain.trim().toLowerCase().replace(/\.$/, '') : '';
  const domain = validDomain(raw) ? raw : DEFAULT_DOMAIN;
  const cdnHost = input.cdnHost === true;
  const cdns = cdnOptions(where, cdnHost).map((o) => o.value);
  const cdn = pick(input.cdn, cdns, cdns[0]);
  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  return {
    where, database, domain, cdnHost, signIn: pick(input.signIn, ['passwords', 'sso'] as const, DEFAULTS.signIn), cdn,
    metrics: bool(input.metrics, DEFAULTS.metrics), mcp: bool(input.mcp, DEFAULTS.mcp), webhooks: bool(input.webhooks, DEFAULTS.webhooks),
  };
}

/** The answers as a query string, for a link to share. Defaults are left out, so the link stays short. */
export function toQuery(c: Choices): string {
  const q = new URLSearchParams();
  if (c.where !== DEFAULTS.where) q.set('where', c.where);
  if (c.database !== databaseOptions(c.where)[0].value) q.set('db', c.database);
  if (c.domain !== DEFAULT_DOMAIN) q.set('domain', c.domain);
  if (c.cdnHost) q.set('cdnhost', '1');
  if (c.cdn !== cdnOptions(c.where, c.cdnHost)[0].value) q.set('cdn', c.cdn);
  if (c.signIn !== DEFAULTS.signIn) q.set('signin', c.signIn);
  if (c.metrics) q.set('metrics', '1');
  const off = [...(c.mcp ? [] : ['mcp']), ...(c.webhooks ? [] : ['webhooks'])];
  if (off.length) q.set('off', off.join(','));
  return q.toString();
}

/** The answers in a query string (with or without its "?"). */
export function fromQuery(query: string): Choices {
  const q = new URLSearchParams(query.replace(/^\?/, ''));
  const off = (q.get('off') ?? '').split(',');
  return normalize({
    where: q.get('where'), database: q.get('db'), domain: q.get('domain') ?? undefined, cdnHost: q.get('cdnhost') === '1',
    cdn: q.get('cdn'), signIn: q.get('signin'), metrics: q.get('metrics') === '1', mcp: !off.includes('mcp'), webhooks: !off.includes('webhooks'),
  });
}

/** Every valid set of answers, with the default domain: what the tests go through. */
export function everyChoice(domain = DEFAULT_DOMAIN): Choices[] {
  const all: Choices[] = [];
  for (const { value: where } of WHERE) {
    for (const { value: database } of databaseOptions(where)) {
      for (const cdnHost of [false, true]) {
        for (const { value: cdn } of cdnOptions(where, cdnHost)) {
          for (const signIn of ['passwords', 'sso'] as const) {
            for (const metrics of [false, true]) {
              for (const [mcp, webhooks] of [[true, true], [false, true], [true, false], [false, false]]) {
                all.push({ where, database, domain, cdnHost, signIn, cdn, metrics, mcp, webhooks });
              }
            }
          }
        }
      }
    }
  }
  return all;
}
