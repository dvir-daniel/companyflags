// Kubernetes (self-hosting/upgrading.md, monitoring.md and the cloud guides' rules): two roles, the secrets, a migrate
// Job, then a Deployment with FF_MIGRATE=off and the health-check rule (/readyz for startup only, /healthz for liveness
// and readiness), a Service, and the Gateway API for HTTPS.

import type { Choices } from './choices.ts';
import {
  adminStep, cdnCheck, cdnName, checklistStep, CLOUDFLARE_RANGES, CLOUDFLARE_RANGES_COMMAND, cloudflareStep, cloudflareWholeHost, IMAGE,
  PASSWORDS, plain, recipe, recipeStep, ROLES_NOTE, rolesSql, SAME_SHELL, serverSettings, ssoStep,
} from './common.ts';
import { bash, file, lines, step, type Plan, type Step } from './plan.ts';

const NS = 'companyflags';
const POD_RANGE = '10.0.0.0/8';
const url = (role: string, pw: string) => `postgres://${role}:$${pw}@db.example.com:5432/flags?sslmode=verify-full`;

/** YAML for one env entry: always a quoted string, so `off` stays a word. */
const envEntry = (name: string, value: string, indent: string) => `${indent}- name: ${name}\n${indent}  value: ${JSON.stringify(value)}`;

