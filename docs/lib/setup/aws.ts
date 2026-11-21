// AWS (self-hosting/aws.md): ECS on Fargate behind an ALB, RDS for PostgreSQL, Secrets Manager, and CloudFront or
// Cloudflare on a CDN host of its own. Files with <account> and <region> are filled in by one sed command.

import type { Choices } from './choices.ts';
import {
  adminStep, cdnCheck, cdnName, checklistStep, cloudflareStep, IMAGE, PASSWORDS, plain, recipe, recipeStep, ROLES_NOTE, rolesSql,
  SAME_SHELL, serverSettings, ssoStep,
} from './common.ts';
import { bash, file, lines, step, type Plan, type Step } from './plan.ts';

const ALB_SUBNETS = '10.0.0.0/24,10.0.1.0/24,10.0.2.0/24';
const CA = '/etc/ssl/rds-global-bundle.pem';
const REPO = '<account>.dkr.ecr.<region>.amazonaws.com/companyflags:0.9';
const SECRET = (name: string, key: string) => `arn:aws:secretsmanager:<region>:<account>:secret:${name}:${key}::`;
const json = (v: unknown) => JSON.stringify(v, null, 2);
const FILL = (...files: string[]) => `sed -i.bak "s/<account>/$ACCOUNT/g; s/<region>/$R/g" ${files.join(' ')}`;
const NETWORK = "--network-configuration 'awsvpcConfiguration={subnets=[subnet-a,subnet-b,subnet-c],securityGroups=[sg-tasks],assignPublicIp=DISABLED}'";

const logs = { logDriver: 'awslogs', options: { 'awslogs-group': '/ecs/companyflags', 'awslogs-region': '<region>', 'awslogs-stream-prefix': 'ecs', mode: 'non-blocking' } };
const fargate = (family: string, cpu: string, memory: string) => ({
  family, requiresCompatibilities: ['FARGATE'], networkMode: 'awsvpc', cpu, memory,
  runtimePlatform: { cpuArchitecture: 'ARM64', operatingSystemFamily: 'LINUX' },
  executionRoleArn: 'arn:aws:iam::<account>:role/companyflags-execution',
  taskRoleArn: 'arn:aws:iam::<account>:role/companyflags-task',
});

