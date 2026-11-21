-- The schema as the migrations in server/migrations leave it. Made by `pnpm schema`: never edit it by hand.
-- A schema change is a new migration file; then run `pnpm schema` and commit both.

create extension btree_gist;

create type change_status as enum ('in_review', 'approved', 'scheduled', 'applied', 'failed', 'conflict', 'rejected', 'cancelled');

create type inherit_mode as enum ('base_rules_then_base_default', 'base_rules_then_customer_default', 'customer_only');

create table access_token (
  id bigint generated always as identity,
  token_hash text not null,
  token_prefix text not null,
  person_id bigint not null,
  name text not null,
  role text not null,
  agent boolean default false not null,
  created_at timestamp with time zone default now() not null,
  expires_at timestamp with time zone not null,
  last_used_at timestamp with time zone,
  revoked_at timestamp with time zone,
  alerts_only boolean default false not null,
  constraint access_token_alerts_only_check CHECK (((NOT alerts_only) OR ((NOT agent) AND (role = 'oncall'::text)))),
  constraint access_token_check CHECK (((NOT agent) OR (role = ANY (ARRAY['viewer'::text, 'editor'::text])))),
  constraint access_token_name_check CHECK (((length(name) >= 1) AND (length(name) <= 80))),
  constraint access_token_role_check CHECK ((role = ANY (ARRAY['viewer'::text, 'editor'::text, 'approver'::text, 'oncall'::text, 'admin'::text]))),
  constraint access_token_person_id_fkey FOREIGN KEY (person_id) REFERENCES app_user(id) ON DELETE CASCADE,
  constraint access_token_pkey PRIMARY KEY (id),
  constraint access_token_token_hash_key UNIQUE (token_hash)
);

create table api_key (
  id bigint generated always as identity,
  key_hash text not null,
  key_prefix text not null,
  label text,
  environment_id smallint not null,
  project_id smallint not null,
  scope text not null,
  entity_id bigint,
  created_at timestamp with time zone default now() not null,
  last_used_at timestamp with time zone,
  revoked_at timestamp with time zone,
  expires_at timestamp with time zone,
  constraint api_key_scope CHECK ((scope = ANY (ARRAY['entity'::text, 'below'::text, 'all'::text]))),
  constraint api_key_scope_entity CHECK (((scope = 'all'::text) = (entity_id IS NULL))),
  constraint api_key_customer_id_fkey FOREIGN KEY (entity_id) REFERENCES entity(id) ON DELETE RESTRICT,
  constraint api_key_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES environment(id) ON DELETE RESTRICT,
  constraint api_key_project_id_fkey FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE RESTRICT,
  constraint api_key_pkey PRIMARY KEY (id),
  constraint api_key_key_hash_key UNIQUE (key_hash)
);

create table app_user (
  id bigint generated always as identity,
  key text not null,
  name text not null,
  role text not null,
  created_at timestamp with time zone default now() not null,
  invite_hash text,
  invite_expires_at timestamp with time zone,
  removed_at timestamp with time zone,
  last_signed_in_at timestamp with time zone,
  constraint app_user_role_check CHECK ((role = ANY (ARRAY['viewer'::text, 'editor'::text, 'approver'::text, 'oncall'::text, 'admin'::text]))),
  constraint app_user_pkey PRIMARY KEY (id),
  constraint app_user_invite_hash_key UNIQUE (invite_hash),
  constraint app_user_key_key UNIQUE (key)
);

create table appearance (
  id boolean default true not null,
  settings jsonb not null,
  updated_at timestamp with time zone default now() not null,
  updated_by text not null,
  constraint appearance_id_check CHECK (id),
  constraint appearance_pkey PRIMARY KEY (id)
);

create table auth_account (
  id text not null,
  account_id text not null,
  provider_id text not null,
  user_id text not null,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamp with time zone,
  refresh_token_expires_at timestamp with time zone,
  scope text,
  password text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone not null,
  constraint auth_account_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE,
  constraint auth_account_pkey PRIMARY KEY (id)
);

