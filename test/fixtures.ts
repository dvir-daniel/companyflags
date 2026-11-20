// Test data: environments, apps, people, the dimensions company › brand with their entities, and one flag per use
// case from the design doc.
// Only tests load it (helpers.ts boot); the app itself starts empty.

import { randomUUID } from 'node:crypto';
import type { Db } from '../server/db.ts';
import { createFlag, randomSecret } from '../server/control.ts';
import { applyItems, type Actor, type LayerDoc } from '../server/layers.ts';

const system: Actor = { name: 'seed', type: 'system' };
const uuid = () => randomUUID();

export async function fixtures(db: Db) {
  // prod needs 1 approval, set at the end: the seeded flags are on there (a flag created in an environment that
  // needs approvals starts off, control.ts createFlag)
  await db.query(`insert into environment (key, name, min_approvals, link_secret) values ('dev', 'Development', 0, $1), ('prod', 'Production', 0, $2)`, [randomSecret(), randomSecret()]);
  await db.exec(`
    insert into app_user (key, name, role) values
      ('alice', 'Alice (editor)', 'editor'), ('bob', 'Bob (approver)', 'approver'),
      ('carol', 'Carol (on-call)', 'oncall'), ('dana', 'Dana (admin)', 'admin');
    insert into project (key, kind) values
      ('android','client'), ('ios','client'), ('web','client'), ('server-wupserver','server'), ('server-ds','server');
  `);
  const customers: [string, string][] = [
    ['vandelay', 'Vandelay'], ['wonka', 'Wonka'], ['soylent', 'Soylent'], ['cyberdyne', 'CYBERDYNE'], ['oscorp', 'Oscorp'],
    ['acme', 'Acme Corp'], ['globex', 'Globex'], ['initech', 'Initech'], ['newco', 'NewCo (just signed up)'],
  ];
  await seedDimensions(db, [['company', 'company', 'companies'], ['brand', 'brand', 'brands']]);
  for (const [key, name] of customers) await db.query(`insert into entity (key, name, dimension_id) select $1, $2, id from dimension where key = 'company'`, [key, name]);
  const eu = ['soylent', 'oscorp'];
  const beta = ['wonka', 'oscorp', 'globex'];
  const enterprise = ['vandelay', 'wonka', 'soylent', 'cyberdyne'];

  const both = (projects: string[]) => ({ dev: projects, prod: projects });
  const clients = ['android', 'ios', 'web'];
  const everyone = [...clients, 'server-wupserver', 'server-ds'];
  const newCheckoutRules = { lockedOld: uuid(), split: uuid() };
  const darkRules = { beta: uuid(), split: uuid() };
  const regionRule = uuid();
  const uploadRule = uuid();

  // UC1 — key only for android
  await createFlag(db, {
    key: 'android_quick_share', name: 'Android quick share', tags: ['android', 'sharing'], valueType: 'bool', kind: 'release', owner: 'mobile-team', removeBy: '2027-03-31',
    description: 'UC1: exists only in the android app; other apps never receive the key.',
    variations: [{ key: 'on', value: true }, { key: 'off', value: false }],
    delivery: both(['android']),
    base: { enabled: true, defaultVariation: 'on', rules: [] },
  }, system);

  // UC2 + UC3 — server URL per customer; Vandelay android has its own
  await createFlag(db, {
    key: 'api_base_url', name: 'API base URL', tags: ['infra', 'networking'], valueType: 'string', kind: 'config', owner: 'platform-team',
    description: 'UC2/UC3: per-customer API host. Vandelay android gets a dedicated host; Vandelay iOS gets Vandelay\'s regular one.',
    variations: [
      { key: 'default', value: 'https://api.example.com' },
      { key: 'vandelay', value: 'https://vandelay.api.example.com' },
      { key: 'vandelay-android', value: 'https://android.vandelay.api.example.com' },
      { key: 'wonka', value: 'https://wonka.api.example.com' },
    ],
    delivery: both([...clients, 'server-wupserver']),
    base: { enabled: true, defaultVariation: 'default', rules: [] },
  }, system);

  // UC4 + UC6 — 20% android rollout, sticky by device; locked OFF below 5.0 (fails closed)
  await createFlag(db, {
    key: 'new_checkout', name: 'New checkout flow', tags: ['checkout', 'payments'], valueType: 'bool', kind: 'release', owner: 'payments-team', removeBy: '2027-01-31',
    description: 'UC4: 20% of android devices, sticky by device.id. UC6: locked off for android < 5.0 — no customer can override.',
    variations: [{ key: 'on', value: true }, { key: 'off', value: false }],
    delivery: both(clients),
    base: {
      enabled: true, defaultVariation: 'off',
      rules: [
        { ruleKey: newCheckoutRules.lockedOld, name: 'Android below 5.0 is unsupported', locked: true,
          conditions: [{ field: 'project', op: 'in', values: ['android'] }, { field: 'app.version', op: 'semver_lt', values: ['5.0.0'] }],
          serveVariation: 'off' },
        { ruleKey: newCheckoutRules.split, name: '20% of android devices',
          conditions: [{ field: 'project', op: 'in', values: ['android'] }],
          split: { by: 'device.id', ranges: [{ variation: 'on', from: 0, to: 2000 }] } },
      ],
    },
  }, system);

  // UC5 — global kill switch
  await createFlag(db, {
    key: 'payments_enabled', name: 'Payments', tags: ['payments', 'kill-switch'], valueType: 'bool', kind: 'kill_switch', owner: 'payments-team',
    description: 'UC5: kill switch for all customers at once. On-call can switch it OFF in prod without waiting for approval (break-glass).',
    variations: [{ key: 'on', value: true }, { key: 'off', value: false }],
    delivery: both(everyone),
    base: { enabled: true, defaultVariation: 'on', rules: [] },
  }, system);

  // UC7 — EU host through one Base rule, not per-customer settings
  await createFlag(db, {
    key: 'data_region_host', name: 'Data region host', tags: ['infra', 'compliance'], valueType: 'string', kind: 'config', owner: 'platform-team',
    description: 'UC7: EU customers get the EU host through one rule for everyone. CYBERDYNE is pinned to US with its own default.',
    variations: [{ key: 'us', value: 'https://us.data.example.com' }, { key: 'eu', value: 'https://eu.data.example.com' }],
    delivery: both(everyone),
    base: {
      enabled: true, defaultVariation: 'us',
      rules: [{ ruleKey: regionRule, name: 'EU customers', conditions: [{ field: 'entity', op: 'in', values: eu }], serveVariation: 'eu' }],
    },
  }, system);

  // UC8 — backend setting sent only to server-ds; Soylent gets its own value
  await createFlag(db, {
    key: 'ds_backend_config', name: 'Data service backend', tags: ['infra', 'data'], valueType: 'json', kind: 'config', owner: 'data-team',
    description: 'UC8: sent only to server-ds. Soylent has its own connection pool.',
    variations: [
      { key: 'default', value: { host: 'ds.internal', poolSize: 10 } },
      { key: 'soylent', value: { host: 'ds-soylent.internal', poolSize: 40 } },
    ],
    delivery: both(['server-ds']),
    base: { enabled: true, defaultVariation: 'default', rules: [] },
  }, system);

  // Extra: a customer list + session fallback
  await createFlag(db, {
    key: 'dark_mode_v2', name: 'Dark mode v2', tags: ['design', 'beta'], valueType: 'bool', kind: 'release', owner: 'design-team', removeBy: '2027-02-28',
    description: 'Beta customers get it; otherwise 30% of devices (falls back to session.id when there is no device id).',
    variations: [{ key: 'on', value: true }, { key: 'off', value: false }],
    delivery: both(['ios', 'web']),
    base: {
      enabled: true, defaultVariation: 'off',
      rules: [
        { ruleKey: darkRules.beta, name: 'Beta customers', conditions: [{ field: 'entity', op: 'in', values: beta }], serveVariation: 'on' },
        { ruleKey: darkRules.split, name: '30% of devices', conditions: [],
          split: { by: 'device.id', fallbackBy: 'session.id', ranges: [{ variation: 'on', from: 0, to: 3000 }] } },
      ],
    },
  }, system);

  // Firebase Remote Config style: by default send nothing (the app keeps its code default);
  // only matching rules set a remote value.
  await createFlag(db, {
    key: 'welcome_message', name: 'Welcome message', tags: ['growth', 'onboarding'], valueType: 'string', kind: 'config', owner: 'growth-team',
    description: 'Code default for everyone; beta customers get a remote value. Old android builds explicitly keep their code default.',
    variations: [{ key: 'beta', value: 'Welcome to the beta — tell us what you think!' }, { key: 'holiday', value: 'Happy holidays from all of us 🎉' }],
    delivery: both(clients),
    base: {
      enabled: true, defaultVariation: 'code_default',
      rules: [
        { ruleKey: uuid(), name: 'Old android builds keep the built-in text', conditions: [{ field: 'project', op: 'in', values: ['android'] }, { field: 'app.version', op: 'semver_lt', values: ['6.0.0'] }], serveVariation: 'code_default' },
        { ruleKey: uuid(), name: 'Beta customers', conditions: [{ field: 'entity', op: 'in', values: beta }], serveVariation: 'beta' },
      ],
    },
  }, system);

  await createFlag(db, {
    key: 'max_upload_mb', name: 'Max upload size', tags: ['uploads', 'limits'], valueType: 'number', kind: 'config', owner: 'platform-team',
    description: 'Enterprise customers get a bigger upload limit.',
    variations: [{ key: 'standard', value: 100 }, { key: 'enterprise', value: 1000 }, { key: 'huge', value: 5000 }],
    delivery: both(everyone),
    base: {
      enabled: true, defaultVariation: 'standard',
      rules: [{ ruleKey: uploadRule, name: 'Enterprise customers', conditions: [{ field: 'entity', op: 'in', values: enterprise }], serveVariation: 'enterprise' }],
    },
  }, system);

  // Customer layers (same in dev and prod)
  const layers: [string, string, LayerDoc][] = [
    ['api_base_url', 'vandelay', {
      inherit: 'base_rules_then_customer_default', defaultVariation: 'vandelay',
      rules: [{ ruleKey: uuid(), name: 'Vandelay android', conditions: [{ field: 'project', op: 'in', values: ['android'] }], serveVariation: 'vandelay-android' }],
    }],
    ['api_base_url', 'wonka', { inherit: 'base_rules_then_customer_default', defaultVariation: 'wonka', rules: [] }],
    ['new_checkout', 'wonka', {
      inherit: 'base_rules_then_base_default',
      rules: [{ ruleKey: uuid(), name: 'Wonka gets it everywhere', conditions: [], serveVariation: 'on' }],
    }],
    ['data_region_host', 'cyberdyne', { inherit: 'customer_only', defaultVariation: 'us', rules: [] }],
    ['ds_backend_config', 'soylent', { inherit: 'base_rules_then_customer_default', defaultVariation: 'soylent', rules: [] }],
    ['max_upload_mb', 'soylent', {
      inherit: 'base_rules_then_base_default',
      rules: [{ ruleKey: uuid(), name: 'Soylent web uploads', conditions: [{ field: 'project', op: 'in', values: ['web'] }], serveVariation: 'huge' }],
    }],
  ];
  for (const env of ['dev', 'prod']) {
    for (const [flag, entity, doc] of layers) {
      await applyItems(db, env, [{ flag, entity, expectedLayerVersion: null, proposed: doc }], system, { comment: 'seed' });
    }
  }
  await db.query(`update environment set min_approvals = 1 where key = 'prod'`);
}

/** Dimensions straight into the database, top to bottom, with their attribute rows (as migration 0013 and
 *  control.ts saveDimensions write them): [key, singular, plural]. */
export async function seedDimensions(db: Pick<Db, 'query'>, dims: [string, string, string][]) {
  let parent: number | null = null;
  for (const [key, singular, plural] of dims) {
    const r: { rows: { id: number }[] } = await db.query<{ id: number }>(`insert into dimension (key, singular, plural, parent_id) values ($1,$2,$3,$4) returning id`, [key, singular, plural, parent]);
    parent = Number(r.rows[0].id);
    await db.query(`insert into condition_field (name, value_type, comes_from, can_split_by, description) values ($1, 'string', 'token', true, $2)
      on conflict (name) do nothing`, [key, `The asker’s ${singular}`]);
  }
}
