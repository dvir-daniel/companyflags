// Azure (self-hosting/azure.md): Container Apps, Database for PostgreSQL Flexible Server, Key Vault references, and
// Front Door (no purge) or Cloudflare on a CDN host of its own. The app is one YAML file, probes and scale rule included.

import type { Choices } from './choices.ts';
import {
  adminStep, cdnCheck, cdnName, checklistStep, cloudflareStep, IMAGE, PASSWORDS, plain, recipe, recipeStep, ROLES_NOTE, rolesSql,
  SAME_SHELL, serverSettings, ssoStep,
} from './common.ts';
import { bash, file, lines, step, type Plan, type Step } from './plan.ts';

const PRIVATE = '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,fc00::/7';
const SUB = '/subscriptions/<subscription>/resourceGroups/flags/providers';
const IDENTITY = `${SUB}/Microsoft.ManagedIdentity/userAssignedIdentities/flags-id`;
const VAULT = 'https://flags-kv.vault.azure.net/secrets';
const PG_HOST = 'flags-pg.postgres.database.azure.com';

export function azurePlan(c: Choices): Plan {
  const frontDoor = c.cdn === 'front-door';
  const settings = serverSettings(c, { proxies: PRIVATE, several: true });
  const steps: Step[] = [];

  steps.push(step('Make the network', {
    prose: ['A resource group, and a virtual network with one subnet for Container Apps and one for Postgres. Check the flags against `--help` on your CLI’s version.'],
    code: [bash(lines(
      'RG=flags LOC=westeurope',
      'az group create -n $RG -l $LOC',
      'az network vnet create -g $RG -n vnet --address-prefixes 10.20.0.0/16 --subnet-name aca --subnet-prefixes 10.20.0.0/23',
      'az network vnet subnet update -g $RG --vnet-name vnet -n aca --delegations Microsoft.App/environments',
      'az network vnet subnet create -g $RG --vnet-name vnet -n pg --address-prefixes 10.20.4.0/24 \\',
      '  --delegations Microsoft.DBforPostgreSQL/flexibleServers',
    ))],
  }));

  steps.push(step('Make the database and its roles', {
    prose: [
      'Flexible Server with Postgres 18, General Purpose, zone-redundant, with backups kept 14 days. `btree_gist` must be allowlisted before it can be created. Then, from a host in the virtual network, make the database and two roles as `pgadmin`.',
      ROLES_NOTE,
      SAME_SHELL,
    ],
    code: [
      bash(lines(
        'PGADMIN_PW=$(openssl rand -hex 24)',
        'az postgres flexible-server create -g $RG -n flags-pg --tier GeneralPurpose --sku-name Standard_D2ds_v5 --version 18 \\',
        '  --storage-size 32 --backup-retention 14 --high-availability ZoneRedundant --vnet vnet --subnet pg \\',
        '  --admin-user pgadmin --admin-password "$PGADMIN_PW"',
        'az postgres flexible-server parameter set -g $RG -s flags-pg -n azure.extensions --value BTREE_GIST',
      ), 'Make the server'),
      bash(lines(
        PASSWORDS,
        `psql "postgres://pgadmin:$PGADMIN_PW@${PG_HOST}:5432/postgres?sslmode=verify-full" \\`,
        '  -v owner_pw="$OWNER_PW" -v app_pw="$APP_PW" <<\'SQL\'',
        rolesSql({ createDatabase: true, createOwner: true }),
        'SQL',
      ), 'Make the roles, from a host in the network'),
    ],
    after: ['Where Postgres 18 isn’t offered in your region yet, use `--version 17`: the server needs 15 or later. Azure’s root authorities are in Node’s own store, so nothing is added for TLS.'],
  }));

  steps.push(step('Store the secrets', {
    prose: [
      'Key Vault holds `FF_SECRET`, made here once, and one address per role. The app reads them with a user-assigned identity. Key Vault names are global: if `flags-kv` is taken, pick another and change it in every step.',
    ],
    code: [bash(lines(
      'az identity create -g $RG -n flags-id',
      'az keyvault create -g $RG -n flags-kv --enable-rbac-authorization true',
      'KV=$(az keyvault show -n flags-kv --query id -o tsv)',
      'az role assignment create --assignee "$(az ad signed-in-user show --query id -o tsv)" --role "Key Vault Secrets Officer" --scope $KV',
      'az keyvault secret set --vault-name flags-kv -n ff-secret --value "$(openssl rand -base64 32)" -o none',
      `az keyvault secret set --vault-name flags-kv -n database-url -o none \\`,
      `  --value "postgres://flags_app:$APP_PW@${PG_HOST}:5432/flags?sslmode=verify-full"`,
      `az keyvault secret set --vault-name flags-kv -n database-url-migrate -o none \\`,
      `  --value "postgres://flags_owner:$OWNER_PW@${PG_HOST}:5432/flags?sslmode=verify-full"`,
      c.metrics && 'az keyvault secret set --vault-name flags-kv -n metrics-token --value "$(openssl rand -hex 32)" -o none',
      'az role assignment create --assignee-object-id "$(az identity show -g $RG -n flags-id --query principalId -o tsv)" \\',
      '  --assignee-principal-type ServicePrincipal --role "Key Vault Secrets User" --scope $KV',
      'ID_RES=$(az identity show -g $RG -n flags-id --query id -o tsv)',
      'AUTH_URI=$(az keyvault secret show --vault-name flags-kv -n ff-secret --query id -o tsv)   # versioned',
    ))],
    after: ['`FF_SECRET` is read by its versioned address: a versionless one would pick up a new version on its own and sign everyone out.'],
  }));

  steps.push(step('Run the migrations', {
    prose: [
      'The app runs with `FF_MIGRATE=off`. A manual Container Apps job runs `companyflags migrate` first, as `flags_owner`, and again before each upgrade ([Upgrading](/operate/upgrading#several-servers-or-a-rolling-upgrade)). Limit who may start it: starting a job grants the use of its secrets.',
    ],
    code: [bash(lines(
      'ACA_SUBNET_ID=$(az network vnet subnet show -g $RG --vnet-name vnet -n aca --query id -o tsv)',
      'az containerapp env create -g $RG -n flags-env -l $LOC --infrastructure-subnet-resource-id $ACA_SUBNET_ID --zone-redundant',
      'az containerapp job create -g $RG -n flags-migrate --environment flags-env --trigger-type Manual \\',
      `  --image ${IMAGE} --command companyflags --args migrate --replica-timeout 1800 --replica-retry-limit 0 \\`,
      '  --cpu 0.5 --memory 1Gi --mi-user-assigned $ID_RES \\',
      `  --secrets "db=keyvaultref:${VAULT}/database-url-migrate,identityref:$ID_RES" \\`,
      '            "auth=keyvaultref:$AUTH_URI,identityref:$ID_RES" \\',
      '  --env-vars DATABASE_URL=secretref:db FF_SECRET=secretref:auth FF_DB_POOL=2',
      'az containerapp job start -g $RG -n flags-migrate',
      'az containerapp job execution list -g $RG -n flags-migrate -o table   # wait for Succeeded',
    ))],
  }));

  const ref = (name: string, url: string) => lines(`      - name: ${name}`, `        keyVaultUrl: ${url}`, `        identity: ${IDENTITY}`);
  const app = lines(
    '# app.yaml: the container app, for az containerapp create --yaml',
    'location: westeurope',
    'identity:',
    '  type: UserAssigned',
    '  userAssignedIdentities:',
    `    ${IDENTITY}: {}`,
    'properties:',
    `  managedEnvironmentId: ${SUB}/Microsoft.App/managedEnvironments/flags-env`,
    '  configuration:',
    '    activeRevisionsMode: Single',
    '    ingress:',
    '      external: true',
    '      targetPort: 8787',
    '      transport: http',
    '    secrets:',
    ref('db', `${VAULT}/database-url`),
    ref('auth', `${VAULT}/ff-secret/<version>   # pinned`),
    c.metrics && ref('metrics', `${VAULT}/metrics-token`),
    '  template:',
    '    containers:',
    '      - name: companyflags',
    `        image: ${IMAGE}`,
    '        resources: { cpu: 1, memory: 2Gi }',
    '        env:',
    '          - { name: DATABASE_URL, secretRef: db }',
    '          - { name: FF_SECRET, secretRef: auth }',
    c.metrics && '          - { name: FF_METRICS_TOKEN, secretRef: metrics }',
    ...plain(settings).map((s) => `          - { name: ${s.name}, value: ${JSON.stringify(s.value)} }`),
    '        probes:',
    '          - type: Startup              # first traffic waits until every snapshot is loaded',
    '            httpGet: { path: /readyz, port: 8787 }',
    '            initialDelaySeconds: 5',
    '            periodSeconds: 5',
    '            failureThreshold: 10',
    '          - type: Liveness',
    '            httpGet: { path: /healthz, port: 8787 }',
    '            periodSeconds: 10',
    '            failureThreshold: 3',
    '          - type: Readiness',
    '            httpGet: { path: /healthz, port: 8787 }',
    '            periodSeconds: 5',
    '            failureThreshold: 3',
    '    scale:',
    '      minReplicas: 2',
    '      maxReplicas: 4',
    '      rules:',
    '        - name: cpu',
    '          custom:',
    '            type: cpu',
    '            metadata: { type: Utilization, value: "70" }',
  );
  steps.push(step('Start the app', {
    prose: [
      'At least 2 replicas: at 0 the background loop stops. A CPU scale rule, not the default HTTP one, because open streams don’t fit a count of requests. Startup waits on `/readyz`; liveness and readiness check `/healthz`.',
      `The ingress connects from a private address, so \`FF_TRUSTED_PROXIES\` is the private ranges. Narrow them once you know the ingress’s range ([Azure → Load balancer](/deploy/azure#load-balancer-and-client-addresses)).`,
    ],
    code: [
      file('yaml', 'app.yaml', app),
      bash(lines(
        'SUB=$(az account show --query id -o tsv)',
        'sed -i.bak "s/<subscription>/$SUB/g; s/<version>/${AUTH_URI##*/}/g" app.yaml',
        'az containerapp create -g $RG -n companyflags --yaml app.yaml',
      )),
    ],
    after: ['With at most 4 replicas, a deploy needs `2 × 4 × 10 + 2 + 10 = 92` connections; `Standard_D2ds_v5` allows 844.'],
  }));

  steps.push(step('Add the domain', {
    prose: [
      `\`${c.domain}\` is a custom domain on the app, with a managed certificate. Add the two DNS records it asks for: a CNAME to the app’s address and a TXT record \`asuid.${c.domain}\` with the verification ID.`,
      'Container Apps can’t add HSTS, and the server sends none: see [Azure → Load balancer](/deploy/azure#load-balancer-and-client-addresses) for a way to add it.',
    ],
    code: [bash(lines(
      'az containerapp show -g $RG -n companyflags --query "[properties.configuration.ingress.fqdn, properties.customDomainVerificationId]" -o tsv',
      `az containerapp hostname add -g $RG -n companyflags --hostname ${c.domain}`,
      `az containerapp hostname bind -g $RG -n companyflags --hostname ${c.domain} --environment flags-env --validation-method CNAME`,
    ))],
  }));

  steps.push(adminStep(c, 'Log Analytics (`ContainerAppConsoleLogs_CL`)', 'az containerapp logs show -g $RG -n companyflags --tail 300 | grep /api/setup/'));
  if (c.signIn === 'sso') steps.push(ssoStep(c));

  if (frontDoor) {
    const cdn = cdnName(c);
    steps.push(step('Put Front Door in front', {
      prose: [
        `Front Door Standard caches the CDN files on \`${cdn}\`, with the app as its origin. It has one route, \`/cdn/v1/flags/*\`, so nothing else is reachable through it. OFREP and its streams go to \`${c.domain}\`: Front Door doesn’t support server-sent events.`,
      ],
      code: [bash(lines(
        'ACA_FQDN=$(az containerapp show -g $RG -n companyflags --query properties.configuration.ingress.fqdn -o tsv)',
        'az afd profile create -g $RG --profile-name flags-afd --sku Standard_AzureFrontDoor',
        'az afd endpoint create -g $RG --profile-name flags-afd --endpoint-name flags',
        'az afd origin-group create -g $RG --profile-name flags-afd --origin-group-name aca --probe-path /healthz \\',
        '  --probe-protocol Https --probe-request-type GET --probe-interval-in-seconds 60 \\',
        '  --sample-size 4 --successful-samples-required 3',
        'az afd origin create -g $RG --profile-name flags-afd --origin-group-name aca --origin-name app \\',
        '  --host-name $ACA_FQDN --origin-host-header $ACA_FQDN --priority 1 --weight 1000 --enabled-state Enabled',
        `az afd custom-domain create -g $RG --profile-name flags-afd --custom-domain-name cdn --host-name ${cdn} \\`,
        '  --certificate-type ManagedCertificate --minimum-tls-version TLS12',
        'az afd rule-set create -g $RG --profile-name flags-afd --rule-set-name cdnfiles',
        'az afd rule create -g $RG --profile-name flags-afd --rule-set-name cdnfiles --rule-name country --order 1 \\',
        "  --action-name ModifyResponseHeader --header-action Overwrite --header-name CF-IPCountry --header-value '{geo_country}'",
        'az afd route create -g $RG --profile-name flags-afd --endpoint-name flags --route-name cdn --origin-group aca \\',
        '  --custom-domains cdn --patterns-to-match "/cdn/v1/flags/*" --enable-caching true \\',
        '  --query-string-caching-behavior IgnoreQueryString --enable-compression false --rule-sets cdnfiles \\',
        '  --https-redirect Enabled --forwarding-protocol HttpsOnly --supported-protocols Https Http',
      )),
      bash(`az afd endpoint purge -g $RG --profile-name flags-afd --endpoint-name flags \\\n  --content-paths '/cdn/v1/flags/prod/*' --domains ${cdn}`, 'Purge one environment by hand'),
      cdnCheck(c, 'an `Age` header')],
      after: [
        `Point \`${cdn}\` at the endpoint with the CNAME and TXT records the custom domain asks for. Apps read CDN files from \`https://${cdn}\`.`,
        '**No purge on publish.** Front Door purges by path only and takes up to 10 minutes, longer than the minute a file is kept. A change reaches apps within about a minute; purge by hand only for an incident.',
      ],
    }));
  }

  if (c.cdn === 'cloudflare') {
    steps.push(step('Serve the CDN host at the app', {
      prose: [
        `Cloudflare reaches the app as \`${cdnName(c)}\`, so the app needs it as a second custom domain. A managed certificate can’t be issued behind Cloudflare’s proxy: make a Cloudflare Origin CA certificate for \`${cdnName(c)}\` (**SSL/TLS → Origin Server**), save it as \`origin.pem\` and \`origin-key.pem\`, and upload it.`,
      ],
      code: [bash(lines(
        'openssl pkcs12 -export -in origin.pem -inkey origin-key.pem -out origin.pfx -passout pass:',
        'az containerapp env certificate upload -g $RG -n flags-env --certificate-file origin.pfx --certificate-name cdn-origin --password ""',
        `az containerapp hostname add -g $RG -n companyflags --hostname ${cdnName(c)}`,
        `az containerapp hostname bind -g $RG -n companyflags --hostname ${cdnName(c)} --environment flags-env --certificate cdn-origin`,
      ))],
      after: [`Add the TXT record \`asuid.${cdnName(c)}\` with the verification ID first, DNS only.`],
    }));
    const s = cloudflareStep(c, 'the app’s address (a CNAME to its `ingress.fqdn`)');
    s.code.push(cdnCheck(c, '`cf-cache-status: HIT`'));
    steps.push(s);
  }

  steps.push(checklistStep(c, ['`FF_SECRET` is read by a versioned Key Vault address, and only a few people may start the migrate job: [Azure → Secrets](/deploy/azure#secrets).']));
  steps.push(recipeStep(c));

  return {
    choices: c,
    summary: `Azure: Container Apps, Database for PostgreSQL Flexible Server 18, Key Vault${frontDoor ? ', Front Door for the CDN files' : c.cdn === 'cloudflare' ? ', Cloudflare on its own host' : ''}, at https://${c.domain}.`,
    steps,
    settings,
    recipe: recipe(c),
  };
}
