// The CloudFront and Cloud CDN purges (plugins/cloudfront.ts, plugins/cloudCdn.ts): SigV4 against AWS's own examples,
// AWS's credential chain and Google's metadata token (which one, in what order, kept until near expiry), the
// requests each sends for a publish's tags (cdn.ts purgeTagsFor, whatever their text), too many tags, and failures
// kept on the publish as the Cloudflare plugin's are. AWS and Google here are fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credentialChain, REFRESH_BEFORE_MS, signV4 } from '../server/aws.ts';
import { purgeTagsFor } from '../server/cdn.ts';
import { cloudCdn, cloudfront, type PluginContext, type PluginParts } from '../server/plugins/index.ts';
import { CLOUD_CDN_MAX_CALLS, CLOUD_CDN_TAGS_PER_CALL, googleToken } from '../server/plugins/cloudCdn.ts';
import { invalidationBatch } from '../server/plugins/cloudfront.ts';
import { boot, builtIns } from './helpers.ts';

type Call = { url: string; method: string; headers: Record<string, string>; body: string };
/** A fake fetch: each request is kept, and answered by `answer` (200 '{}' unless it says otherwise). */
function fakeFetch(answer: (c: Call) => Response | Promise<Response> = () => new Response('{}')) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const c = { url: String(url), method: init.method ?? 'GET', headers, body: typeof init.body === 'string' ? init.body : '' };
    calls.push(c);
    return answer(c);
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const setUp = async (p: { setup: (ctx: PluginContext) => PluginParts | Promise<PluginParts> }, env: Record<string, string> = {}) => {
  const logs: string[] = [];
  const parts = await p.setup({ env, log: (m: string) => logs.push(m) } as unknown as PluginContext);
  return { parts, logs };
};
const tagsOf = (xml: string) => [...xml.matchAll(/<Path>#([^<]*)<\/Path>/g)].map((m) => m[1]);
const scopeOf = (n: number) => ({ entities: Array.from({ length: n }, (_, i) => `acme-${i}`), links: [] });

// ---- SigV4 ----

const EXAMPLE = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
const AT = new Date('2015-08-30T12:36:00Z');

test('SigV4: AWS’s documented examples (the test suite’s get-vanilla and query order, and IAM ListUsers)', () => {
  const vanilla = signV4({ method: 'GET', url: 'https://example.amazonaws.com/' }, EXAMPLE, { region: 'us-east-1', service: 'service' }, AT);
  assert.equal(
    vanilla.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
  );
  assert.equal(vanilla['x-amz-date'], '20150830T123600Z');
  assert.equal(vanilla.host, undefined, 'host is signed, and left to fetch');

  const ordered = signV4(
    { method: 'GET', url: 'https://example.amazonaws.com/?Param2=value2&Param1=value1' },
    EXAMPLE,
    { region: 'us-east-1', service: 'service' },
    AT,
  );
  assert.match(ordered.authorization, /Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500$/);

  const iam = signV4(
    {
      method: 'GET',
      url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
    },
    EXAMPLE,
    { region: 'us-east-1', service: 'iam' },
    AT,
  );
  assert.equal(
    iam.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7',
  );
});

test('SigV4: a session token is sent and signed; the body is part of the signature', () => {
  const where = { region: 'us-east-1', service: 'cloudfront' };
  const a = signV4({ method: 'POST', url: 'https://cloudfront.amazonaws.com/x', body: 'a' }, { ...EXAMPLE, sessionToken: 'tok' }, where, AT);
  assert.equal(a['x-amz-security-token'], 'tok');
  assert.match(a.authorization, /SignedHeaders=host;x-amz-date;x-amz-security-token,/);
  const b = signV4({ method: 'POST', url: 'https://cloudfront.amazonaws.com/x', body: 'b' }, { ...EXAMPLE, sessionToken: 'tok' }, where, AT);
  assert.notEqual(a.authorization, b.authorization);
});

// ---- AWS credentials ----

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
const expiring = (ms: number) => ({ AccessKeyId: 'ASIA1', SecretAccessKey: 'secret1', Token: 'session1', Expiration: new Date(ms).toISOString() });

test('credentials: the environment’s keys come first, with no call anywhere', async () => {
  const f = fakeFetch();
  const get = credentialChain({
    env: { AWS_ACCESS_KEY_ID: 'AKIA1', AWS_SECRET_ACCESS_KEY: 's', AWS_SESSION_TOKEN: 't', AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/creds' },
    fetch: f.fn,
  });
  assert.deepEqual(await get(), { accessKeyId: 'AKIA1', secretAccessKey: 's', sessionToken: 't' });
  assert.equal(f.calls.length, 0);
});

test('credentials: the container’s endpoint (an ECS task role), kept until shortly before they expire, one call at a time', async () => {
  let now = 1_000_000;
  const f = fakeFetch(() => json(expiring(now + 60 * 60_000)));
  const get = credentialChain({ env: { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/abc' }, fetch: f.fn, now: () => now });
  const [a, b] = await Promise.all([get(), get()]);
  assert.equal(f.calls.length, 1, 'two purges at once share one call');
  assert.equal(f.calls[0].url, 'http://169.254.170.2/v2/credentials/abc');
  assert.deepEqual([a.accessKeyId, a.secretAccessKey, a.sessionToken], ['ASIA1', 'secret1', 'session1']);
  assert.equal(a, b);
  now += 60 * 60_000 - REFRESH_BEFORE_MS - 1000;
  await get();
  assert.equal(f.calls.length, 1, 'still kept');
  now += 2000;
  await get();
  assert.equal(f.calls.length, 2, 'fetched again near expiry');
});

test('credentials: the full URI with a token file (EKS Pod Identity); plain HTTP elsewhere is refused', async () => {
  const f = fakeFetch(() => json(expiring(Date.now() + 3_600_000)));
  const get = credentialChain({
    env: {
      AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.23/v1/credentials',
      AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: '/var/run/token',
      AWS_CONTAINER_AUTHORIZATION_TOKEN: 'not-this',
    },
    fetch: f.fn,
    readFile: async (p) => (p === '/var/run/token' ? 'from-file\n' : ''),
  });
  await get();
  assert.equal(f.calls[0].url, 'http://169.254.170.23/v1/credentials');
  assert.equal(f.calls[0].headers.authorization, 'from-file', 'the file wins over the variable');

  const bad = credentialChain({ env: { AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://evil.example.com/creds' }, fetch: f.fn });
  await assert.rejects(bad(), /must be HTTPS/);
  assert.equal(f.calls.length, 1);
});

test('credentials: a web identity token (EKS IRSA) is exchanged with STS, in the region', async () => {
  const xml =
    '<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials><AccessKeyId>ASIAW</AccessKeyId>' +
    '<SecretAccessKey>sw</SecretAccessKey><SessionToken>tw&amp;1</SessionToken><Expiration>2099-01-01T00:00:00Z</Expiration></Credentials>' +
    '</AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>';
  const f = fakeFetch(() => new Response(xml));
  const get = credentialChain({
    env: {
      AWS_WEB_IDENTITY_TOKEN_FILE: '/t',
      AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/flags',
      AWS_REGION: 'eu-west-1',
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/x',
    },
    fetch: f.fn,
    readFile: async () => 'jwt',
  });
  const c = await get();
  assert.deepEqual([c.accessKeyId, c.secretAccessKey, c.sessionToken], ['ASIAW', 'sw', 'tw&1']);
  assert.equal(f.calls[0].url, 'https://sts.eu-west-1.amazonaws.com/');
  const form = new URLSearchParams(f.calls[0].body);
  assert.deepEqual(
    [form.get('Action'), form.get('RoleArn'), form.get('WebIdentityToken')],
    ['AssumeRoleWithWebIdentity', 'arn:aws:iam::123456789012:role/flags', 'jwt'],
  );
  await get();
  assert.equal(f.calls.length, 1, 'kept');
});

test('credentials: else the instance’s metadata, with an IMDSv2 token; not when it’s turned off', async () => {
  const f = fakeFetch((c) => {
    if (c.url.endsWith('/latest/api/token')) return new Response('imds-token');
    if (c.url.endsWith('/security-credentials/')) return new Response('flags-role\n');
    return json({ Code: 'Success', ...expiring(Date.now() + 3_600_000) });
  });
  const c = await credentialChain({ env: {}, fetch: f.fn })();
  assert.equal(c.accessKeyId, 'ASIA1');
  assert.deepEqual(
    f.calls.map((x) => `${x.method} ${x.url}`),
    [
      'PUT http://169.254.169.254/latest/api/token',
      'GET http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      'GET http://169.254.169.254/latest/meta-data/iam/security-credentials/flags-role',
    ],
  );
  assert.equal(f.calls[0].headers['x-aws-ec2-metadata-token-ttl-seconds'], '21600');
  assert.equal(f.calls[2].headers['x-aws-ec2-metadata-token'], 'imds-token');

  const off = fakeFetch();
  await assert.rejects(credentialChain({ env: { AWS_EC2_METADATA_DISABLED: 'true' }, fetch: off.fn })(), /no AWS credentials/);
  assert.equal(off.calls.length, 0);
  const nowhere = fakeFetch(() => {
    throw new TypeError('fetch failed');
  });
  await assert.rejects(credentialChain({ env: {}, fetch: nowhere.fn })(), /no AWS credentials: set AWS_ACCESS_KEY_ID/);
});

// ---- cloudfront() ----

const AWS_ENV = { AWS_ACCESS_KEY_ID: 'AKIATEST', AWS_SECRET_ACCESS_KEY: 'secret', AWS_SESSION_TOKEN: 'session' };

test('cloudfront(): one signed CreateInvalidation with the publish’s tags as #tag paths, and a new caller reference each time', async () => {
  const f = fakeFetch(() => new Response('<Invalidation/>', { status: 201 }));
  const { parts, logs } = await setUp(cloudfront({ distributionId: 'E2QWRUHAPOMQZL', fetch: f.fn }), AWS_ENV);
  assert.equal(parts.purges, true);
  assert.deepEqual(await parts.warnings!(), []);
  const scope = { entities: ['acme', 'globex'], links: ['lumen'] };
  assert.equal(await parts.onPublish!('prod', scope), 'purged');
  assert.equal(await parts.onPublish!('prod', null), 'purged');

  const [first, second] = f.calls;
  assert.equal(first.url, 'https://cloudfront.amazonaws.com/2020-05-31/distribution/E2QWRUHAPOMQZL/invalidation');
  assert.equal(first.method, 'POST');
  assert.equal(first.headers['content-type'], 'application/xml');
  assert.equal(first.headers['x-amz-security-token'], 'session');
  assert.match(
    first.headers.authorization,
    /^AWS4-HMAC-SHA256 Credential=AKIATEST\/\d{8}\/us-east-1\/cloudfront\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/,
  );
  const tags = purgeTagsFor('prod', scope);
  assert.deepEqual(tagsOf(first.body), tags);
  assert.match(first.body, new RegExp(`<Quantity>${tags.length}</Quantity>`));
  assert.deepEqual(tagsOf(second.body), purgeTagsFor('prod', null), 'anyone’s answers: the environment’s tag');
  const ref = (b: string) => /<CallerReference>([^<]+)<\/CallerReference>/.exec(b)![1];
  assert.notEqual(ref(first.body), ref(second.body));
  assert.match(logs[0], /invalidated \d+ cache tags? in CloudFront/);
});

test('cloudfront(): nothing to purge sends nothing; too many tags send the environment’s; a tag is escaped in the XML', async () => {
  const f = fakeFetch(() => new Response('', { status: 201 }));
  const { parts } = await setUp(cloudfront({ distributionId: 'E2QWRUHAPOMQZL', fetch: f.fn }), AWS_ENV);
  assert.equal(await parts.onPublish!('prod', { entities: [], links: [] }), 'off');
  assert.equal(f.calls.length, 0);
  assert.equal(await parts.onPublish!('prod', scopeOf(500)), 'purged');
  assert.deepEqual(tagsOf(f.calls[0].body), purgeTagsFor('prod', null));
  assert.match(invalidationBatch(['a&b<c>'], 'r'), /<Path>#a&amp;b&lt;c&gt;<\/Path>/);
});

test('cloudfront(): TooManyInvalidationsInProgress and other refusals throw with AWS’s words; so do missing credentials', async () => {
  const busy =
    '<?xml version="1.0"?><ErrorResponse xmlns="http://cloudfront.amazonaws.com/doc/2020-05-31/"><Error><Type>Sender</Type>' +
    '<Code>TooManyInvalidationsInProgress</Code><Message>Processing your request will cause you to exceed the maximum number of in-progress wildcard invalidations.</Message></Error></ErrorResponse>';
  let answer = new Response(busy, { status: 400 });
  const f = fakeFetch(() => answer);
  const { parts } = await setUp(cloudfront({ distributionId: 'E2QWRUHAPOMQZL', fetch: f.fn }), AWS_ENV);
  await assert.rejects(parts.onPublish!('prod', null), /^Error: CloudFront said 400 TooManyInvalidationsInProgress: Processing your request/);
  answer = new Response(
    '<ErrorResponse><Error><Code>AccessDenied</Code><Message>User is not authorized to perform: cloudfront:CreateInvalidation</Message></Error></ErrorResponse>',
    { status: 403 },
  );
  await assert.rejects(parts.onPublish!('prod', null), /CloudFront said 403 AccessDenied: User is not authorized to perform: cloudfront:CreateInvalidation/);

  const none = fakeFetch(() => new Response('', { status: 500 }));
  const { parts: bare } = await setUp(cloudfront({ distributionId: 'E2QWRUHAPOMQZL', fetch: none.fn }), { AWS_EC2_METADATA_DISABLED: 'true' });
  await assert.rejects(bare.onPublish!('prod', null), /no AWS credentials/);
  assert.equal(none.calls.length, 0);
});

test('cloudfront(): the distribution from FF_CLOUDFRONT_DISTRIBUTION_ID; without one, or a wrong one, a warning and no purge', async () => {
  const f = fakeFetch(() => new Response('', { status: 201 }));
  const { parts: fromEnv } = await setUp(cloudfront({ fetch: f.fn }), { ...AWS_ENV, FF_CLOUDFRONT_DISTRIBUTION_ID: 'EDFDVBD6EXAMPLE' });
  await fromEnv.onPublish!('dev', null);
  assert.match(f.calls[0].url, /\/distribution\/EDFDVBD6EXAMPLE\/invalidation$/);

  const { parts: missing } = await setUp(cloudfront({ fetch: f.fn }), AWS_ENV);
  assert.match((await missing.warnings!())[0], /no distribution ID .*FF_CLOUDFRONT_DISTRIBUTION_ID/);
  assert.equal(await missing.onPublish!('dev', null), 'off');
  const { parts: wrong } = await setUp(cloudfront({ distributionId: 'my distribution', fetch: f.fn }), AWS_ENV);
  assert.match((await wrong.warnings!())[0], /isn’t a distribution ID/);
  assert.equal(f.calls.length, 1);
});

// ---- cloudCdn() ----

test('cloudCdn(): invalidateCache on the URL map with the publish’s tags and the host, with the metadata server’s token, kept', async () => {
  const f = fakeFetch((c) =>
    c.url.includes('computeMetadata')
      ? json({ access_token: 'ya29.meta', expires_in: 3599, token_type: 'Bearer' })
      : json({ kind: 'compute#operation', status: 'DONE' }),
  );
  const { parts, logs } = await setUp(cloudCdn({ project: 'acme-flags', urlMap: 'flags-lb', host: 'cdn.flags.example.com', fetch: f.fn }));
  assert.equal(parts.purges, true);
  assert.deepEqual(await parts.warnings!(), []);
  const scope = { entities: ['acme'], links: ['globex'] };
  assert.equal(await parts.onPublish!('prod', scope), 'purged');
  assert.equal(await parts.onPublish!('prod', null), 'purged');

  const meta = f.calls.filter((c) => c.url.includes('computeMetadata'));
  assert.equal(meta.length, 1, 'the token is kept');
  assert.equal(meta[0].url, 'http://metadata.google.internal/computeMetadata/v1/instance/service-account/default/token');
  assert.equal(meta[0].headers['metadata-flavor'], 'Google');
  const calls = f.calls.filter((c) => !c.url.includes('computeMetadata'));
  assert.equal(calls[0].url, 'https://compute.googleapis.com/compute/v1/projects/acme-flags/global/urlMaps/flags-lb/invalidateCache');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.authorization, 'Bearer ya29.meta');
  assert.deepEqual(JSON.parse(calls[0].body), { host: 'cdn.flags.example.com', cacheTags: purgeTagsFor('prod', scope) });
  assert.deepEqual(JSON.parse(calls[1].body).cacheTags, purgeTagsFor('prod', null));
  assert.match(logs[0], /in Cloud CDN \(flags-lb, cdn\.flags\.example\.com\)/);
});

test('cloudCdn(): at most 10 tags a call, split; past a few calls, the environment’s tag', async () => {
  const f = fakeFetch(() => json({}));
  const { parts } = await setUp(cloudCdn({ project: 'acme-flags', urlMap: 'flags-lb', fetch: f.fn }), { GOOGLE_OAUTH_ACCESS_TOKEN: 'ya29.local' });
  const scope = scopeOf(25);
  const tags = purgeTagsFor('prod', scope);
  assert.ok(tags.length > CLOUD_CDN_TAGS_PER_CALL, 'enough tags to split');
  await parts.onPublish!('prod', scope);
  assert.ok(
    f.calls.every((c) => c.headers.authorization === 'Bearer ya29.local' && !c.url.includes('computeMetadata')),
    'GOOGLE_OAUTH_ACCESS_TOKEN: no metadata server',
  );
  assert.ok(f.calls.every((c) => JSON.parse(c.body).cacheTags.length <= CLOUD_CDN_TAGS_PER_CALL));
  assert.equal(JSON.parse(f.calls[0].body).host, undefined, 'no host: every host of the URL map');
  if (tags.length <= CLOUD_CDN_TAGS_PER_CALL * CLOUD_CDN_MAX_CALLS) {
    assert.deepEqual(
      f.calls.flatMap((c) => JSON.parse(c.body).cacheTags),
      tags,
    );
    assert.equal(f.calls.length, Math.ceil(tags.length / CLOUD_CDN_TAGS_PER_CALL));
  } else {
    assert.deepEqual(
      f.calls.map((c) => JSON.parse(c.body).cacheTags),
      [purgeTagsFor('prod', null)],
    );
  }

  f.calls.length = 0;
  await parts.onPublish!('prod', scopeOf(500));
  assert.deepEqual(
    f.calls.map((c) => JSON.parse(c.body).cacheTags),
    [purgeTagsFor('prod', null)],
  );
  f.calls.length = 0;
  assert.equal(await parts.onPublish!('prod', { entities: [], links: [] }), 'off');
  assert.equal(f.calls.length, 0);
});

test('cloudCdn(): a refusal throws with Google’s words; a missing project or URL map is a warning, and no purge', async () => {
  const f = fakeFetch(() =>
    json({ error: { code: 403, message: "Required 'compute.urlMaps.invalidateCache' permission for 'projects/acme-flags/global/urlMaps/flags-lb'" } }, 403),
  );
  const { parts } = await setUp(cloudCdn({ fetch: f.fn }), {
    FF_CLOUD_CDN_PROJECT: 'acme-flags',
    FF_CLOUD_CDN_URL_MAP: 'flags-lb',
    GOOGLE_OAUTH_ACCESS_TOKEN: 't',
  });
  await assert.rejects(parts.onPublish!('dev', null), /^Error: Cloud CDN said 403: Required 'compute\.urlMaps\.invalidateCache' permission/);

  const { parts: missing } = await setUp(cloudCdn({ project: 'acme-flags', fetch: f.fn }));
  assert.match((await missing.warnings!())[0], /no urlMap \(FF_CLOUD_CDN_URL_MAP\)/);
  assert.equal(await missing.onPublish!('dev', null), 'off');
  const { parts: wrong } = await setUp(cloudCdn({ project: 'Acme Flags', urlMap: 'flags-lb', fetch: f.fn }));
  assert.match((await wrong.warnings!())[0], /isn’t a project ID/);
  assert.equal(f.calls.length, 1);
});

test('the metadata token is fetched again shortly before it expires', async () => {
  let now = 0;
  let n = 0;
  const f = fakeFetch(() => json({ access_token: `t${++n}`, expires_in: 3600 }));
  const token = googleToken({ env: {}, fetch: f.fn, now: () => now });
  assert.equal(await token(), 't1');
  now = 3600_000 - 6 * 60_000;
  assert.equal(await token(), 't1');
  now = 3600_000 - 4 * 60_000;
  assert.equal(await token(), 't2');
});

// ---- on a server ----

test('on a server: a publish invalidates CloudFront; a failure is kept on the publish and /readyz warns of it', async (c) => {
  let status = 201;
  const f = fakeFetch(
    () =>
      new Response(status === 201 ? '' : '<ErrorResponse><Error><Code>TooManyInvalidationsInProgress</Code><Message>busy</Message></Error></ErrorResponse>', {
        status,
      }),
  );
  const t = await boot({ plugins: [...builtIns(), cloudfront({ fetch: f.fn })], env: { ...AWS_ENV, FF_CLOUDFRONT_DISTRIBUTION_ID: 'E2QWRUHAPOMQZL' } });
  c.after(() => t.stop());
  const last = async () => {
    for (let i = 0; i < 100; i++) {
      const row = (
        await t.db.query<{ purged: string | null; error: string | null }>(
          `select purged_at as purged, last_error as error from publish_queue order by id desc limit 1`,
        )
      ).rows[0];
      if (row.purged || row.error) return row;
      await new Promise((r) => setTimeout(r, 10));
    }
    return { purged: null, error: null };
  };
  assert.ok((await t.as('alice').get('/meta')).json.plugins.includes('cloudfront'));
  assert.equal((await t.editBase('max_upload_mb', 'dev', (l) => ({ ...l, defaultVariation: 'enterprise' }))).status, 200);
  assert.ok((await last()).purged);
  assert.ok(f.calls.some((x) => x.url.endsWith('/distribution/E2QWRUHAPOMQZL/invalidation')));

  status = 400;
  assert.equal((await t.editBase('max_upload_mb', 'dev', (l) => ({ ...l, defaultVariation: 'standard' }))).status, 200, 'the publish still goes out');
  assert.match((await last()).error ?? '', /^purge: cloudfront: CloudFront said 400 TooManyInvalidationsInProgress/);
  const ready = await t.app.request('/readyz');
  assert.equal(ready.status, 200);
  const body = (await ready.json()) as { environments: Record<string, { purgeFailing: boolean }>; warnings: string[] };
  assert.equal(body.environments.dev.purgeFailing, true);
  assert.ok(body.warnings.some((w) => /CDN purge after dev’s last publish didn’t go through/.test(w)));
});

test('on a server: cloudCdn() without its URL map says so in /readyz', async (c) => {
  const t = await boot({ plugins: [...builtIns(), cloudCdn({ fetch: fakeFetch().fn })], env: { FF_CLOUD_CDN_PROJECT: 'acme-flags' } });
  c.after(() => t.stop());
  const body = (await (await t.app.request('/readyz')).json()) as { warnings: string[] };
  assert.ok(body.warnings.some((w) => /cloudCdn\(\): no urlMap/.test(w)));
});
