// One server with Docker Compose (self-hosting/docker.md and proxies.md): .env, the Compose file with Caddy for HTTPS,
// and Postgres in Compose or your own. One server migrates as it starts.

import type { Choices } from './choices.ts';
import {
  adminStep, cdnCheck, checklistStep, CLOUDFLARE_RANGES, CLOUDFLARE_RANGES_COMMAND, cdnName, cloudflareStep, cloudflareWholeHost,
  IMAGE, plain, recipe, recipeStep, serverSettings, ssoStep,
} from './common.ts';
import { bash, file, lines, step, type Plan, type Setting, type Step } from './plan.ts';

const SUBNET = '172.30.0.0/24';
const OWN_URL = 'postgres://flags:$FLAGS_PW@db.example.com:5432/flags?sslmode=verify-full';

export function composePlan(c: Choices): Plan {
  const bundled = c.database === 'bundled';
  const wholeHost = cloudflareWholeHost(c);
  const settings: Setting[] = [
    ...serverSettings(c, {
      proxies: wholeHost ? `${SUBNET},${CLOUDFLARE_RANGES}` : SUBNET,
      header: wholeHost ? 'cf-connecting-ip' : undefined,
      several: false,
    }),
    ...(bundled ? [{ name: 'POSTGRES_PASSWORD', value: 'openssl rand -hex 24', secret: true, compose: true }] : []),
  ];

  const steps: Step[] = [];
  if (!bundled) {
    steps.push(step('Make the database', {
      prose: [
        'On your Postgres server (15 or later), make a role and a database, and the `btree_gist` extension the first start needs. Run it as a user that may create roles, from this machine.',
        'Run the steps in one shell: the next one writes the password this one keeps in `$FLAGS_PW` into `.env`.',
      ],
      code: [bash(lines(
        'FLAGS_PW=$(openssl rand -hex 24)',
        'psql "postgres://postgres@db.example.com:5432/postgres?sslmode=verify-full" -v pw="$FLAGS_PW" <<\'SQL\'',
        "CREATE ROLE flags LOGIN PASSWORD :'pw';",
        'CREATE DATABASE flags OWNER flags;',
        '\\c flags',
        'CREATE EXTENSION IF NOT EXISTS btree_gist;',
        'SQL',
      ))],
      after: ['A managed server whose certificate comes from its cloud’s own authority (Amazon RDS) also needs `FF_DATABASE_CA_FILE`: see [Database → TLS](/reference/configuration#tls-and-certificate-authorities).'],
    }));
  }

  const env = plain(settings).filter((s) => s.name !== 'FF_TRUSTED_PROXIES');
  steps.push(step('Write .env', {
    prose: [
      'Make a folder for CompanyFlags, such as `/srv/companyflags`, and write `.env` in it. The commands make each secret; none is written here. Every line in `.env` reaches the server.',
    ],
    code: [bash(lines(
      'mkdir -p /srv/companyflags && cd /srv/companyflags',
      'umask 077     # .env is readable by you only',
      'echo "FF_SECRET=$(openssl rand -base64 32)" > .env',
      bundled ? 'echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" >> .env' : `echo "DATABASE_URL=${OWN_URL}" >> .env`,
      ...env.map((s) => `echo "${s.name}=${s.value}" >> .env`),
      wholeHost && CLOUDFLARE_RANGES_COMMAND,
      `echo "FF_TRUSTED_PROXIES=${wholeHost ? `${SUBNET},${CLOUDFLARE_RANGES}` : SUBNET}" >> .env${wholeHost ? '   # Caddy, then Cloudflare' : '   # Caddy, on the subnet the Compose file pins'}`,
      c.metrics && 'echo "FF_METRICS_TOKEN=$(openssl rand -hex 32)" >> .env',
      'chmod 600 .env',
    ))],
    after: ['Keep a copy of `.env` with your backups: a backup restored with another `FF_SECRET` loses sessions and the secrets kept for other systems ([Secrets](/reference/configuration)).'],
  }));

  const compose = lines(
    `# docker-compose.yml: CompanyFlags${bundled ? ' with Postgres 18' : ''}, and Caddy for HTTPS. Its settings are in .env beside it.`,
    'services:',
    '  companyflags:',
    `    image: ${IMAGE.replace(':0.9', ':${COMPANYFLAGS_VERSION:-0.9}')}`,
    '    ports:',
    '      - "127.0.0.1:8787:8787"   # this machine only: people come in through Caddy',
    '    env_file: .env',
    bundled && '    environment:',
    bundled && '      DATABASE_URL: postgres://companyflags:${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in .env}@postgres:5432/companyflags',
    bundled && '    depends_on:',
    bundled && '      postgres:',
    bundled && '        condition: service_healthy',
    '    stop_grace_period: 30s',
    '    restart: unless-stopped',
    '',
    bundled && lines(
      '  postgres:',
      '    image: postgres:18-alpine',
      '    environment:',
      '      POSTGRES_USER: companyflags',
      '      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in .env}',
      '      POSTGRES_DB: companyflags',
      '    volumes:',
      '      - postgres:/var/lib/postgresql',
      '    healthcheck:',
      '      test: ["CMD-SHELL", "pg_isready -U companyflags -d companyflags"]',
      '      interval: 5s',
      '      timeout: 5s',
      '      retries: 10',
      '    restart: unless-stopped',
      '',
    ),
    '  caddy:',
    '    image: caddy:2',
    '    ports: ["80:80", "443:443", "443:443/udp"]',
    '    volumes:',
    '      - ./Caddyfile:/etc/caddy/Caddyfile:ro',
    '      - caddy:/data',
    '    depends_on: [companyflags]',
    '    restart: unless-stopped',
    '',
    'networks:',
    '  default:',
    '    ipam:',
    '      config:',
    `        - subnet: ${SUBNET}   # FF_TRUSTED_PROXIES trusts this subnet`,
    '',
    'volumes:',
    bundled && '  postgres:',
    '  caddy:',
  );
  steps.push(step('Write the Compose file', {
    prose: [
      `Beside \`.env\`, write \`docker-compose.yml\`. It runs the server${bundled ? ', Postgres 18 in a volume' : ''} and Caddy, which ends TLS. The server’s own port listens on this machine only.`,
    ],
    code: [file('yaml', 'docker-compose.yml', compose)],
  }));

  const hosts = c.cdnHost ? `${c.domain}, ${cdnName(c)}` : c.domain;
  steps.push(step('Put HTTPS in front', {
    prose: [
      `Point ${c.cdnHost ? `\`${c.domain}\` and \`${cdnName(c)}\`` : `\`${c.domain}\``} at this machine, and open ports 80 and 443. Caddy gets a certificate by itself, adds HSTS (the server sends none), passes the streams through unbuffered, and lets 4 MB imports through.`,
    ],
    code: [file('text', 'Caddyfile', lines(
      `${hosts} {`,
      '\theader Strict-Transport-Security "max-age=31536000; includeSubDomains"',
      '\trequest_body {',
      '\t\tmax_size 4MB',
      '\t}',
      '\treverse_proxy companyflags:8787 {',
      '\t\tflush_interval -1',
      '\t}',
      '}',
    ))],
    after: ['For nginx instead, see [Docker Compose → HTTPS with Caddy or nginx](/deploy/docker-compose#https-with-caddy-or-nginx).'],
  }));

  steps.push(step('Start it and migrate', {
    prose: [
      'One server migrates the database as it starts: each numbered migration runs once, in order, and the schema only moves forward. `migrate --check` then confirms nothing is pending.',
    ],
    code: [bash(lines(
      'docker compose up -d',
      'docker compose ps                                                # companyflags: healthy',
      'docker compose exec companyflags companyflags migrate --check   # exits with 0: nothing pending',
      `curl -fsS https://${c.domain}/healthz`,
    ))],
    after: ['Before each upgrade, back up first: [Upgrading → One server](/operate/upgrading#one-server).'],
  }));

  steps.push(adminStep(c, 'the server’s log', 'docker compose logs companyflags | grep /api/setup/'));
  if (c.signIn === 'sso') steps.push(ssoStep(c));
  if (c.cdn === 'cloudflare') {
    const s = cloudflareStep(c, 'this machine');
    s.code.push(cdnCheck(c, '`cf-cache-status: HIT`'));
    s.after?.push('**Check this on your setup:** that Caddy renews its certificate for a proxied host through Cloudflare. If it can’t, give Caddy a Cloudflare Origin CA certificate with its `tls` directive.');
    steps.push(s);
  }
  steps.push(checklistStep(c, [bundled
    ? 'A nightly `pg_dump` in the Postgres container, copied off the machine with `.env`: [Backups → Postgres in Docker Compose](/operate/backups#postgres-in-docker-compose).'
    : 'Your Postgres server’s backups include the `flags` database: [Backups → Your own Postgres server](/operate/backups#your-own-postgres-server).']));
  steps.push(recipeStep(c));

  return {
    choices: c,
    summary: `One machine with Docker Compose: CompanyFlags, ${bundled ? 'Postgres 18 in Compose' : 'your own Postgres'} and Caddy, at https://${c.domain}.`,
    steps,
    settings,
    recipe: recipe(c),
  };
}
