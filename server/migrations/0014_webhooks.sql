-- Migration 0014: webhooks, out and in (server/webhooks.ts, the console's Migration page, docs/guide/migration.md).
--
-- Out: an admin adds an address; after each change this server sends it what changed, read from the history: published
-- changes (what an environment serves) and reviews (a request made, approved, rejected or scheduled). The message is
-- signed JSON (Standard Webhooks), a Slack message, or whatever a JSONata expression makes of it. Each webhook keeps
-- its own place in the history, so each one gets every change once, in order, and one that's down holds up only itself.
create table webhook (
  id bigint generated always as identity primary key,
  name text not null check (length(name) between 1 and 80),
  url text not null check (url ~ '^https?://' and length(url) <= 2000),
  method text not null default 'POST' check (method in ('POST', 'PUT', 'PATCH')),
  headers jsonb not null default '{}',        -- sent with each message (e.g. the old system's Authorization); never shown again
  format text not null default 'json' check (format in ('json', 'slack', 'jsonata')),
  expression text check (length(expression) <= 10000),   -- format jsonata: what it sends, made from the JSON message
  events text[] not null check (cardinality(events) > 0 and events <@ array['changes', 'reviews']::text[]),
  environments text[],                        -- environment keys; null: every environment
  secret text not null,                       -- signs each message: whsec_ and 24 bytes in base64
  enabled boolean not null default true,
  cursor bigint not null,                     -- the last change_history row it has handled
  gap_since timestamptz,                      -- the next history row isn't readable yet: since when (webhooks.ts)
  attempts int not null default 0,            -- failed sends of the message at the cursor
  next_attempt_at timestamptz,
  claimed_until timestamptz,                  -- one server sends at a time, when several share the database
  last_status int,
  last_error text,
  last_sent_at timestamptz,
  last_failed_at timestamptz,
  created_at timestamptz not null default now(),
  created_by text not null
);

-- In: another system (the old config system, during a migration) posts its values to /hooks/v1/<token>. They are read
-- in one of the import formats (values.ts) and applied like an import: at once, or as a request where the environment
-- needs approval. Only the token's hash is kept: the address is shown once.
create table webhook_in (
  id bigint generated always as identity primary key,
  name text not null check (length(name) between 1 and 80),
  environment_id smallint not null references environment,
  format text not null check (format in ('values', 'kv', 'flagd', 'jsonata')),
  expression text check (length(expression) <= 10000),
  create_flags boolean not null default false,
  flag_sets text[] not null default '{}',     -- a flag it creates is in these flag sets (none: apps keep reading the old system)
  token_hash text not null,
  enabled boolean not null default true,
  last_received_at timestamptz,
  last_status int,
  last_result text,
  created_at timestamptz not null default now(),
  created_by text not null
);
