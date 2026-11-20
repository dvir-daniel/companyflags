-- Migration 0020: sign-in rules for an organization (server/access.ts, server/betterAuth.ts, server/sso.ts).
--
-- Two-factor sign-in for password accounts, with Better Auth's twoFactor plugin: an authenticator app's secret and
-- recovery codes, both kept encrypted with the server's secret.
alter table auth_user add column two_factor_enabled boolean not null default false;
create table auth_two_factor (
  id text primary key,
  secret text not null,
  backup_codes text not null,
  user_id text not null references auth_user (id) on delete cascade,
  verified boolean not null default true,
  failed_verification_count integer not null default 0,
  locked_until timestamptz
);
create index auth_two_factor_user_id_idx on auth_two_factor (user_id);
create index auth_two_factor_secret_idx on auth_two_factor (secret);

-- The organization's sign-in rules, set by an admin on Settings → Single sign-on. One row at most.
create table sign_in_rules (
  id boolean primary key default true check (id),
  -- the one admin who keeps their password where single sign-on is required, for when the identity provider is down
  break_glass_admin text,
  -- admins with a password must set up two-factor sign-in before they use the console
  admins_need_two_factor boolean not null default false,
  -- the role of people who join without an invite (single sign-on, or a provider at a signup domain): never admin
  join_role text not null default 'viewer' check (join_role in ('viewer','editor','approver','oncall')),
  updated_at timestamptz not null default now(),
  updated_by text
);

-- When each person last signed in (the People list).
alter table app_user add column last_signed_in_at timestamptz;

-- API keys can end on a date. Without one, a key works until it is revoked.
alter table api_key add column expires_at timestamptz;

-- Single sign-on connections: when someone last signed in with each (a connection must have worked before it can be
-- required), and the roles its groups give (an OIDC claim or a SAML attribute, and each group's role).
alter table sso_provider add column last_sign_in_at timestamptz;
alter table sso_provider add column group_roles jsonb;

-- An access token for alerts only (tokens.ts): it turns kill switches off from an alert tool (POST /api/alerts/kill),
-- and does nothing else, though break-glass needs On call.
alter table access_token add column alerts_only boolean not null default false;
alter table access_token add constraint access_token_alerts_only_check check (not alerts_only or (not agent and role = 'oncall'));

-- Webhooks can send security events too (sign-ins, people, tokens, keys, single sign-on), for a SIEM (webhooks.ts).
alter table webhook drop constraint webhook_events_check;
alter table webhook add constraint webhook_events_check
  check (cardinality(events) > 0 and events <@ array['changes', 'reviews', 'security']::text[]);
