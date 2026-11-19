-- Migration 0001: the control-plane schema as of the first install.
-- Once a real database has applied this file, never edit it: change the schema with a new numbered file (migrate.ts).
--
-- Multi-tenant feature flags: control-plane schema.
-- This is the team's original design with the review's must-fix items (M2–M11) and
-- several should-fix items (S1 change sets, S4 publishing, S5 audit) applied.
-- Surrogate bigint ids + immutable `key` columns (M5).

create extension if not exists btree_gist;

-- ---------------------------------------------------------------- reference data
create table environment (
  id smallint generated always as identity primary key,
  key text not null unique,
  min_approvals int not null default 0 check (min_approvals between 0 and 5),
  revision bigint not null default 0,              -- M11: monotonic per-environment revision
  link_secret text not null                        -- signs each customer's app link (auth.ts clientSecret)
);

create table app_user (
  id bigint generated always as identity primary key,
  key text not null unique,
  name text not null,
  role text not null check (role in ('editor','approver','oncall','admin'))
);

create table project (
  id smallint generated always as identity primary key,
  key text not null unique,
  kind text not null check (kind in ('client','server'))
);

create table customer (
  id bigint generated always as identity primary key,
  key text not null unique,
  name text not null,
  client_link_version int not null default 1,     -- bumped to replace the customer's app link
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

-- M2: backend server keys carry environment + server; the customer comes from the key's scope or a request header
create table api_key (
  id bigint generated always as identity primary key,
  key_hash text not null unique,                   -- sha256 of the raw key
  key_prefix text not null,                        -- shown in UI / logs
  label text,
  environment_id smallint not null references environment on delete restrict,
  project_id smallint not null references project on delete restrict,
  scope text not null check (scope in ('customer','all_customers')),
  customer_id bigint references customer on delete restrict,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  check ((scope = 'customer') = (customer_id is not null))
);

-- M4: typed condition fields with provenance
create table condition_field (
  name text primary key,
  value_type text not null check (value_type in ('string','string_set','semver','int')),
  comes_from text not null check (comes_from in ('key','token','sdk')),
  can_split_by bool not null default false,
  description text
);

-- ---------------------------------------------------------------- flags
create table flag (
  id bigint generated always as identity primary key,
  key text not null unique check (key ~ '^[a-z][a-z0-9_]*$'),
  value_type text not null check (value_type in ('bool','string','number','json')),
  kind text not null default 'release'
    check (kind in ('release','kill_switch','ops','experiment','config','permission')),
  name text check (name is null or length(name) between 1 and 80),   -- readable name; the key is what code reads
  tags text[] not null default '{}',                              -- "checkout", "web": grouping by team or area
  description text,
  owner text,
  remove_by date,
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  check (kind not in ('release','experiment') or remove_by is not null)
);

-- M5: immutable variation ids
-- Every flag also gets one reserved "code_default" variation (like Firebase Remote Config's
-- "use in-app default"): serving it sends no remote value, so the app uses the default in its code.
create table flag_variation (
  id bigint generated always as identity primary key,
  flag_id bigint not null references flag on delete restrict,
  key text not null,
  value jsonb,
  is_code_default bool not null default false,
  constraint flag_variation_key_check check (
    (is_code_default and key = 'code_default' and value is null)
    or (not is_code_default and key ~ '^[a-z0-9][a-z0-9_-]*$' and key <> 'code_default' and value is not null)),
  unique (flag_id, key),
  unique (flag_id, id)
);
create unique index flag_variation_one_code_default on flag_variation (flag_id) where is_code_default;

-- Sent to: the flag is sent to this app in this environment
create table flag_delivery (
  flag_id bigint not null references flag on delete restrict,
  project_id smallint not null references project on delete restrict,
  environment_id smallint not null references environment on delete restrict,
  primary key (flag_id, project_id, environment_id)
);

-- M3 + M10: layer semantics as constraints
create type inherit_mode as enum
  ('base_rules_then_base_default', 'base_rules_then_customer_default', 'customer_only');

create table flag_layer (
  id bigint generated always as identity primary key,
  flag_id bigint not null references flag on delete restrict,
  environment_id smallint not null references environment on delete restrict,
  customer_id bigint references customer on delete restrict,       -- null = base layer
  is_base bool generated always as (customer_id is null) stored,
  enabled bool,                                                    -- base only
  variation_when_off_id bigint,                                    -- base only, required
  default_variation_id bigint,                                     -- base: required; customer: per inherit
  inherit inherit_mode,                                            -- customer only
  version bigint not null default 1,
  updated_at timestamptz not null default now(),
  updated_by text not null,
  unique nulls not distinct (flag_id, environment_id, customer_id),
  unique (id, is_base),
  unique (id, flag_id),
  foreign key (flag_id, variation_when_off_id) references flag_variation (flag_id, id),
  foreign key (flag_id, default_variation_id) references flag_variation (flag_id, id),
  check (not is_base or (enabled is not null and variation_when_off_id is not null
                         and default_variation_id is not null and inherit is null)),
  check (is_base or (enabled is null and variation_when_off_id is null and inherit is not null)),
  check (is_base or ((inherit = 'base_rules_then_base_default') = (default_variation_id is null)))
);

-- M5 + M6 + M10: rules with stable keys, explicit salt + hash version
create table flag_rule (
  id bigint generated always as identity primary key,
  layer_id bigint not null references flag_layer on delete cascade,
  flag_id bigint not null,
  layer_is_base bool not null,
  rule_key uuid not null,                          -- client-supplied, preserved across saves
  position int not null,
  name text,
  locked bool not null default false,
  disabled bool not null default false,
  conditions jsonb not null default '[]',
  serve_variation_id bigint,
  split_by text references condition_field,
  split_fallback_by text references condition_field,
  split_salt text,
  split_hash_version smallint,
  split_outside_group text check (split_outside_group ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'),  -- group name sent to devices outside the %
  unique (layer_id, rule_key),
  unique (layer_id, position) deferrable initially deferred,
  foreign key (layer_id, flag_id) references flag_layer (id, flag_id),
  foreign key (layer_id, layer_is_base) references flag_layer (id, is_base),
  foreign key (flag_id, serve_variation_id) references flag_variation (flag_id, id),
  check (not locked or layer_is_base),
  check ((serve_variation_id is null) <> (split_by is null)),
  check (split_by is null or (split_salt is not null and split_hash_version is not null)),
  check (split_fallback_by is null or split_by is not null),
  check (split_outside_group is null or split_by is not null),
  check (jsonb_typeof(conditions) = 'array')
);

-- M6: normalized split ranges out of 10000; gaps mean "no match, continue"
create table flag_rule_split (
  rule_id bigint not null references flag_rule on delete cascade,
  flag_id bigint not null,
  variation_id bigint not null,
  bucket int4range not null
    check (not isempty(bucket) and lower(bucket) >= 0 and upper(bucket) <= 10000),
  group_name text check (group_name ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'),    -- group name sent to devices in this part of the %
  foreign key (flag_id, variation_id) references flag_variation (flag_id, id),
  exclude using gist (rule_id with =, bucket with &&)
);

-- ---------------------------------------------------------------- integrity triggers

-- variation values must match the flag's value_type
create function check_variation_value() returns trigger language plpgsql as $$
declare f flag;
begin
  if new.is_code_default then return new; end if;
  select * into f from flag where id = new.flag_id;
  if f.value_type = 'bool' and jsonb_typeof(new.value) <> 'boolean'
     or f.value_type = 'string' and jsonb_typeof(new.value) <> 'string'
     or f.value_type = 'number' and jsonb_typeof(new.value) <> 'number' then
    raise exception 'variation % of flag % must be of type %', new.key, f.key, f.value_type;
  end if;
  return new;
end $$;
create trigger flag_variation_value before insert or update on flag_variation
  for each row execute function check_variation_value();

-- condition fields must exist; splits only by splittable fields; fallback only on release flags (M6)
create function check_rule() returns trigger language plpgsql as $$
declare c jsonb; fk text; kind text;
begin
  for c in select * from jsonb_array_elements(new.conditions) loop
    if not exists (select 1 from condition_field where name = c->>'field') then
      raise exception 'unknown condition field %', c->>'field';
    end if;
  end loop;
  if new.split_by is not null and not exists
     (select 1 from condition_field where name = new.split_by and can_split_by) then
    raise exception 'cannot split by %', new.split_by;
  end if;
  if new.split_fallback_by is not null then
    select f.kind into kind from flag f where f.id = new.flag_id;
    if kind not in ('release','experiment') then
      raise exception 'split fallback is only allowed on release flags (config values must be sticky)';
    end if;
  end if;
  return new;
end $$;
create trigger flag_rule_check before insert or update on flag_rule
  for each row execute function check_rule();

-- locked rules must occupy the lowest positions of the base layer (they run first)
create function check_locked_order() returns trigger language plpgsql as $$
begin
  if exists (
    select 1 from flag_rule a join flag_rule b on a.layer_id = b.layer_id
    where a.layer_id = new.layer_id and a.locked and not b.locked and b.position < a.position) then
    raise exception 'locked rules must come before unlocked rules';
  end if;
  return null;
end $$;
create constraint trigger flag_rule_locked_order after insert or update on flag_rule
  deferrable initially deferred for each row execute function check_locked_order();

-- ---------------------------------------------------------------- change sets (S1) + history (M11)
create type change_status as enum ('in_review','approved','scheduled','applied','failed',
  'conflict','rejected','cancelled');

create table change_set (
  id bigint generated always as identity primary key,
  environment_id smallint not null references environment,
  status change_status not null default 'in_review',
  author text not null,
  reason text,
  content_hash text not null,                      -- reviews are bound to this
  scheduled_at timestamptz,
  apply_attempts int not null default 0,
  last_error text,
  applied_revision bigint,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  applied_at timestamptz
);

create table change_set_item (
  change_set_id bigint not null references change_set on delete restrict,
  seq int not null,
  flag_id bigint not null references flag,
  customer_id bigint references customer,          -- null = base
  expected_layer_version bigint,                   -- null = layer must not exist yet
  expected_base_version bigint,                    -- customer items: re-approve if base moved
  before jsonb,
  proposed jsonb not null,
  primary key (change_set_id, seq)
);

create table change_set_review (
  change_set_id bigint not null references change_set,
  reviewer text not null,
  decision text not null check (decision in ('approve','reject')),
  for_content_hash text not null,
  comment text,
  created_at timestamptz not null default now(),
  primary key (change_set_id, reviewer)
);

create table change_history (                      -- append-only (enforced below)
  id bigint generated always as identity primary key,
  environment_id smallint references environment,
  revision bigint,
  changed_at timestamptz not null default now(),
  changed_by text not null,
  actor_type text not null check (actor_type in ('user','service_token','scheduler','bypass','system')),
  change_type text not null,
  flag text, customer text,
  before jsonb, after jsonb,
  comment text,
  change_set_id bigint references change_set
);

create function forbid_mutation() returns trigger language plpgsql as
$$ begin raise exception '% is append-only', tg_table_name; end $$;
create trigger change_history_immutable before update or delete on change_history
  for each row execute function forbid_mutation();
create trigger change_history_no_truncate before truncate on change_history
  for each statement execute function forbid_mutation();

-- S4: outbox. Each row is an idempotent state signal: "environment E is at revision N".
create table publish_queue (
  id bigint generated always as identity primary key,
  environment_id smallint not null references environment,
  revision bigint not null,
  created_at timestamptz not null default now(),
  claimed_until timestamptz,
  attempts int not null default 0,
  last_error text,
  published_at timestamptz
);
create index publish_queue_pending on publish_queue (environment_id, id) where published_at is null;