create table auth_session (
  id text not null,
  expires_at timestamp with time zone not null,
  token text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone not null,
  ip_address text,
  user_agent text,
  user_id text not null,
  constraint auth_session_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE,
  constraint auth_session_pkey PRIMARY KEY (id),
  constraint auth_session_token_key UNIQUE (token)
);

create table auth_two_factor (
  id text not null,
  secret text not null,
  backup_codes text not null,
  user_id text not null,
  verified boolean default true not null,
  failed_verification_count integer default 0 not null,
  locked_until timestamp with time zone,
  constraint auth_two_factor_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE,
  constraint auth_two_factor_pkey PRIMARY KEY (id)
);

create table auth_user (
  id text not null,
  name text not null,
  email text not null,
  email_verified boolean not null,
  image text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  two_factor_enabled boolean default false not null,
  constraint auth_user_pkey PRIMARY KEY (id),
  constraint auth_user_email_key UNIQUE (email)
);

create table auth_verification (
  id text not null,
  identifier text not null,
  value text not null,
  expires_at timestamp with time zone not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  constraint auth_verification_pkey PRIMARY KEY (id)
);

create table cdn_setting (
  id boolean default true not null,
  zone_id text not null,
  api_token text not null,
  updated_at timestamp with time zone default now() not null,
  updated_by text not null,
  constraint cdn_setting_api_token_check CHECK (((length(api_token) >= 20) AND (length(api_token) <= 400))),
  constraint cdn_setting_id_check CHECK (id),
  constraint cdn_setting_zone_id_check CHECK ((zone_id ~ '^[0-9a-f]{32}$'::text)),
  constraint cdn_setting_pkey PRIMARY KEY (id)
);

create table change_history (
  id bigint generated always as identity,
  environment_id smallint,
  revision bigint,
  changed_at timestamp with time zone default now() not null,
  changed_by text not null,
  actor_type text not null,
  change_type text not null,
  flag text,
  entity text,
  before jsonb,
  after jsonb,
  comment text,
  change_set_id bigint,
  constraint change_history_actor_type_check CHECK ((actor_type = ANY (ARRAY['user'::text, 'service_token'::text, 'scheduler'::text, 'bypass'::text, 'system'::text, 'agent'::text]))),
  constraint change_history_change_set_id_fkey FOREIGN KEY (change_set_id) REFERENCES change_set(id),
  constraint change_history_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES environment(id),
  constraint change_history_pkey PRIMARY KEY (id)
);

create table change_set (
  id bigint generated always as identity,
  environment_id smallint not null,
  status change_status default 'in_review'::change_status not null,
  author text not null,
  reason text,
  content_hash text not null,
  scheduled_at timestamp with time zone,
  apply_attempts integer default 0 not null,
  last_error text,
  applied_revision bigint,
  created_at timestamp with time zone default now() not null,
  decided_at timestamp with time zone,
  applied_at timestamp with time zone,
  by_agent boolean default false not null,
  constraint change_set_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES environment(id),
  constraint change_set_pkey PRIMARY KEY (id)
);

create table change_set_item (
  change_set_id bigint not null,
  seq integer not null,
  flag_id bigint not null,
  entity_id bigint,
  expected_layer_version bigint,
  expected_base_version bigint,
  before jsonb,
  proposed jsonb not null,
  kind text default 'layer'::text not null,
  constraint change_set_item_delivery_base CHECK (((kind = 'layer'::text) OR (entity_id IS NULL))),
  constraint change_set_item_kind_check CHECK ((kind = ANY (ARRAY['layer'::text, 'delivery'::text]))),
  constraint change_set_item_change_set_id_fkey FOREIGN KEY (change_set_id) REFERENCES change_set(id) ON DELETE RESTRICT,
  constraint change_set_item_customer_id_fkey FOREIGN KEY (entity_id) REFERENCES entity(id),
  constraint change_set_item_flag_id_fkey FOREIGN KEY (flag_id) REFERENCES flag(id),
  constraint change_set_item_pkey PRIMARY KEY (change_set_id, seq)
);

