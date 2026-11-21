// What the docs, the README and the landing page promise about approvals and releases matches what the server does:
// on call turns a release off at once (layers.ts checkBreakGlass), pausing leaves entities' own settings alone
// (release.ts stillServing), environments start at 0 approvals (schema.sql), and a solo admin can't meet 1 approval
// (policy.ts approvalsShortfall).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\s+/g, ' ');
const releases = read('docs/content/docs/guide/releases.md');
const approvals = read('docs/content/docs/guide/approvals.md');

test('releases: on call turns a release off at once, and pause names who keeps it', () => {
  assert.doesNotMatch(releases, /off in a protected environment is a reviewed request, for on call too/);
  assert.match(releases, /On call and admins can turn it off, or pause it, at once with a reason/);
  assert.match(releases, /\*\*Turn off now\*\*/);
  assert.match(releases, /Pause leaves entities whose own settings serve the new value on it/);
  assert.match(approvals, /Everyone is back on the old value except entities whose own settings serve the new value/);
  assert.doesNotMatch(approvals, /so everyone is back on the old value, and the % is kept/);
});

test('approvals are promised only where an environment requires them', () => {
  assert.doesNotMatch(read('README.md'), /turning one on in production still needs an approval/);
  assert.match(read('README.md'), /where an environment requires approval, turning one on there is a request/);
  const landing = read('docs/components/landing/landing.tsx');
  assert.doesNotMatch(landing, /Production can require an approval/);
  assert.match(landing, /where an environment requires approval, a push makes requests there/);
});

test('the quickstart starts Production at 0 approvals, and says when to raise it', () => {
  const quickstart = read('docs/content/docs/guide/quickstart.md');
  assert.doesNotMatch(quickstart, /Production with 1 approval/);
  assert.match(quickstart, /Leave \*\*Approvals needed\*\* at 0 for both while you are the only person/);
  assert.match(quickstart, /Once you invite a second person who reviews .* raise Production to 1/);
});

test('the Integrations pages say "integration", never "plugin", outside code and the link to Writing a Plugin', () => {
  const dir = 'docs/content/docs/integrations';
  for (const file of readdirSync(new URL(`../${dir}`, import.meta.url))) {
    const prose = readFileSync(new URL(`../${dir}/${file}`, import.meta.url), 'utf8')
      .replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '').replace(/\]\([^)]*\)/g, ']').replace(/\[Writing a Plugin\]/g, '');
    assert.doesNotMatch(prose, /plugin/i, `${dir}/${file}`);
  }
});

test('the integrations turn on with environment variables, as server/integrations.ts reads them', () => {
  const overview = read('docs/content/docs/integrations/overview.md');
  for (const v of ['FF_INTEGRATIONS_OFF', 'FF_METRICS=on', 'FF_METRICS_TOKEN', 'FF_CLOUDFRONT_DISTRIBUTION_ID', 'FF_CLOUD_CDN_PROJECT', 'FF_CLOUD_CDN_URL_MAP']) {
    assert.ok(overview.includes(v), `integrations/overview.md names ${v}`);
  }
  for (const page of ['deploy/aws.md', 'deploy/google-cloud.md', 'deploy/azure.md', 'deploy/kubernetes.md', 'deploy/docker-compose.md']) {
    assert.doesNotMatch(read(`docs/content/docs/${page}`), /without it, the purge never runs/, page);
  }
});
