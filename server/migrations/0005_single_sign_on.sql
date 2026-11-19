-- Migration 0005: single sign-on with the company's identity provider, SAML or OIDC (server/sso.ts), through
-- Better Auth's SSO plugin. Admins add the connections in Settings; each one is for the company's email domains.

create table sso_provider (
  id text primary key,
  provider_id text not null unique,          -- the connection's id, in its sign-in and callback addresses
  issuer text not null,                      -- OIDC issuer, or the SAML identity provider's entity ID
  domain text not null,                      -- the email domains it signs in, comma-separated
  domain_verified boolean,                   -- true once an admin added it: it vouches for emails at those domains
  oidc_config text,                          -- JSON, as Better Auth keeps it (the client secret included)
  saml_config text,
  -- the admin who added it. Not a foreign key: a connection belongs to the company and stays when that admin leaves.
  user_id text not null,
  organization_id text,
  -- no password sign-ins at these domains (except admins): everyone uses the identity provider
  require_sso boolean not null default false
);