create table change_set_review (
  change_set_id bigint not null,
  reviewer text not null,
  decision text not null,
  for_content_hash text not null,
  comment text,
  created_at timestamp with time zone default now() not null,
  constraint change_set_review_decision_check CHECK ((decision = ANY (ARRAY['approve'::text, 'reject'::text]))),
  constraint change_set_review_change_set_id_fkey FOREIGN KEY (change_set_id) REFERENCES change_set(id),
  constraint change_set_review_pkey PRIMARY KEY (change_set_id, reviewer)
);

create table condition_field (
  name text not null,
  value_type text not null,
  comes_from text not null,
  can_split_by boolean default false not null,
  description text,
  constraint condition_field_comes_from_check CHECK ((comes_from = ANY (ARRAY['key'::text, 'token'::text, 'sdk'::text]))),
  constraint condition_field_value_type_check CHECK ((value_type = ANY (ARRAY['string'::text, 'string_set'::text, 'semver'::text, 'int'::text]))),
  constraint condition_field_pkey PRIMARY KEY (name)
);

create table dimension (
  id smallint generated always as identity,
  key text not null,
  singular text not null,
  plural text not null,
  parent_id smallint,
  constraint dimension_check CHECK ((parent_id <> id)),
  constraint dimension_key_check CHECK ((key ~ '^[a-z][a-z0-9_]{0,29}$'::text)),
  constraint dimension_plural_check CHECK (((length(plural) >= 1) AND (length(plural) <= 30))),
  constraint dimension_singular_check CHECK (((length(singular) >= 1) AND (length(singular) <= 30))),
  constraint dimension_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES dimension(id) ON DELETE RESTRICT,
  constraint dimension_pkey PRIMARY KEY (id),
  constraint dimension_one_chain TRIGGER DEFERRABLE INITIALLY DEFERRED,
  constraint dimension_key_key UNIQUE (key),
  constraint dimension_one_child UNIQUE (parent_id) DEFERRABLE INITIALLY DEFERRED
);

create table entity (
  id bigint generated always as identity,
  key text not null,
  name text not null,
  client_link_version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  parent_id bigint,
  dimension_id smallint not null,
  constraint entity_not_own_parent CHECK ((parent_id <> id)),
  constraint customer_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES entity(id) ON DELETE RESTRICT,
  constraint entity_dimension_id_fkey FOREIGN KEY (dimension_id) REFERENCES dimension(id) ON DELETE RESTRICT,
  constraint entity_pkey PRIMARY KEY (id),
  constraint entity_key_key UNIQUE (key)
);

create table environment (
  id smallint generated always as identity,
  key text not null,
  min_approvals integer default 0 not null,
  revision bigint default 0 not null,
  link_secret text not null,
  name text not null,
  constraint environment_min_approvals_check CHECK (((min_approvals >= 0) AND (min_approvals <= 5))),
  constraint environment_pkey PRIMARY KEY (id),
  constraint environment_key_key UNIQUE (key)
);