export function awsPlan(c: Choices): Plan {
  const cloudfront = c.cdn === 'cloudfront';
  const settings = serverSettings(c, {
    proxies: ALB_SUBNETS, several: true, caFile: CA,
    purge: cloudfront ? [{ name: 'FF_CLOUDFRONT_DISTRIBUTION_ID', value: '<distribution id>' }] : [],
  });
  const steps: Step[] = [];

  steps.push(step('Build the network', {
    prose: ['Make these first, in Terraform, CDK or the console. The commands below use their names: `subnet-a`, `sg-tasks` and so on stand for your own IDs.'],
    list: [
      'A VPC in 3 zones: public subnets for the ALB, private ones for the tasks and RDS.',
      'NAT, or VPC endpoints for `ecr.api`, `ecr.dkr`, `logs`, `secretsmanager` and S3. Tasks need the internet for single sign-on, webhooks' + (cloudfront ? ' and the CloudFront API.' : '.'),
      'Security groups: `sg-alb` takes 443 and 80; `sg-tasks` takes 8787 from `sg-alb` only; `sg-db` takes 5432 from `sg-tasks` only.',
      'An RDS subnet group named `companyflags`, over the private subnets.',
    ],
  }));

  steps.push(step('Make the database and its roles', {
    prose: [
      'RDS for PostgreSQL 18, Multi-AZ, with backups kept 14 days. RDS keeps the master password in Secrets Manager. Then, from a host in the VPC, make `btree_gist` and the two roles as the master user.',
      ROLES_NOTE,
      SAME_SHELL,
    ],
    code: [
      bash(lines(
        'R=eu-west-1',
        'ACCOUNT=$(aws sts get-caller-identity --query Account --output text)',
        'aws rds create-db-instance --region $R --db-instance-identifier companyflags \\',
        '  --engine postgres --engine-version 18 --db-instance-class db.t4g.small \\',
        '  --allocated-storage 20 --storage-type gp3 --multi-az --storage-encrypted \\',
        '  --master-username postgres --manage-master-user-password \\',
        '  --db-subnet-group-name companyflags --vpc-security-group-ids sg-db --no-publicly-accessible \\',
        '  --backup-retention-period 14 --deletion-protection',
        'aws rds wait db-instance-available --region $R --db-instance-identifier companyflags',
        "RDS=$(aws rds describe-db-instances --region $R --db-instance-identifier companyflags --query 'DBInstances[0].Endpoint.Address' --output text)",
      ), 'Make the instance'),
      bash(lines(
        'curl -fsSo rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem',
        PASSWORDS,
        '# psql asks for the master password: Secrets Manager → the secret RDS made',
        'psql "postgres://postgres@$RDS:5432/postgres?sslmode=verify-full&sslrootcert=rds-global-bundle.pem" \\',
        '  -v owner_pw="$OWNER_PW" -v app_pw="$APP_PW" <<\'SQL\'',
        rolesSql({ createDatabase: true, createOwner: true }),
        'SQL',
      ), 'Make the roles, from a host in the VPC'),
    ],
    after: ['Never build `DATABASE_URL` from the master secret: RDS rotates it every 7 days, and running tasks don’t notice.'],
  }));

  steps.push(step('Build the image', {
    prose: [
      'RDS certificates come from its own authorities, and Fargate can’t mount a file. So build a thin image with the RDS bundle in it, and push it to ECR. `FF_DATABASE_CA_FILE` names the file.',
    ],
    code: [
      file('dockerfile', 'Dockerfile', lines(
        `FROM ${IMAGE}`,
        `ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem ${CA}`,
      )),
      bash(lines(
        'aws ecr create-repository --region $R --repository-name companyflags',
        'aws ecr get-login-password --region $R | docker login --username AWS --password-stdin $ACCOUNT.dkr.ecr.$R.amazonaws.com',
        'docker build --platform linux/arm64 -t $ACCOUNT.dkr.ecr.$R.amazonaws.com/companyflags:0.9 .',
        'docker push $ACCOUNT.dkr.ecr.$R.amazonaws.com/companyflags:0.9',
      )),
    ],
  }));

  steps.push(step('Store the secrets', {
    prose: [
      '`companyflags/prod` holds what every task reads: `FF_SECRET`, made here once, and the `flags_app` address. `companyflags/migrate` holds the `flags_owner` address, for the migrate task only. Never turn on automatic rotation for `FF_SECRET`.',
    ],
    code: [bash(lines(
      'aws secretsmanager create-secret --region $R --name companyflags/prod --secret-string "$(jq -n \\',
      '  --arg secret "$(openssl rand -base64 32)" \\',
      '  --arg db "postgres://flags_app:$APP_PW@$RDS:5432/flags?sslmode=verify-full" \\',
      c.metrics && '  --arg metrics "$(openssl rand -hex 32)" \\',
      `  '{FF_SECRET: $secret, DATABASE_URL: $db${c.metrics ? ', FF_METRICS_TOKEN: $metrics' : ''}}')"`,
      'aws secretsmanager create-secret --region $R --name companyflags/migrate --secret-string "$(jq -n \\',
      '  --arg db "postgres://flags_owner:$OWNER_PW@$RDS:5432/flags?sslmode=verify-full" \'{DATABASE_URL: $db}\')"',
    ))],
    after: ['ECS reads secrets when a task starts: a changed secret needs a new deployment.'],
  }));

  steps.push(step('Make the roles for the tasks', {
    prose: [`The execution role pulls the image and reads the two secrets. The task role is what the server runs as${cloudfront ? ': the CDN step gives it `cloudfront:CreateInvalidation`' : ''}.`],
    code: [
      file('json', 'ecs-trust.json', json({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'ecs-tasks.amazonaws.com' }, Action: 'sts:AssumeRole' }] })),
      file('json', 'read-secrets.json', json({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: 'arn:aws:secretsmanager:<region>:<account>:secret:companyflags/*' }] })),
      bash(lines(
        FILL('read-secrets.json'),
        'aws iam create-role --role-name companyflags-execution --assume-role-policy-document file://ecs-trust.json',
        'aws iam attach-role-policy --role-name companyflags-execution \\',
        '  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy',
        'aws iam put-role-policy --role-name companyflags-execution --policy-name read-secrets --policy-document file://read-secrets.json',
        'aws iam create-role --role-name companyflags-task --assume-role-policy-document file://ecs-trust.json',
      )),
    ],
  }));

  const names = c.cdnHost && c.cdn === 'cloudflare' ? ` --subject-alternative-names ${cdnName(c)}` : '';
  steps.push(step('Make the load balancer', {
    prose: [
      'An ALB in the public subnets: 443 with a TLS 1.3 policy, 80 redirecting to 443, and HSTS added at the listener (the server sends none). The target group checks `/healthz` and drains in 30 seconds, not the default 300.',
      `Keep the idle timeout at 60 seconds, below the server’s 65. \`FF_TRUSTED_PROXIES\` is the CIDRs of the subnets the ALB is in, here \`${ALB_SUBNETS}\`: change them to yours. Don’t set \`FF_CLIENT_IP_HEADER\`.`,
    ],
    code: [bash(lines(
      `CERT=$(aws acm request-certificate --region $R --domain-name ${c.domain}${names} --validation-method DNS --query CertificateArn --output text)`,
      '# add the CNAME record ACM asks for (aws acm describe-certificate), then wait until it is issued',
      'aws acm wait certificate-validated --region $R --certificate-arn $CERT',
      'ALB=$(aws elbv2 create-load-balancer --region $R --name companyflags --type application --scheme internet-facing \\',
      "  --subnets subnet-pub-a subnet-pub-b subnet-pub-c --security-groups sg-alb --query 'LoadBalancers[0].LoadBalancerArn' --output text)",
      'TG=$(aws elbv2 create-target-group --region $R --name companyflags --protocol HTTP --protocol-version HTTP1 --port 8787 \\',
      "  --target-type ip --vpc-id vpc-id --health-check-path /healthz --query 'TargetGroups[0].TargetGroupArn' --output text)",
      'aws elbv2 modify-target-group-attributes --region $R --target-group-arn $TG --attributes Key=deregistration_delay.timeout_seconds,Value=30',
      'HTTPS=$(aws elbv2 create-listener --region $R --load-balancer-arn $ALB --protocol HTTPS --port 443 --certificates CertificateArn=$CERT \\',
      "  --ssl-policy ELBSecurityPolicy-TLS13-1-2-2021-06 --default-actions Type=forward,TargetGroupArn=$TG --query 'Listeners[0].ListenerArn' --output text)",
      'aws elbv2 create-listener --region $R --load-balancer-arn $ALB --protocol HTTP --port 80 \\',
      "  --default-actions 'Type=redirect,RedirectConfig={Protocol=HTTPS,Port=443,StatusCode=HTTP_301}'",
      'aws elbv2 modify-listener-attributes --region $R --listener-arn $HTTPS \\',
      '  --attributes \'[{"Key":"routing.http.response.strict_transport_security.header_value","Value":"max-age=31536000; includeSubDomains"}]\'',
    ))],
  }));

  if (cloudfront) {
    const fn = lines(
      '// cdn-only.js: the default behavior answers 404, so the CDN host serves /cdn/v1/flags/* only',
      'function handler(event) {',
      "  return { statusCode: 404, statusDescription: 'Not Found' };",
      '}',
    );
    steps.push(step('Put CloudFront in front', {
      prose: [
        `A distribution for \`${cdnName(c)}\`, with its origin \`${c.domain}\`, caches the CDN files only. OFREP and its streams go straight to the ALB. Make it in the console or your IaC with these settings:`,
      ],
      list: [
        'Certificate: in ACM in `us-east-1` (below). Origin: `' + c.domain + '` (not the ALB’s own DNS name), HTTPS only, TLS 1.2 or later.',
        'Cache tags: a `CacheTagConfig` with header name `Cache-Tag`, set when you make the distribution.',
        'Behavior `/cdn/v1/flags/*`: redirect to HTTPS; `GET`, `HEAD`, `OPTIONS`; a custom cache policy with Min TTL 0, Default TTL 0, Max TTL 86400, no headers, cookies or query strings in the key, gzip and Brotli on; origin request policy `CORS-S3Origin`.',
        'Default behavior `*`: the function below on viewer request, so nothing else is reachable through the CDN host.',
        'Custom error response for `404`: error caching minimum TTL 0.',
      ],
      code: [
        file('js', 'cdn-only.js', fn),
        bash(lines(
          `aws acm request-certificate --region us-east-1 --domain-name ${cdnName(c)} --validation-method DNS`,
          'aws cloudfront create-function --name companyflags-cdn-only --function-code fileb://cdn-only.js \\',
          '  --function-config Comment="404 outside /cdn/v1/flags",Runtime=cloudfront-js-2.0',
          'aws cloudfront publish-function --name companyflags-cdn-only \\',
          '  --if-match $(aws cloudfront describe-function --name companyflags-cdn-only --query ETag --output text)',
        )),
        file('json', 'invalidate.json', json({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'cloudfront:CreateInvalidation', Resource: 'arn:aws:cloudfront::<account>:distribution/<distribution id>' }] })),
        bash(lines(
          'DIST=<distribution id>    # from the distribution you made',
          FILL('invalidate.json') + ' && sed -i.bak "s/<distribution id>/$DIST/g" invalidate.json',
          'aws iam put-role-policy --role-name companyflags-task --policy-name invalidate --policy-document file://invalidate.json',
        ), 'Let the server purge'),
      ],
      after: [
        '**Purge on publish:** `FF_CLOUDFRONT_DISTRIBUTION_ID` in the task definition turns it on, with the task role: no token is stored. It invalidates by tag, so a publish drops only the files it changed.',
        `Apps read CDN files from \`https://${cdnName(c)}\`. See [CDN](/integrations/cdn-files) for what CloudFront honours.`,
      ],
    }));
  }

  const environment = plain(settings).map((s) => ({ name: s.name, value: s.value }));
  const secrets = [
    { name: 'FF_SECRET', valueFrom: SECRET('companyflags/prod', 'FF_SECRET') },
    { name: 'DATABASE_URL', valueFrom: SECRET('companyflags/prod', 'DATABASE_URL') },
    ...(c.metrics ? [{ name: 'FF_METRICS_TOKEN', valueFrom: SECRET('companyflags/prod', 'FF_METRICS_TOKEN') }] : []),
  ];
  const service = {
    ...fargate('companyflags', '512', '1024'),
    containerDefinitions: [{
      name: 'companyflags', image: REPO,
      portMappings: [{ containerPort: 8787, protocol: 'tcp' }],
      environment, secrets,
      healthCheck: { command: ['CMD-SHELL', 'wget -qO- http://127.0.0.1:8787/healthz >/dev/null || exit 1'], interval: 30, timeout: 5, retries: 3, startPeriod: 30 },
      stopTimeout: 30,
      logConfiguration: logs,
    }],
  };
  const migrate = {
    ...fargate('companyflags-migrate', '256', '512'),
    containerDefinitions: [{
      name: 'companyflags', image: REPO, command: ['companyflags', 'migrate'],
      environment: [{ name: 'FF_DB_POOL', value: '2' }, { name: 'FF_DATABASE_CA_FILE', value: CA }],
      secrets: [
        { name: 'DATABASE_URL', valueFrom: SECRET('companyflags/migrate', 'DATABASE_URL') },
        { name: 'FF_SECRET', valueFrom: SECRET('companyflags/prod', 'FF_SECRET') },
      ],
      logConfiguration: logs,
    }],
  };

  steps.push(step('Run the migrations', {
    prose: [
      'Every service task runs with `FF_MIGRATE=off`. A one-off task runs `companyflags migrate` first, as `flags_owner`, and again before each upgrade ([Upgrading](/operate/upgrading#several-servers-or-a-rolling-upgrade)).',
    ],
    code: [
      file('json', 'migrate-task.json', json(migrate)),
      bash(lines(
        FILL('migrate-task.json'),
        'aws ecs create-cluster --region $R --cluster-name companyflags',
        'aws logs create-log-group --region $R --log-group-name /ecs/companyflags',
        'aws logs put-retention-policy --region $R --log-group-name /ecs/companyflags --retention-in-days 30',
        'aws ecs register-task-definition --region $R --cli-input-json file://migrate-task.json',
        'TASK=$(aws ecs run-task --region $R --cluster companyflags --launch-type FARGATE --task-definition companyflags-migrate \\',
        `  ${NETWORK} \\`,
        "  --query 'tasks[0].taskArn' --output text)",
        'aws ecs wait tasks-stopped --region $R --cluster companyflags --tasks "$TASK"',
        "aws ecs describe-tasks --region $R --cluster companyflags --tasks \"$TASK\" --query 'tasks[0].containers[0].exitCode'   # 0",
      )),
    ],
  }));

  steps.push(step('Start the service', {
    prose: [
      'Two tasks or more, in at least two zones, replaced one at a time with the circuit breaker on. With at most 4 tasks, a deploy needs `2 × 4 × 10 + 2 + 10 = 92` connections: check `SHOW max_connections;`.',
      cloudfront ? 'Put your distribution’s ID in `FF_CLOUDFRONT_DISTRIBUTION_ID` before you register it.' : '',
    ].filter(Boolean),
    code: [
      file('json', 'companyflags-task.json', json(service)),
      bash(lines(
        FILL('companyflags-task.json'),
        cloudfront && 'sed -i.bak "s/<distribution id>/$DIST/g" companyflags-task.json',
        'aws ecs register-task-definition --region $R --cli-input-json file://companyflags-task.json',
        'aws ecs create-service --region $R --cluster companyflags --service-name companyflags --task-definition companyflags \\',
        '  --desired-count 2 --launch-type FARGATE --health-check-grace-period-seconds 60 \\',
        `  ${NETWORK} \\`,
        '  --load-balancers targetGroupArn=$TG,containerName=companyflags,containerPort=8787 \\',
        "  --deployment-configuration 'minimumHealthyPercent=100,maximumPercent=200,deploymentCircuitBreaker={enable=true,rollback=true}'",
        'aws ecs wait services-stable --region $R --cluster companyflags --services companyflags',
      )),
    ],
    after: ['ECS has no separate readiness check: the container and the ALB both check `/healthz`. Watch `/readyz` with a CloudWatch Synthetics canary' + (c.metrics ? ' or `/metrics`.' : '.')],
  }));

  steps.push(step('Point DNS at it', {
    prose: [`\`${c.domain}\` is an alias to the ALB${c.cdnHost ? `, and \`${cdnName(c)}\` points at ${cloudfront ? 'the CloudFront distribution' : 'Cloudflare (the next steps)'}` : ''}.`],
    code: [bash(`aws elbv2 describe-load-balancers --region $R --names companyflags --query 'LoadBalancers[0].DNSName' --output text`)],
  }));

  steps.push(adminStep(c, 'CloudWatch Logs', 'aws logs tail /ecs/companyflags --region $R --since 1h | grep /api/setup/'));
  if (c.signIn === 'sso') steps.push(ssoStep(c));
  if (cloudfront) {
    steps.push(step('Check the CDN', {
      prose: ['Publish a change, then check that the next request is a miss. Invalidations usually take effect in seconds.'],
      code: [cdnCheck(c, '`x-cache: Hit from cloudfront`')],
    }));
  }
  if (c.cdn === 'cloudflare') {
    const s = cloudflareStep(c, 'the ALB (a CNAME to its DNS name; its certificate covers both names)');
    s.code.push(cdnCheck(c, '`cf-cache-status: HIT`'));
    steps.push(s);
  }
  steps.push(checklistStep(c, ['The stop timeout is 30 seconds, above the 5 the streams need: [Monitoring → Shutdown](/operate/monitoring#shutdown).']));
  steps.push(recipeStep(c));

  return {
    choices: c,
    summary: `AWS: ECS on Fargate behind an ALB, RDS for PostgreSQL 18, Secrets Manager${cloudfront ? ', CloudFront on its own host' : c.cdn === 'cloudflare' ? ', Cloudflare on its own host' : ''}, at https://${c.domain}.`,
    steps,
    settings,
    recipe: recipe(c),
  };
}
