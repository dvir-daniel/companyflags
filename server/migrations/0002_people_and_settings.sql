-- Migration 0002: people sign in with the company's SSO (identity.ts), and admins set things up in Settings.

-- A person's key is their email. Everyone after the first admin starts as a viewer: they can look, not change.
alter table app_user drop constraint app_user_role_check;
alter table app_user add constraint app_user_role_check check (role in ('viewer','editor','approver','oncall','admin'));
alter table app_user add column created_at timestamptz not null default now();

-- Environments get a display name ("Production"), set in Settings.
alter table environment add column name text;
update environment set name = initcap(key);
alter table environment alter column name set not null;
