-- Access tokens (tokens.ts): a person's token for the console's API, for scripts, the CLI over HTTP and MCP clients.
-- An agent's token is a person's too, recorded in History as an agent ('agent' actor type).

create table access_token (
  id bigint generated always as identity primary key,
  token_hash text not null unique,                 -- sha256 of the raw token
  token_prefix text not null,                      -- shown in the console: cfp_ and the first characters
  person_id bigint not null references app_user on delete cascade,
  name text not null check (length(name) between 1 and 80),
  role text not null check (role in ('viewer','editor','approver','oncall','admin')),
  agent boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  check (not agent or role in ('viewer','editor'))  -- an agent never approves, breaks glass or manages
);
create index access_token_person on access_token (person_id) where revoked_at is null;

alter table change_history drop constraint change_history_actor_type_check;
alter table change_history add constraint change_history_actor_type_check
  check (actor_type in ('user','service_token','scheduler','bypass','system','agent'));
