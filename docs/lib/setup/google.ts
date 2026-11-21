// Google Cloud (self-hosting/google-cloud.md): Cloud Run behind a global external Application Load Balancer, Cloud SQL
// over its built-in socket, Secret Manager pinned to versions, and Cloud CDN on one backend or Cloudflare on a CDN host.

import type { Choices } from './choices.ts';
import {
  adminStep, cdnCheck, cdnName, checklistStep, cloudflareStep, IMAGE, PASSWORDS, plain, recipe, recipeStep, ROLES_NOTE, rolesSql,
  SAME_SHELL, serverSettings, ssoStep,
} from './common.ts';
import { bash, file, lines, step, type Plan, type Step } from './plan.ts';

export function googlePlan(c: Choices): Plan {
  const cloudCdn = c.cdn === 'cloud-cdn';
  const cloudflare = c.cdn === 'cloudflare';
  const settings = serverSettings(c, {
    proxies: '169.254.0.0/16', header: 'x-client-ip', several: true,
    purge: cloudCdn ? [
      { name: 'FF_CLOUD_CDN_PROJECT', value: 'acme-flags' },
      { name: 'FF_CLOUD_CDN_URL_MAP', value: 'flags-map' },
      { name: 'FF_CLOUD_CDN_HOST', value: c.cdnHost ? cdnName(c) : c.domain },
    ] : [],
  });
  const hosts = c.cdnHost ? `$D,${cdnName(c)}` : '$D';
  const steps: Step[] = [];

  steps.push(step('Turn on the APIs and make the service account', {
    prose: [
      `Set the names once: the later steps use them. The service account gets the Cloud SQL client role${cloudCdn ? ', and a custom role with only `compute.urlMaps.invalidateCache` for the purge' : ''}. Check the flags against \`--help\` on your \`gcloud\` version.`,
    ],
    code: [bash(lines(
      `P=acme-flags R=europe-west1 I=flags-pg D=${c.domain}`,
      'SA=companyflags@$P.iam.gserviceaccount.com',
      'gcloud config set project $P',
      'gcloud services enable run.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com \\',
      '  compute.googleapis.com artifactregistry.googleapis.com',
      'gcloud iam service-accounts create companyflags',
      'gcloud projects add-iam-policy-binding $P --member=serviceAccount:$SA --role=roles/cloudsql.client',
      cloudCdn && lines(
        'gcloud iam roles create cdnInvalidator --project=$P --title="CDN invalidator" \\',
        '  --permissions=compute.urlMaps.invalidateCache',
        'gcloud projects add-iam-policy-binding $P --member=serviceAccount:$SA --role=projects/$P/roles/cdnInvalidator',
      ),
    ))],
  }));

  steps.push(step('Make the database and its roles', {
    prose: [
      'Cloud SQL for PostgreSQL 18, Enterprise edition, with a standby and point-in-time recovery. `gcloud` makes `flags_owner` a member of `cloudsqlsuperuser`, so it can create `btree_gist`. Then, as `flags_owner`, make `flags_app` through the Cloud SQL Auth Proxy.',
      ROLES_NOTE,
      SAME_SHELL,
    ],
    code: [
      bash(lines(
        PASSWORDS,
        'gcloud sql instances create $I --database-version=POSTGRES_18 --edition=ENTERPRISE --tier=db-custom-1-3840 \\',
        '  --region=$R --availability-type=REGIONAL --enable-point-in-time-recovery --ssl-mode=ENCRYPTED_ONLY --deletion-protection',
        'gcloud sql databases create flags --instance=$I',
        'gcloud sql users create flags_owner --instance=$I --password="$OWNER_PW"',
      ), 'Make the instance'),
      bash(lines(
        'cloud-sql-proxy $P:$R:$I --port 6543 &',
        'psql "host=127.0.0.1 port=6543 dbname=flags user=flags_owner password=$OWNER_PW" -v app_pw="$APP_PW" <<\'SQL\'',
        rolesSql({ createDatabase: false, createOwner: false }),
        'SQL',
        'kill %1',
      ), 'Make the roles'),
    ],
  }));

  steps.push(step('Copy the image', {
    prose: ['Cloud Run runs images from Artifact Registry, not from `ghcr.io`. Copy the release there. No config file is needed: the settings turn everything on.'],
    code: [bash(lines(
      'gcloud artifacts repositories create flags --repository-format=docker --location=$R',
      'gcloud auth configure-docker $R-docker.pkg.dev',
      'IMG=$R-docker.pkg.dev/$P/flags/companyflags:0.9',
      `docker pull --platform linux/amd64 ${IMAGE}`,
      `docker tag ${IMAGE} $IMG && docker push $IMG`,
    ))],
  }));

  steps.push(step('Store the secrets', {
    prose: [
      '`FF_SECRET` is made here, once. One address per role: `flags_app` for the service, `flags_owner` for the migrate job only. The service reads each secret pinned to a version (`:1`), never `latest`.',
    ],
    code: [bash(lines(
      'openssl rand -base64 32 | tr -d \'\\n\' | gcloud secrets create flags-auth-secret --data-file=-',
      "printf 'postgres://flags_app:%s@localhost/flags?host=/cloudsql/%s:%s:%s' \"$APP_PW\" $P $R $I \\",
      '  | gcloud secrets create flags-database-url --data-file=-',
      "printf 'postgres://flags_owner:%s@localhost/flags?host=/cloudsql/%s:%s:%s' \"$OWNER_PW\" $P $R $I \\",
      '  | gcloud secrets create flags-database-url-migrate --data-file=-',
      c.metrics && "openssl rand -hex 32 | tr -d '\\n' | gcloud secrets create flags-metrics-token --data-file=-",
      `for s in flags-auth-secret flags-database-url flags-database-url-migrate${c.metrics ? ' flags-metrics-token' : ''}; do`,
      '  gcloud secrets add-iam-policy-binding $s --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor; done',
    ))],
  }));

  steps.push(step('Run the migrations', {
    prose: [
      'The service runs with `FF_MIGRATE=off`. A Cloud Run job runs `companyflags migrate` first, as `flags_owner`, and again before each upgrade ([Upgrading](/operate/upgrading#several-servers-or-a-rolling-upgrade)).',
    ],
    code: [bash(lines(
      'gcloud run jobs deploy flags-migrate --image=$IMG --region=$R --service-account=$SA \\',
      '  --set-cloudsql-instances=$P:$R:$I \\',
      '  --set-secrets=DATABASE_URL=flags-database-url-migrate:1,FF_SECRET=flags-auth-secret:1 \\',
      '  --set-env-vars=FF_PUBLIC_URL=https://$D,FF_DB_POOL=2 --command=companyflags --args=migrate --max-retries=0',
      'gcloud run jobs execute flags-migrate --region=$R --wait',
    ))],
  }));

  const env = plain(settings).map((s) => `${s.name}: ${JSON.stringify(s.value)}`);
  const secrets = `DATABASE_URL=flags-database-url:1,FF_SECRET=flags-auth-secret:1${c.metrics ? ',FF_METRICS_TOKEN=flags-metrics-token:1' : ''}`;
  steps.push(step('Start the service', {
    prose: [
      'Instance-based billing (`--no-cpu-throttling`) and at least 2 instances keep the background loop running between requests. `--timeout=3600` lets the change-event streams stay open an hour. The startup probe checks `/readyz`, the liveness probe `/healthz`.',
      'The settings go in a file, so values with commas need no escaping.',
    ],
    code: [
      file('yaml', 'env.yaml', lines('# env.yaml: the service’s settings, read by gcloud run deploy --env-vars-file', ...env)),
      bash(lines(
        'gcloud run deploy companyflags --image=$IMG --region=$R --service-account=$SA --port=8787 \\',
        '  --cpu=1 --memory=1Gi --no-cpu-throttling --min=2 --max-instances=4 --concurrency=1000 --timeout=3600 --cpu-boost \\',
        '  --ingress=internal-and-cloud-load-balancing --allow-unauthenticated \\',
        '  --add-cloudsql-instances=$P:$R:$I \\',
        `  --set-secrets=${secrets} \\`,
        '  --env-vars-file=env.yaml \\',
        '  --startup-probe=httpGet.path=/readyz,httpGet.port=8787,periodSeconds=5,timeoutSeconds=3,failureThreshold=24 \\',
        '  --liveness-probe=httpGet.path=/healthz,httpGet.port=8787,periodSeconds=30,timeoutSeconds=5,failureThreshold=3',
      )),
    ],
    after: [`With \`--max-instances=4\`, a deploy needs \`2 × 4 × 10 + 2 + 10 = 92\` connections, which fits \`db-custom-1-3840\` (100). Move to a bigger tier before you raise it.${cloudCdn ? ' If your project isn’t \`acme-flags\`, change \`FF_CLOUD_CDN_PROJECT\` in \`env.yaml\` too.' : ''}`],
  }));

  const neg = (n: string) => `gcloud compute network-endpoint-groups create ${n} --region=$R --network-endpoint-type=serverless --cloud-run-service=companyflags`;
  steps.push(step('Put the load balancer in front', {
    prose: [
      'A global external Application Load Balancer with a Google-managed certificate ends TLS and adds HSTS. It sets `X-Client-IP` on the way in, which the server reads (`FF_CLIENT_IP_HEADER`) from Cloud Run’s front end (`FF_TRUSTED_PROXIES=169.254.0.0/16`).',
      cloudCdn
        ? 'Two backends for the same service: `flags-app` without a CDN, and `flags-cdn` with Cloud CDN on, for `/cdn/v1/flags/*` only. Cloud CDN caches by the server’s headers (`USE_ORIGIN_HEADERS`), ignores the query string and keeps no `404`.'
        : 'One backend, `flags-app`, with no CDN: OFREP and its streams must never be cached.',
    ],
    code: [bash(lines(
      'gcloud compute addresses create flags-ip --global --ip-version=IPV4 --network-tier=PREMIUM',
      neg('flags-neg-app'),
      cloudCdn && neg('flags-neg-cdn'),
      "HSTS='Strict-Transport-Security: max-age=31536000; includeSubDomains'",
      'gcloud compute backend-services create flags-app --global --load-balancing-scheme=EXTERNAL_MANAGED \\',
      "  --custom-request-header='X-Client-IP:{client_ip_address}' --custom-response-header=\"$HSTS\"",
      'gcloud compute backend-services add-backend flags-app --global --network-endpoint-group=flags-neg-app --network-endpoint-group-region=$R',
      cloudCdn && lines(
        'gcloud compute backend-services create flags-cdn --global --load-balancing-scheme=EXTERNAL_MANAGED \\',
        '  --enable-cdn --cache-mode=USE_ORIGIN_HEADERS --no-cache-key-include-query-string --no-negative-caching \\',
        "  --custom-response-header=\"$HSTS\" --custom-response-header='CF-IPCountry:{client_region}' \\",
        '  --enable-logging --logging-sample-rate=0.05',
        'gcloud compute backend-services add-backend flags-cdn --global --network-endpoint-group=flags-neg-cdn --network-endpoint-group-region=$R',
      ),
      'gcloud compute url-maps create flags-map --default-service=flags-app',
      cloudCdn && lines(
        'gcloud compute url-maps add-path-matcher flags-map --path-matcher-name=flags --default-service=flags-app \\',
        `  --path-rules='/cdn/v1/flags/*=flags-cdn' --new-hosts=${hosts}`,
      ),
      `gcloud compute ssl-certificates create flags-cert --domains=${cloudflare ? '$D' : hosts} --global`,
      'gcloud compute target-https-proxies create flags-https --url-map=flags-map --ssl-certificates=flags-cert',
      'gcloud compute forwarding-rules create flags-https --global --load-balancing-scheme=EXTERNAL_MANAGED \\',
      '  --network-tier=PREMIUM --address=flags-ip --target-https-proxy=flags-https --ports=443',
    ))],
    after: ['Then a URL map on port 80 that redirects to HTTPS. Check that Cloud Run’s front end connects from `169.254.0.0/16`: see [Google Cloud → Load balancer](/deploy/google-cloud#load-balancer-and-client-addresses).'],
  }));

  steps.push(step('Point DNS at it', {
    prose: [`An A record for \`${c.domain}\`${c.cdnHost && cloudCdn ? ` and one for \`${cdnName(c)}\`` : ''} to the address \`flags-ip\`. The certificate is issued once DNS points there.`],
    code: [bash('gcloud compute addresses describe flags-ip --global --format="value(address)"')],
  }));

  steps.push(adminStep(c, 'Cloud Logging', 'gcloud logging read \'resource.type="cloud_run_revision" AND textPayload:"/api/setup/"\' --limit=5 --format="value(textPayload)"'));
  if (c.signIn === 'sso') steps.push(ssoStep(c));
  if (cloudCdn) {
    steps.push(step('Check the CDN', {
      prose: [
        `**Purge on publish:** \`FF_CLOUD_CDN_PROJECT\` and \`FF_CLOUD_CDN_URL_MAP\` turn it on, with the service account’s own token: no token is stored. It invalidates by cache tag, in about 10 seconds. Apps read CDN files from \`https://${c.cdnHost ? cdnName(c) : c.domain}\`.`,
      ],
      code: [cdnCheck(c, 'an `Age` header')],
    }));
  }
  if (cloudflare) {
    steps.push(step('Serve the CDN host at the load balancer', {
      prose: [
        `Cloudflare reaches the load balancer as \`${cdnName(c)}\`, so the load balancer needs a certificate for it. A Google-managed one can’t be issued behind Cloudflare’s proxy: make a Cloudflare Origin CA certificate for \`${cdnName(c)}\` (**SSL/TLS → Origin Server**), and save it as \`origin.pem\` and \`origin-key.pem\`.`,
      ],
      code: [bash(lines(
        'gcloud compute ssl-certificates create flags-cdn-origin --certificate=origin.pem --private-key=origin-key.pem --global',
        'gcloud compute target-https-proxies update flags-https --ssl-certificates=flags-cert,flags-cdn-origin',
      ))],
    }));
    const s = cloudflareStep(c, 'the address `flags-ip`');
    s.code.push(cdnCheck(c, '`cf-cache-status: HIT`'));
    steps.push(s);
  }
  steps.push(checklistStep(c, ['Each secret is pinned to a version, and `--max-instances` stays inside the connection budget: [Google Cloud → Secrets](/deploy/google-cloud#secrets).']));
  steps.push(recipeStep(c));

  return {
    choices: c,
    summary: `Google Cloud: Cloud Run behind a global load balancer, Cloud SQL for PostgreSQL 18, Secret Manager${cloudCdn ? ', Cloud CDN for the CDN files' : cloudflare ? ', Cloudflare on its own host' : ''}, at https://${c.domain}.`,
    steps,
    settings,
    recipe: recipe(c),
  };
}
