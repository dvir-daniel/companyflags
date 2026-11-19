-- Migration 0004: people sign in with Better Auth (server/betterAuth.ts) instead of Cloudflare Access.
-- Better Auth keeps accounts, sessions and its one-time values in the auth_* tables (the columns it expects,
-- in snake_case); app_user keeps each person's role. The two meet on the email (app_user.key = auth_user.email).

create table auth_user (
  id text primary key,
  name text not null,
  email text not null unique,
  email_verified boolean not null,
  image text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table auth_session (
  id text primary key,
  expires_at timestamptz not null,
  token text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null,
  ip_address text,
  user_agent text,
  user_id text not null references auth_user (id) on delete cascade
);
create index auth_session_user_id_idx on auth_session (user_id);

-- one row per way of signing in: a password (provider_id 'credential', its scrypt hash in password) or a provider
create table auth_account (
  id text primary key,
  account_id text not null,
  provider_id text not null,
  user_id text not null references auth_user (id) on delete cascade,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null
);
create index auth_account_user_id_idx on auth_account (user_id);

create table auth_verification (
  id text primary key,
  identifier text not null,
  value text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index auth_verification_identifier_idx on auth_verification (identifier);

-- Away from production, the secret that signs session cookies is made on the first start and kept here
-- (production sets BETTER_AUTH_SECRET instead).
create table server_secret (
  name text primary key,
  value text not null
);

-- An admin adds people by email and gives them an invite link: only its hash is kept, until it's used or expires.
-- Removing someone's access deletes their accounts and sessions; their row stays, marked, so history still names them.
alter table app_user add column invite_hash text unique;
alter table app_user add column invite_expires_at timestamptz;
alter table app_user add column removed_at timestamptz;