create table flag (
  id bigint generated always as identity,
  key text not null,
  value_type text not null,
  kind text default 'release'::text not null,
  name text,
  tags text[] default '{}'::text[] not null,
  description text,
  owner text,
  remove_by date,
  created_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  free_values boolean default false not null,
  json_schema jsonb,
  safe_variation_id bigint,
  constraint flag_free_values_not_bool CHECK (((NOT free_values) OR (value_type <> 'bool'::text))),
  constraint flag_json_schema_json CHECK (((json_schema IS NULL) OR (value_type = 'json'::text))),
  constraint flag_key_check CHECK ((key ~ '^[a-z][a-z0-9_]*$'::text)),
  constraint flag_kind_check CHECK ((kind = ANY (ARRAY['release'::text, 'kill_switch'::text, 'ops'::text, 'experiment'::text, 'config'::text, 'permission'::text]))),
  constraint flag_name_check CHECK (((name IS NULL) OR ((length(name) >= 1) AND (length(name) <= 80)))),
  constraint flag_remove_by_check CHECK (((kind <> ALL (ARRAY['release'::text, 'experiment'::text])) OR (remove_by IS NOT NULL) OR ((kind = 'release'::text) AND (value_type = 'string'::text)))),
  constraint flag_value_type_check CHECK ((value_type = ANY (ARRAY['bool'::text, 'string'::text, 'number'::text, 'json'::text]))),
  constraint flag_safe_variation_fk FOREIGN KEY (id, safe_variation_id) REFERENCES flag_variation(flag_id, id) DEFERRABLE,
  constraint flag_pkey PRIMARY KEY (id),
  constraint flag_key_key UNIQUE (key)
);

create table flag_delivery (
  flag_id bigint not null,
  project_id smallint not null,
  environment_id smallint not null,
  constraint flag_delivery_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES environment(id) ON DELETE RESTRICT,
  constraint flag_delivery_flag_id_fkey FOREIGN KEY (flag_id) REFERENCES flag(id) ON DELETE RESTRICT,
  constraint flag_delivery_project_id_fkey FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE RESTRICT,
  constraint flag_delivery_pkey PRIMARY KEY (flag_id, project_id, environment_id)
);

create table flag_layer (
  id bigint generated always as identity,
  flag_id bigint not null,
  environment_id smallint not null,
  entity_id bigint,
  is_base boolean generated always as ((entity_id IS NULL)) stored,
  enabled boolean,
  variation_when_off_id bigint,
  default_variation_id bigint,
  inherit inherit_mode,
  version bigint default 1 not null,
  updated_at timestamp with time zone default now() not null,
  updated_by text not null,
  constraint flag_layer_check CHECK (((NOT is_base) OR ((enabled IS NOT NULL) AND (variation_when_off_id IS NOT NULL) AND (default_variation_id IS NOT NULL) AND (inherit IS NULL)))),
  constraint flag_layer_check1 CHECK ((is_base OR ((enabled IS NULL) AND (variation_when_off_id IS NULL) AND (inherit IS NOT NULL)))),
  constraint flag_layer_check2 CHECK ((is_base OR ((inherit = 'base_rules_then_base_default'::inherit_mode) = (default_variation_id IS NULL)))),
  constraint flag_layer_customer_id_fkey FOREIGN KEY (entity_id) REFERENCES entity(id) ON DELETE RESTRICT,
  constraint flag_layer_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES environment(id) ON DELETE RESTRICT,
  constraint flag_layer_flag_id_default_variation_id_fkey FOREIGN KEY (flag_id, default_variation_id) REFERENCES flag_variation(flag_id, id),
  constraint flag_layer_flag_id_fkey FOREIGN KEY (flag_id) REFERENCES flag(id) ON DELETE RESTRICT,
  constraint flag_layer_flag_id_variation_when_off_id_fkey FOREIGN KEY (flag_id, variation_when_off_id) REFERENCES flag_variation(flag_id, id),
  constraint flag_layer_pkey PRIMARY KEY (id),
  constraint flag_layer_flag_id_environment_id_customer_id_key UNIQUE NULLS NOT DISTINCT (flag_id, environment_id, entity_id),
  constraint flag_layer_id_flag_id_key UNIQUE (id, flag_id),
  constraint flag_layer_id_is_base_key UNIQUE (id, is_base)
);

create table flag_managed (
  flag_id bigint not null,
  source text,
  fields text[] not null,
  applied jsonb not null,
  applied_at timestamp with time zone default now() not null,
  applied_by text not null,
  constraint flag_managed_flag_id_fkey FOREIGN KEY (flag_id) REFERENCES flag(id) ON DELETE CASCADE,
  constraint flag_managed_pkey PRIMARY KEY (flag_id)
);