export function kubernetesPlan(c: Choices): Plan {
  const wholeHost = cloudflareWholeHost(c);
  const settings = serverSettings(c, {
    proxies: wholeHost ? `${POD_RANGE},${CLOUDFLARE_RANGES}` : POD_RANGE,
    header: wholeHost ? 'cf-connecting-ip' : undefined,
    several: true,
  });
  const steps: Step[] = [];

  steps.push(step('Make the database and its roles', {
    prose: [
      c.database === 'managed'
        ? 'Make a managed Postgres 15 or later (18 is what the project tests on), with a standby and point-in-time recovery, reachable from the cluster. Then, as its master user, make the database, `btree_gist` and two roles.'
        : 'On your Postgres server (15 or later), reachable from the cluster, make the database, `btree_gist` and two roles, as a user that may create roles.',
      ROLES_NOTE,
      SAME_SHELL,
    ],
    code: [bash(lines(
      PASSWORDS,
      'psql "postgres://postgres@db.example.com:5432/postgres?sslmode=verify-full" \\',
      '  -v owner_pw="$OWNER_PW" -v app_pw="$APP_PW" <<\'SQL\'',
      rolesSql({ createDatabase: true, createOwner: true }),
      'SQL',
    ))],
    after: [c.database === 'managed'
      ? 'Azure Flexible Server needs `btree_gist` allowlisted first, and Amazon RDS needs its CA bundle in `FF_DATABASE_CA_FILE`: see [Database](/reference/configuration#the-btree_gist-extension).'
      : 'With a certificate from your own authority, mount it and set `FF_DATABASE_CA_FILE`: see [Database → TLS](/reference/configuration#tls-and-certificate-authorities).'],
  }));

  steps.push(step('Store the secrets', {
    prose: [
      'Two Secrets: `companyflags` for the servers, and `companyflags-migrate` with the owner’s address, for the migrate Job only. `FF_SECRET` is made here, once: give every pod the same one, and never rotate it on a schedule.',
    ],
    code: [bash(lines(
      `kubectl create namespace ${NS}`,
      `kubectl -n ${NS} create secret generic companyflags \\`,
      '  --from-literal=FF_SECRET="$(openssl rand -base64 32)" \\',
      c.metrics && '  --from-literal=FF_METRICS_TOKEN="$(openssl rand -hex 32)" \\',
      `  --from-literal=DATABASE_URL="${url('flags_app', 'APP_PW')}"`,
      `kubectl -n ${NS} create secret generic companyflags-migrate \\`,
      `  --from-literal=DATABASE_URL="${url('flags_owner', 'OWNER_PW')}"`,
      wholeHost && lines(
        '# Cloudflare is in front of the whole host: trust its ranges, and the pods it reaches the gateway through',
        CLOUDFLARE_RANGES_COMMAND,
        `kubectl -n ${NS} create configmap companyflags-proxies --from-literal=FF_TRUSTED_PROXIES="${POD_RANGE},${CLOUDFLARE_RANGES}"`,
      ),
    ))],
  }));

  const job = lines(
    '# migrate-job.yaml: the new version’s migrations, once, before its pods start. A new name for each version.',
    'apiVersion: batch/v1',
    'kind: Job',
    'metadata:',
    '  name: companyflags-migrate-0-9',
    `  namespace: ${NS}`,
    'spec:',
    '  backoffLimit: 0',
    '  ttlSecondsAfterFinished: 86400',
    '  template:',
    '    spec:',
    '      restartPolicy: Never',
    '      containers:',
    '        - name: migrate',
    `          image: ${IMAGE}`,
    '          command: ["companyflags", "migrate"]',
    '          env:',
    '            - name: DATABASE_URL',
    '              valueFrom:',
    '                secretKeyRef: { name: companyflags-migrate, key: DATABASE_URL }',
    '            - name: FF_SECRET',
    '              valueFrom:',
    '                secretKeyRef: { name: companyflags, key: FF_SECRET }',
    envEntry('FF_DB_POOL', '2', '            '),
  );
  steps.push(step('Run the migrations', {
    prose: [
      'The pods run with `FF_MIGRATE=off`: they check the schema and never change it. A Job runs `companyflags migrate` first, as `flags_owner`. Run a new one before every upgrade ([Upgrading](/operate/upgrading#several-servers-or-a-rolling-upgrade)).',
    ],
    code: [
      file('yaml', 'migrate-job.yaml', job),
      bash(lines(
        'kubectl apply -f migrate-job.yaml',
        `kubectl -n ${NS} wait --for=condition=complete job/companyflags-migrate-0-9 --timeout=10m`,
      )),
    ],
  }));

  const env = plain(settings).filter((s) => !(wholeHost && s.name === 'FF_TRUSTED_PROXIES'));
  const deployment = lines(
    '# companyflags.yaml: the servers, with FF_MIGRATE=off, and their Service',
    'apiVersion: apps/v1',
    'kind: Deployment',
    'metadata:',
    '  name: companyflags',
    `  namespace: ${NS}`,
    'spec:',
    '  replicas: 2',
    '  selector:',
    '    matchLabels: { app: companyflags }',
    '  strategy:',
    '    rollingUpdate: { maxUnavailable: 0, maxSurge: 1 }',
    '  template:',
    '    metadata:',
    '      labels: { app: companyflags }',
    '    spec:',
    '      terminationGracePeriodSeconds: 30',
    '      containers:',
    '        - name: companyflags',
    `          image: ${IMAGE}`,
    '          ports:',
    '            - { name: http, containerPort: 8787 }',
    '          envFrom:',
    '            - secretRef: { name: companyflags }',
    '          env:',
    ...env.map((s) => envEntry(s.name, s.value, '            ')),
    wholeHost && lines(
      '            - name: FF_TRUSTED_PROXIES',
      '              valueFrom:',
      '                configMapKeyRef: { name: companyflags-proxies, key: FF_TRUSTED_PROXIES }',
    ),
    '          resources:',
    '            requests: { cpu: 500m, memory: 512Mi }',
    '            limits: { memory: 1Gi }',
    '          startupProbe:          # first traffic waits until every snapshot is loaded',
    '            httpGet: { path: /readyz, port: http }',
    '            periodSeconds: 5',
    '            failureThreshold: 24',
    '          livenessProbe:',
    '            httpGet: { path: /healthz, port: http }',
    '            periodSeconds: 10',
    '            failureThreshold: 3',
    '          readinessProbe:        # /healthz, never /readyz: a database outage mustn’t empty the Service',
    '            httpGet: { path: /healthz, port: http }',
    '            periodSeconds: 5',
    '            failureThreshold: 3',
    '---',
    'apiVersion: v1',
    'kind: Service',
    'metadata:',
    '  name: companyflags',
    `  namespace: ${NS}`,
    'spec:',
    '  selector: { app: companyflags }',
    '  ports:',
    '    - { name: http, port: 80, targetPort: http }',
    '---',
    'apiVersion: policy/v1',
    'kind: PodDisruptionBudget',
    'metadata:',
    '  name: companyflags',
    `  namespace: ${NS}`,
    'spec:',
    '  minAvailable: 1',
    '  selector:',
    '    matchLabels: { app: companyflags }',
  );
  steps.push(step('Start the servers', {
    prose: [
      'Two pods or more, all on the same database. Each opens a pool of 10 connections: with at most 4 pods, a deploy needs `2 × 4 × 10 + 2 + 10 = 92`.',
      `\`FF_TRUSTED_PROXIES\` is the range your gateway’s pods connect from. \`${POD_RANGE}\` is a placeholder: narrow it to your cluster’s pod range.`,
    ],
    code: [
      file('yaml', 'companyflags.yaml', deployment),
      bash(lines('kubectl apply -f companyflags.yaml', `kubectl -n ${NS} rollout status deploy/companyflags`)),
    ],
    after: ['Health checks: [Monitoring → Health checks](/operate/monitoring#health-checks).'],
  }));

  const hosts = c.cdnHost ? [c.domain, cdnName(c)] : [c.domain];
  const gateway = lines(
    '# gateway.yaml: HTTPS for the console, the API, OFREP and its streams',
    'apiVersion: gateway.networking.k8s.io/v1',
    'kind: Gateway',
    'metadata:',
    '  name: companyflags',
    `  namespace: ${NS}`,
    'spec:',
    '  gatewayClassName: <gateway class>   # kubectl get gatewayclass',
    '  listeners:',
    ...hosts.map((h, i) => lines(
      `    - name: https${i ? '-cdn' : ''}`,
      `      hostname: ${h}`,
      '      port: 443',
      '      protocol: HTTPS',
      '      tls:',
      '        mode: Terminate',
      '        certificateRefs: [{ name: companyflags-tls }]',
    )),
    '    - name: http',
    '      port: 80',
    '      protocol: HTTP',
    '---',
    'apiVersion: gateway.networking.k8s.io/v1',
    'kind: HTTPRoute',
    'metadata:',
    '  name: companyflags',
    `  namespace: ${NS}`,
    'spec:',
    '  parentRefs:',
    ...hosts.map((_, i) => `    - { name: companyflags, sectionName: https${i ? '-cdn' : ''} }`),
    `  hostnames: [${hosts.join(', ')}]`,
    '  rules:',
    '    - backendRefs: [{ name: companyflags, port: 80 }]',
    '      timeouts: { request: 0s }   # the change-event streams stay open',
    '      filters:',
    '        - type: ResponseHeaderModifier',
    '          responseHeaderModifier:',
    '            set: [{ name: Strict-Transport-Security, value: "max-age=31536000; includeSubDomains" }]',
    '---',
    'apiVersion: gateway.networking.k8s.io/v1',
    'kind: HTTPRoute',
    'metadata:',
    '  name: companyflags-redirect',
    `  namespace: ${NS}`,
    'spec:',
    '  parentRefs: [{ name: companyflags, sectionName: http }]',
    `  hostnames: [${hosts.join(', ')}]`,
    '  rules:',
    '    - filters:',
    '        - type: RequestRedirect',
    '          requestRedirect: { scheme: https, statusCode: 301 }',
  );
  steps.push(step('Put HTTPS in front', {
    prose: [
      `A Gateway ends TLS for \`${hosts.join('` and `')}\`, with a certificate in the Secret \`companyflags-tls\` (cert-manager can make it). Point DNS at the Gateway’s address.`,
      'Whatever your gateway, it must not buffer answers, keep its read timeout above 120 seconds for the streams, and let 4 MB bodies through for imports. Each controller sets these its own way: see [Proxies and HTTPS](/reference/configuration#timeouts-and-body-sizes).',
    ],
    code: [file('yaml', 'gateway.yaml', gateway), bash(`kubectl apply -f gateway.yaml\nkubectl -n ${NS} get gateway companyflags   # its address, for DNS`)],
  }));

  steps.push(adminStep(c, 'the pods’ logs', `kubectl -n ${NS} logs deploy/companyflags | grep /api/setup/`));
  if (c.signIn === 'sso') steps.push(ssoStep(c));
  if (c.cdn === 'cloudflare') {
    const s = cloudflareStep(c, 'the Gateway’s address');
    s.code.push(cdnCheck(c, '`cf-cache-status: HIT`'));
    steps.push(s);
  }
  steps.push(checklistStep(c, ['The pods’ stop timeout (`terminationGracePeriodSeconds`) is above 5 seconds, so streams close cleanly: [Monitoring → Shutdown](/operate/monitoring#shutdown).']));
  steps.push(recipeStep(c));

  return {
    choices: c,
    summary: `Kubernetes: two or more pods on ${c.database === 'managed' ? 'a managed Postgres' : 'your own Postgres'}, migrations as a Job, HTTPS through the Gateway API, at https://${c.domain}.`,
    steps,
    settings,
    recipe: recipe(c),
  };
}
