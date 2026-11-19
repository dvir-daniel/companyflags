// Sample data: a small, made-up installation to explore CompanyFeatures with. It is added through the same functions
// the console uses, so it is ordinary data (History shows it as added by "Sample data"), and only to an empty
// installation: `FF_DEMO=1` on a new database (pnpm demo), or the button on an empty console (POST /api/sample-data).
//
// Two environments (Development; Production, which needs an approval), three apps and a backend, the dimensions
// company › brand with five companies and three brands, and flags that show each part of the model: a release with
// a % of devices and group names, a kill switch, config per company that its brands follow, a value that stays in
// the app's code unless a rule sets one, and an override nobody can change.

import { randomUUID } from 'node:crypto';
import { HttpError, one, type Db } from './db.ts';
import { createEnvironment, createFlag, createProject, saveDimensions, updateEnvironment, upsertEntity } from './control.ts';
import { applyItems, type Actor } from './layers.ts';
import type { LayerDoc } from './checks.ts';

const actor: Actor = { name: 'Sample data', type: 'system' };
const ENVS = ['dev', 'prod'];
const APPS = ['web', 'ios', 'android'];

/** Whether the installation is empty: no environment, app, dimension or flag yet. */
export async function isEmpty(db: Pick<Db, 'query'>): Promise<boolean> {
  const r = await one<{ n: number }>(db as Db, `select (select count(*) from environment) + (select count(*) from project)
    + (select count(*) from dimension) + (select count(*) from flag) as n`);
  return Number(r?.n ?? 0) === 0;
}

