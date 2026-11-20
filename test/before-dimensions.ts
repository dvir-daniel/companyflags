// A database as it was before dimensions (migrations up to 0012): customers, brands of a company, standalone customers,
// settings of their own on each kind, rules and %s on customer.id and customer.company, API keys of both old scopes, a
// change set in review written with customer.id, and History from then. migrate.test.ts upgrades it with 0013 and checks
// that every file, flagd JSON, link and key is what it was (test/before-dimensions.json: made by the code from before
// dimensions, from this same data).
import { createHash } from 'node:crypto';

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export const ENV_SECRET = 'link-secret-of-prod';
/** The raw API keys: Velvet's own (scope `customer`), and a shared one (`all_customers`). */
export const KEYS = { velvet: 'ff_prod_backend_velvOwnKey0000000000', shared: 'ff_prod_backend_sharedKey000000000000' };
export const CUSTOMERS = ['tyrell', 'velvet', 'onyx', 'acme', 'solo'];
export const DIMENSION_OF: Record<string, string> = { tyrell: 'company', velvet: 'brand', onyx: 'brand', acme: 'company', solo: 'company' };
export const CHANGE_SET_RULE = '00000000-0000-4000-8000-0000000000c5';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export async function seedBeforeDimensions(db: Q) {
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  await db.query(`insert into environment (key, name, min_approvals, revision, link_secret) values ('prod', 'Production', 1, 1, $1)`, [ENV_SECRET]);
  await db.query(`insert into project (key, kind) values ('web', 'client'), ('backend', 'server')`);
  await db.query(`insert into app_user (key, name, role) values ('alice', 'Alice', 'editor'), ('bob', 'Bob', 'approver'), ('dana', 'Dana', 'admin')`);
  for (const [key, name] of [['tyrell', 'Tyrell'], ['acme', 'Acme'], ['solo', 'Solo']]) {
    await db.query(`insert into customer (key, name) values ($1, $2)`, [key, name]);
  }
  for (const [key, name] of [['velvet', 'Velvet'], ['onyx', 'Onyx']]) {
    await db.query(`insert into customer (key, name, parent_id) select $1, $2, id from customer where key = 'tyrell'`, [key, name]);
  }
  await db.query(`update customer set client_link_version = 3 where key = 'acme'`);
  // the server of then kept these two attributes in its list
  await db.query(`insert into condition_field (name, value_type, comes_from, can_split_by, description)
    values ('customer.id', 'string', 'token', true, 'From the customer’s app link, or the backend’s API key'),
           ('customer.company', 'string', 'token', true, 'The company')
    on conflict (name) do update set comes_from = excluded.comes_from, can_split_by = excluded.can_split_by`);
  const env = (await one(`select id from environment where key = 'prod'`)).id;
  const customer = async (k: string) => (await one(`select id from customer where key = $1`, [k])).id;

  // one string flag with every kind of rule, and one on/off flag
  const flag = async (key: string, type: string, values: [string, unknown][]) => {
    const f = (await one(`insert into flag (key, value_type, kind) values ($1, $2, 'config') returning id`, [key, type])).id;
    await db.query(`insert into flag_variation (flag_id, key, value, is_code_default) values ($1, 'code_default', null, true)`, [f]);
    const ids: Record<string, string> = { code_default: (await one(`select id from flag_variation where flag_id = $1 and is_code_default`, [f])).id };
    for (const [k, v] of values) ids[k] = (await one(`insert into flag_variation (flag_id, key, value) values ($1, $2, $3) returning id`, [f, k, JSON.stringify(v)])).id;
    await db.query(`insert into flag_delivery (flag_id, project_id, environment_id) select $1, id, $2 from project`, [f, env]);
    return { f, ids };
  };
  let n = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const layer = async (fl: { f: string; ids: Record<string, string> }, who: string | null, o: { inherit?: string; def?: string | null }) =>
    (await one(`insert into flag_layer (flag_id, environment_id, customer_id, enabled, variation_when_off_id, default_variation_id, inherit, updated_by)
      values ($1, $2, $3, $4, $5, $6, $7, 'seed') returning id`, [fl.f, env, who ? await customer(who) : null, who ? null : true,
      who ? null : fl.ids.code_default, o.def ? fl.ids[o.def] : null, who ? o.inherit : null])).id;
  const rule = async (fl: { f: string; ids: Record<string, string> }, layerId: string, base: boolean, pos: number,
    r: { locked?: boolean; conditions?: object[]; serve?: string; split?: { by: string; salt: string; ranges: [string, number, number][] } }) => {
    const id = (await one(`insert into flag_rule (layer_id, flag_id, layer_is_base, rule_key, position, locked, conditions, serve_variation_id,
        split_by, split_salt, split_hash_version) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
      [layerId, fl.f, base, uuid(), pos, !!r.locked, JSON.stringify(r.conditions ?? []), r.serve ? fl.ids[r.serve] : null,
        r.split?.by ?? null, r.split?.salt ?? null, r.split ? 2 : null])).id;
    for (const [v, from, to] of r.split?.ranges ?? []) {
      await db.query(`insert into flag_rule_split (rule_id, flag_id, variation_id, bucket) values ($1, $2, $3, int4range($4, $5))`, [id, fl.f, fl.ids[v], from, to]);
    }
  };
  const f = await flag('f', 'string', [['a', 'A'], ['b', 'B'], ['c', 'C'], ['d', 'D']]);
  const fBase = await layer(f, null, { def: 'a' });
  await rule(f, fBase, true, 0, { locked: true, conditions: [{ field: 'customer.id', op: 'in', values: ['onyx'] }, { field: 'app.version', op: 'semver_lt', values: ['2.0.0'] }], serve: 'd' });
  await rule(f, fBase, true, 1, { conditions: [{ field: 'customer.company', op: 'in', values: ['tyrell'] }, { field: 'device.platform', op: 'in', values: ['ios'] }], serve: 'b' });
  await rule(f, fBase, true, 2, { conditions: [{ field: 'customer.id', op: 'in', values: ['acme', 'velvet'] }], serve: 'c' });
  await rule(f, fBase, true, 3, { conditions: [{ field: 'customer.company', op: 'not_in', values: ['acme'] }], split: { by: 'customer.id', salt: 'by-customer', ranges: [['b', 0, 5000]] } });
  await rule(f, fBase, true, 4, { split: { by: 'device.id', salt: 'f', ranges: [['c', 0, 3000], ['d', 3000, 4000]] } });
  const uni = await layer(f, 'tyrell', { inherit: 'customer_only', def: 'd' });
  await rule(f, uni, false, 0, { conditions: [{ field: 'app.version', op: 'semver_lt', values: ['3.0.0'] }], serve: 'b' });
  const velvet = await layer(f, 'velvet', { inherit: 'base_rules_then_customer_default', def: 'c' });
  await rule(f, velvet, false, 0, { split: { by: 'customer.company', salt: 'by-company', ranges: [['a', 0, 4000]] } });
  const acme = await layer(f, 'acme', { inherit: 'base_rules_then_base_default', def: null });
  await rule(f, acme, false, 0, { conditions: [{ field: 'project', op: 'in', values: ['web'] }], serve: 'd' });
  const g = await flag('g', 'bool', [['on', true], ['off', false]]);
  const gBase = await layer(g, null, { def: 'off' });
  await rule(g, gBase, true, 0, { conditions: [{ field: 'customer.company', op: 'in', values: ['tyrell'] }, { field: 'customer.id', op: 'not_in', values: ['onyx'] }], serve: 'on' });

  // API keys of both old scopes
  await db.query(`insert into api_key (key_hash, key_prefix, environment_id, project_id, scope, customer_id)
    select $1, 'ff_prod_backend_velv', $2, p.id, 'customer', c.id from project p, customer c where p.key = 'backend' and c.key = 'velvet'`, [sha(KEYS.velvet), env]);
  await db.query(`insert into api_key (key_hash, key_prefix, environment_id, project_id, scope)
    select $1, 'ff_prod_backend_shar', $2, id, 'all_customers' from project where key = 'backend'`, [sha(KEYS.shared), env]);

  // a change set in review, written with customer.id: a rule on the defaults of f for Solo
  const baseVersion = (await one(`select version from flag_layer where id = $1`, [fBase])).version;
  const cs = (await one(`insert into change_set (environment_id, status, author, reason, content_hash) values ($1, 'in_review', 'alice', 'solo goes first', 'hash-of-then')
    returning id`, [env])).id;
  const doc = { enabled: true, variationWhenOff: 'code_default', defaultVariation: 'a', rules: [
    { ruleKey: CHANGE_SET_RULE, name: 'Solo first', locked: false, disabled: false, conditions: [{ field: 'customer.id', op: 'in', values: ['solo'] }], serveVariation: 'd', split: null },
  ] };
  await db.query(`insert into change_set_item (change_set_id, seq, kind, flag_id, customer_id, expected_layer_version, before, proposed)
    values ($1, 0, 'layer', $2, null, $3, null, $4)`, [cs, f.f, baseVersion, JSON.stringify({ doc, allowReshuffle: false })]);

  // History from then: a brand added, one moved out of its company (revision 1 of prod)
  await db.query(`insert into change_history (environment_id, revision, changed_by, actor_type, change_type, flag, customer, before, after)
    values ($1, 1, 'dana', 'user', 'customer.create', null, 'velvet', null, $2),
           ($1, 1, 'dana', 'user', 'customer.update', null, 'onyx', $3, $4)`,
  [env, JSON.stringify({ key: 'velvet', name: 'Velvet', company: 'tyrell' }),
    JSON.stringify({ key: 'onyx', name: 'Onyx', company: 'tyrell' }), JSON.stringify({ key: 'onyx', name: 'Onyx', company: null })]);
  return { changeSet: Number(cs) };
}

/** The ETag of a file or flagd JSON: its flags, hashed (server/delivery.ts). */
export const etagOf = (flags: unknown) => `W/"${createHash('sha256').update(JSON.stringify(flags)).digest('base64url').slice(0, 22)}"`;
