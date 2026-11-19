-- Migration 0010: the CDN purge set up in the console (Settings → CDN, server/cdn.ts), not only by the server's
-- environment (CF_ZONE_ID, CF_API_TOKEN, which still win when set).
--
-- One row at most: the Cloudflare zone the app files are served through, and an API token that may purge its cache.
-- The token is kept here like the single sign-on client secrets are, and never sent back to the browser.
create table cdn_setting (
  id boolean primary key default true check (id),
  zone_id text not null check (zone_id ~ '^[0-9a-f]{32}$'),
  api_token text not null check (length(api_token) between 20 and 200),
  updated_at timestamptz not null default now(),
  updated_by text not null
);

-- When a publish's CDN purge went through (null: none was set up, it failed, or it's still under way)
alter table publish_queue add column purged_at timestamptz;
