-- OAuth for MCP clients (oauth.ts): a client signs a person in through the console and gets an agent's access token
-- (access_token, agent = true) bound to this server's /mcp. The access token is the row the Access tokens page lists;
-- revoking it there ends the sign-in, refresh token and all.

-- the clients that registered themselves (RFC 7591): public clients, with no secret
create table oauth_client (
  id text primary key,                             -- cfc_ and random characters
  name text not null check (length(name) between 1 and 100),
  redirect_uris text[] not null,
  created_at timestamptz not null default now()
);

-- an authorization code: once, for minutes, with its PKCE challenge (S256)
create table oauth_code (
  code_hash text primary key,                      -- sha256 of the raw code
  client_id text not null references oauth_client on delete cascade,
  person_id bigint not null references app_user on delete cascade,
  role text not null check (role in ('viewer','editor')),
  redirect_uri text not null,
  code_challenge text not null,
  resource text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  token_id bigint references access_token on delete set null   -- the token it gave: revoked if the code comes back
);

-- one sign-in of a client: its access token, and the refresh token that renews it (each use gives a new one)
create table oauth_grant (
  token_id bigint primary key references access_token on delete cascade,
  client_id text not null references oauth_client on delete cascade,
  resource text not null,
  refresh_hash text not null unique,               -- sha256 of the raw refresh token
  previous_refresh_hash text,                      -- the one before: seen again, the sign-in is revoked
  refresh_expires_at timestamptz not null
);
create index oauth_grant_previous on oauth_grant (previous_refresh_hash);