create table flag_rule (
  id bigint generated always as identity,
  layer_id bigint not null,
  flag_id bigint not null,
  layer_is_base boolean not null,
  rule_key uuid not null,
  position integer not null,
  name text,
  locked boolean default false not null,
  disabled boolean default false not null,
  conditions jsonb default '[]'::jsonb not null,
  serve_variation_id bigint,
  split_by text,
  split_fallback_by text,
  split_salt text,
  split_hash_version smallint,
  split_outside_group text,
  constraint flag_rule_check CHECK (((NOT locked) OR layer_is_base)),
  constraint flag_rule_check1 CHECK (((serve_variation_id IS NULL) <> (split_by IS NULL))),
  constraint flag_rule_check2 CHECK (((split_by IS NULL) OR ((split_salt IS NOT NULL) AND (split_hash_version IS NOT NULL)))),
  constraint flag_rule_check3 CHECK (((split_fallback_by IS NULL) OR (split_by IS NOT NULL))),
  constraint flag_rule_check4 CHECK (((split_outside_group IS NULL) OR (split_by IS NOT NULL))),
  constraint flag_rule_conditions_check CHECK ((jsonb_typeof(conditions) = 'array'::text)),
  constraint flag_rule_hash_version_check CHECK (((split_hash_version IS NULL) OR (split_hash_version = 2))),
  constraint flag_rule_split_outside_group_check CHECK ((split_outside_group ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'::text)),
  constraint flag_rule_flag_id_serve_variation_id_fkey FOREIGN KEY (flag_id, serve_variation_id) REFERENCES flag_variation(flag_id, id),
  constraint flag_rule_layer_id_fkey FOREIGN KEY (layer_id) REFERENCES flag_layer(id) ON DELETE CASCADE,
  constraint flag_rule_layer_id_flag_id_fkey FOREIGN KEY (layer_id, flag_id) REFERENCES flag_layer(id, flag_id),
  constraint flag_rule_layer_id_layer_is_base_fkey FOREIGN KEY (layer_id, layer_is_base) REFERENCES flag_layer(id, is_base),
  constraint flag_rule_split_by_fkey FOREIGN KEY (split_by) REFERENCES condition_field(name),
  constraint flag_rule_split_fallback_by_fkey FOREIGN KEY (split_fallback_by) REFERENCES condition_field(name),
  constraint flag_rule_pkey PRIMARY KEY (id),
  constraint flag_rule_locked_order TRIGGER DEFERRABLE INITIALLY DEFERRED,
  constraint flag_rule_layer_id_position_key UNIQUE (layer_id, "position") DEFERRABLE INITIALLY DEFERRED,
  constraint flag_rule_layer_id_rule_key_key UNIQUE (layer_id, rule_key)
);

create table flag_rule_split (
  rule_id bigint not null,
  flag_id bigint not null,
  variation_id bigint not null,
  bucket int4range not null,
  group_name text,
  constraint flag_rule_split_bucket_check CHECK (((NOT isempty(bucket)) AND (lower(bucket) >= 0) AND (upper(bucket) <= 10000))),
  constraint flag_rule_split_group_name_check CHECK ((group_name ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'::text)),
  constraint flag_rule_split_flag_id_variation_id_fkey FOREIGN KEY (flag_id, variation_id) REFERENCES flag_variation(flag_id, id),
  constraint flag_rule_split_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES flag_rule(id) ON DELETE CASCADE,
  constraint flag_rule_split_rule_id_bucket_excl EXCLUDE USING gist (rule_id WITH =, bucket WITH &&)
);

create table flag_variation (
  id bigint generated always as identity,
  flag_id bigint not null,
  key text not null,
  value jsonb,
  is_code_default boolean default false not null,
  constraint flag_variation_key_check CHECK (((is_code_default AND (key = 'code_default'::text) AND (value IS NULL)) OR ((NOT is_code_default) AND (key ~ '^[a-z0-9][a-z0-9_-]*$'::text) AND (key <> 'code_default'::text) AND (value IS NOT NULL)))),
  constraint flag_variation_flag_id_fkey FOREIGN KEY (flag_id) REFERENCES flag(id) ON DELETE RESTRICT,
  constraint flag_variation_pkey PRIMARY KEY (id),
  constraint flag_variation_flag_id_id_key UNIQUE (flag_id, id),
  constraint flag_variation_flag_id_key_key UNIQUE (flag_id, key)
);

create table oauth_client (
  id text not null,
  name text not null,
  redirect_uris text[] not null,
  created_at timestamp with time zone default now() not null,
  constraint oauth_client_name_check CHECK (((length(name) >= 1) AND (length(name) <= 100))),
  constraint oauth_client_pkey PRIMARY KEY (id)
);

create table oauth_code (
  code_hash text not null,
  client_id text not null,
  person_id bigint not null,
  role text not null,
  redirect_uri text not null,
  code_challenge text not null,
  resource text not null,
  expires_at timestamp with time zone not null,
  used_at timestamp with time zone,
  token_id bigint,
  constraint oauth_code_role_check CHECK ((role = ANY (ARRAY['viewer'::text, 'editor'::text]))),
  constraint oauth_code_client_id_fkey FOREIGN KEY (client_id) REFERENCES oauth_client(id) ON DELETE CASCADE,
  constraint oauth_code_person_id_fkey FOREIGN KEY (person_id) REFERENCES app_user(id) ON DELETE CASCADE,
  constraint oauth_code_token_id_fkey FOREIGN KEY (token_id) REFERENCES access_token(id) ON DELETE SET NULL,
  constraint oauth_code_pkey PRIMARY KEY (code_hash)
);

create table oauth_grant (
  token_id bigint not null,
  client_id text not null,
  resource text not null,
  refresh_hash text not null,
  previous_refresh_hash text,
  refresh_expires_at timestamp with time zone not null,
  constraint oauth_grant_client_id_fkey FOREIGN KEY (client_id) REFERENCES oauth_client(id) ON DELETE CASCADE,
  constraint oauth_grant_token_id_fkey FOREIGN KEY (token_id) REFERENCES access_token(id) ON DELETE CASCADE,
  constraint oauth_grant_pkey PRIMARY KEY (token_id),
  constraint oauth_grant_refresh_hash_key UNIQUE (refresh_hash)
);

create table project (
  id smallint generated always as identity,
  key text not null,
  kind text not null,
  constraint project_kind_check CHECK ((kind = ANY (ARRAY['client'::text, 'server'::text]))),
  constraint project_pkey PRIMARY KEY (id),
  constraint project_key_key UNIQUE (key)
);

create table publish_queue (
  id bigint generated always as identity,
  environment_id smallint not null,
  revision bigint not null,
  created_at timestamp with time zone default now() not null,
  claimed_until timestamp with time zone,
  attempts integer default 0 not null,
  last_error text,
  published_at timestamp with time zone,
  purged_at timestamp with time zone,
  constraint publish_queue_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES environment(id),
  constraint publish_queue_pkey PRIMARY KEY (id)
);

create table schema_migration (
  name text not null,
  checksum text not null,
  applied_at timestamp with time zone default now() not null,
  constraint schema_migration_pkey PRIMARY KEY (name)
);

create table server_secret (
  name text not null,
  value text not null,
  constraint server_secret_pkey PRIMARY KEY (name)
);

create table sign_in_rules (
  id boolean default true not null,
  break_glass_admin text,
  admins_need_two_factor boolean default false not null,
  join_role text default 'viewer'::text not null,
  updated_at timestamp with time zone default now() not null,
  updated_by text,
  constraint sign_in_rules_id_check CHECK (id),
  constraint sign_in_rules_join_role_check CHECK ((join_role = ANY (ARRAY['viewer'::text, 'editor'::text, 'approver'::text, 'oncall'::text]))),
  constraint sign_in_rules_pkey PRIMARY KEY (id)
);

create table sso_provider (
  id text not null,
  provider_id text not null,
  issuer text not null,
  domain text not null,
  domain_verified boolean,
  oidc_config text,
  saml_config text,
  user_id text not null,
  organization_id text,
  require_sso boolean default false not null,
  last_sign_in_at timestamp with time zone,
  group_roles jsonb,
  constraint sso_provider_pkey PRIMARY KEY (id),
  constraint sso_provider_provider_id_key UNIQUE (provider_id)
);

create table webhook (
  id bigint generated always as identity,
  name text not null,
  url text not null,
  method text default 'POST'::text not null,
  headers jsonb default '{}'::jsonb not null,
  format text default 'json'::text not null,
  expression text,
  events text[] not null,
  environments text[],
  secret text not null,
  enabled boolean default true not null,
  cursor bigint not null,
  gap_since timestamp with time zone,
  attempts integer default 0 not null,
  next_attempt_at timestamp with time zone,
  claimed_until timestamp with time zone,
  last_status integer,
  last_error text,
  last_sent_at timestamp with time zone,
  last_failed_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  created_by text not null,
  constraint webhook_events_check CHECK (((cardinality(events) > 0) AND (events <@ ARRAY['changes'::text, 'reviews'::text, 'security'::text]))),
  constraint webhook_expression_check CHECK ((length(expression) <= 10000)),
  constraint webhook_format_check CHECK ((format = ANY (ARRAY['json'::text, 'slack'::text, 'jsonata'::text]))),
  constraint webhook_method_check CHECK ((method = ANY (ARRAY['POST'::text, 'PUT'::text, 'PATCH'::text]))),
  constraint webhook_name_check CHECK (((length(name) >= 1) AND (length(name) <= 80))),
  constraint webhook_url_check CHECK (((url ~ '^https?://'::text) AND (length(url) <= 2000))),
  constraint webhook_pkey PRIMARY KEY (id)
);

create table webhook_in (
  id bigint generated always as identity,
  name text not null,
  environment_id smallint not null,
  format text not null,
  expression text,
  create_flags boolean default false not null,
  flag_sets text[] default '{}'::text[] not null,
  token_hash text not null,
  enabled boolean default true not null,
  last_received_at timestamp with time zone,
  last_status integer,
  last_result text,
  created_at timestamp with time zone default now() not null,
  created_by text not null,
  changed_by text,
  constraint webhook_in_expression_check CHECK ((length(expression) <= 10000)),
  constraint webhook_in_format_check CHECK ((format = ANY (ARRAY['values'::text, 'kv'::text, 'flagd'::text, 'jsonata'::text]))),
  constraint webhook_in_name_check CHECK (((length(name) >= 1) AND (length(name) <= 80))),
  constraint webhook_in_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES environment(id),
  constraint webhook_in_pkey PRIMARY KEY (id)
);

CREATE INDEX access_token_person ON public.access_token USING btree (person_id) WHERE (revoked_at IS NULL);
CREATE INDEX auth_account_provider ON public.auth_account USING btree (provider_id, account_id);
CREATE INDEX auth_account_user_id_idx ON public.auth_account USING btree (user_id);
CREATE INDEX auth_session_user_id_idx ON public.auth_session USING btree (user_id);
CREATE INDEX auth_two_factor_secret_idx ON public.auth_two_factor USING btree (secret);
CREATE INDEX auth_two_factor_user_id_idx ON public.auth_two_factor USING btree (user_id);
CREATE INDEX auth_user_lower_email ON public.auth_user USING btree (lower(email));
CREATE INDEX auth_verification_identifier_idx ON public.auth_verification USING btree (identifier);
CREATE INDEX change_history_by_entity ON public.change_history USING btree (entity, id DESC);
CREATE INDEX change_history_by_flag ON public.change_history USING btree (flag, id DESC);
CREATE INDEX change_history_by_person ON public.change_history USING btree (changed_by, id DESC);
CREATE INDEX change_history_by_revision ON public.change_history USING btree (environment_id, revision);
CREATE INDEX change_history_by_subject ON public.change_history USING btree (split_part(change_type, '.'::text, 1), id DESC);
CREATE INDEX change_history_by_time ON public.change_history USING btree (changed_at);
CREATE INDEX change_set_by_status ON public.change_set USING btree (status);
CREATE INDEX change_set_scheduled ON public.change_set USING btree (scheduled_at) WHERE (status = 'scheduled'::change_status);
CREATE INDEX entity_dimension ON public.entity USING btree (dimension_id, name);
CREATE INDEX entity_parent ON public.entity USING btree (parent_id) WHERE (parent_id IS NOT NULL);
CREATE INDEX flag_delivery_by_environment ON public.flag_delivery USING btree (environment_id);
CREATE INDEX flag_layer_by_environment ON public.flag_layer USING btree (environment_id);
CREATE UNIQUE INDEX flag_variation_one_code_default ON public.flag_variation USING btree (flag_id) WHERE is_code_default;
CREATE INDEX oauth_grant_previous ON public.oauth_grant USING btree (previous_refresh_hash);
CREATE INDEX publish_queue_pending ON public.publish_queue USING btree (environment_id, id) WHERE (published_at IS NULL);

CREATE OR REPLACE FUNCTION public.check_locked_order()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if exists (
    select 1 from flag_rule a join flag_rule b on a.layer_id = b.layer_id
    where a.layer_id = new.layer_id and a.locked and not b.locked and b.position < a.position) then
    raise exception 'locked rules must come before unlocked rules';
  end if;
  return null;
end $function$;

CREATE OR REPLACE FUNCTION public.check_rule()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
end $function$;

CREATE OR REPLACE FUNCTION public.check_variation_value()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
end $function$;

CREATE OR REPLACE FUNCTION public.dimension_one_chain()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if (select count(*) from dimension) > 4 then raise exception 'at most 4 dimensions'; end if;
  if (select count(*) from dimension where parent_id is null) > 1 then raise exception 'the dimensions form one chain: one top'; end if;
  return null;
end $function$;

CREATE OR REPLACE FUNCTION public.entity_parent_dimension()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if tg_op = 'UPDATE' and new.dimension_id <> old.dimension_id then
    raise exception 'an entity stays in its dimension';
  end if;
  if new.parent_id is not null and not exists (
      select 1 from entity p join dimension d on d.id = new.dimension_id
      where p.id = new.parent_id and p.dimension_id = d.parent_id) then
    raise exception 'an entity''s parent must be an entity of the dimension right above its own';
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.forbid_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$ begin raise exception '% is append-only', tg_table_name; end $function$;

CREATE TRIGGER change_history_immutable BEFORE DELETE OR UPDATE ON public.change_history FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER change_history_no_truncate BEFORE TRUNCATE ON public.change_history FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE CONSTRAINT TRIGGER dimension_one_chain AFTER INSERT OR DELETE OR UPDATE ON public.dimension DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dimension_one_chain();
CREATE TRIGGER entity_parent_dimension BEFORE INSERT OR UPDATE OF parent_id, dimension_id ON public.entity FOR EACH ROW EXECUTE FUNCTION entity_parent_dimension();
CREATE TRIGGER flag_rule_check BEFORE INSERT OR UPDATE ON public.flag_rule FOR EACH ROW EXECUTE FUNCTION check_rule();
CREATE CONSTRAINT TRIGGER flag_rule_locked_order AFTER INSERT OR UPDATE ON public.flag_rule DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_locked_order();
CREATE TRIGGER flag_variation_value BEFORE INSERT OR UPDATE ON public.flag_variation FOR EACH ROW EXECUTE FUNCTION check_variation_value();