export async function addSampleData(db: Db): Promise<void> {
  if (!(await isEmpty(db))) throw new HttpError(409, 'Sample data goes only into an empty installation: this one has environments, apps or flags already');

  // prod starts without approvals so the sample flags can be switched on there; it needs one at the end
  await createEnvironment(db, { key: 'dev', name: 'Development', minApprovals: 0 }, actor);
  await createEnvironment(db, { key: 'prod', name: 'Production', minApprovals: 0 }, actor);
  for (const key of APPS) await createProject(db, { key, kind: 'client' }, actor);
  await createProject(db, { key: 'api', kind: 'server' }, actor);

  await saveDimensions(db, [{ key: 'company', singular: 'company', plural: 'companies' }, { key: 'brand', singular: 'brand', plural: 'brands' }], actor);
  const companies: [string, string][] = [
    ['acme', 'Acme Corp'], ['globex', 'Globex'], ['initech', 'Initech'], ['umbrella', 'Umbrella Retail'], ['hooli', 'Hooli'],
  ];
  for (const [key, name] of companies) await upsertEntity(db, 'company', key, { name }, actor, true);
  const brands: [string, string, string][] = [['lumen', 'Lumen', 'globex'], ['bolt', 'Bolt', 'globex'], ['acme-kids', 'Acme Kids', 'acme']];
  for (const [key, name, parent] of brands) await upsertEntity(db, 'brand', key, { name, parent }, actor, true);

  const both = (projects: string[]) => Object.fromEntries(ENVS.map((e) => [e, projects]));
  const removeBy = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);

  await createFlag(db, {
    key: 'new_checkout', name: 'New checkout', tags: ['checkout'], valueType: 'bool', kind: 'release', owner: 'payments', removeBy,
    description: 'The new checkout, rolled out to 10% of devices, with Acme on it everywhere. Android below 5.0 never gets it.',
    variations: [{ key: 'on', value: true }, { key: 'off', value: false }],
    delivery: both(APPS),
    base: {
      enabled: true, defaultVariation: 'off',
      rules: [
        { ruleKey: randomUUID(), name: 'Android below 5.0 can’t run it', locked: true,
          conditions: [{ field: 'project', op: 'in', values: ['android'] }, { field: 'app.version', op: 'semver_lt', values: ['5.0.0'] }], serveVariation: 'off' },
        { ruleKey: randomUUID(), name: '10% of devices', conditions: [],
          split: { by: 'device.id', ranges: [{ variation: 'on', from: 0, to: 1000, group: 'new-checkout' }], outsideGroup: 'old-checkout' } },
      ],
    },
  }, actor);

  await createFlag(db, {
    key: 'payments_enabled', name: 'Payments', tags: ['payments'], valueType: 'bool', kind: 'kill_switch', owner: 'payments',
    description: 'Turns payments off everywhere at once. On call can turn it off in Production without waiting for a review.',
    variations: [{ key: 'on', value: true }, { key: 'off', value: false }],
    delivery: both([...APPS, 'api']),
    base: { enabled: true, defaultVariation: 'on', rules: [] },
  }, actor);

  await createFlag(db, {
    key: 'api_base_url', name: 'API address', tags: ['infrastructure'], valueType: 'string', kind: 'config', owner: 'platform',
    description: 'Where the apps send their requests. Globex has its own servers, and its brands follow it.',
    variations: [{ key: 'shared', value: 'https://api.example.com' }, { key: 'globex', value: 'https://globex.api.example.com' }],
    delivery: both([...APPS, 'api']),
    base: { enabled: true, defaultVariation: 'shared', rules: [] },
  }, actor);

  await createFlag(db, {
    key: 'max_upload_mb', name: 'Largest upload', tags: ['limits'], valueType: 'number', kind: 'config', owner: 'platform',
    description: 'Upload limit in MB. Enterprise companies get more.',
    variations: [{ key: 'standard', value: 100 }, { key: 'enterprise', value: 1000 }],
    delivery: both([...APPS, 'api']),
    base: {
      enabled: true, defaultVariation: 'standard',
      rules: [{ ruleKey: randomUUID(), name: 'Enterprise companies', conditions: [{ field: 'company', op: 'in', values: ['acme', 'globex'] }], serveVariation: 'enterprise' }],
    },
  }, actor);

  await createFlag(db, {
    key: 'welcome_message', name: 'Welcome message', tags: ['onboarding'], valueType: 'string', kind: 'config', owner: 'growth',
    description: 'The app keeps the text in its code, unless a rule sets one: people who speak Hebrew get theirs.',
    variations: [{ key: 'hebrew', value: 'ברוכים הבאים!' }],
    delivery: both(APPS),
    base: {
      enabled: true, defaultVariation: 'code_default',
      rules: [{ ruleKey: randomUUID(), name: 'Hebrew speakers', conditions: [{ field: 'locale.language', op: 'in', values: ['he'] }], serveVariation: 'hebrew' }],
    },
  }, actor);

  await createFlag(db, {
    key: 'theme', name: 'Theme', tags: ['brand'], valueType: 'json', kind: 'config', owner: 'design',
    description: 'Each brand’s look. Lumen has its own; everyone else gets the standard one.',
    variations: [
      { key: 'standard', value: { accent: '#0a0a0a', radius: 0 } },
      { key: 'lumen', value: { accent: '#f59e0b', radius: 12 } },
    ],
    delivery: both(['web', 'ios', 'android']),
    base: { enabled: true, defaultVariation: 'standard', rules: [] },
  }, actor);

  // Settings of their own: Globex's API address (Lumen and Bolt follow it), Lumen's theme, and Acme on the new
  // checkout everywhere.
  const own: [string, string, LayerDoc][] = [
    ['api_base_url', 'globex', { inherit: 'base_rules_then_customer_default', defaultVariation: 'globex', rules: [] }],
    ['theme', 'lumen', { inherit: 'base_rules_then_customer_default', defaultVariation: 'lumen', rules: [] }],
    ['new_checkout', 'acme', { inherit: 'base_rules_then_base_default',
      rules: [{ ruleKey: randomUUID(), name: 'Acme gets it everywhere', conditions: [], serveVariation: 'on' }] }],
  ];
  for (const env of ENVS) {
    for (const [flag, entity, doc] of own) {
      await applyItems(db, env, [{ flag, entity, expectedLayerVersion: null, proposed: doc }], actor, { comment: 'Sample data' });
    }
  }
  await updateEnvironment(db, 'prod', { minApprovals: 1 }, actor);
}
