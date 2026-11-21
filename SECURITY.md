# Security policy

CompanyFlags decides what every app and backend of an installation receives, and it keeps sign-in accounts, API
keys and secret app links. We take reports about it seriously and thank everyone who reports responsibly.

## Reporting a vulnerability

**Please don't open a public issue, discussion or pull request for a security problem.**

Report it privately through GitHub: on the repository, open **Security → Report a vulnerability**. Only the
maintainers can read the report. Include:

- what an attacker can do, and what they need first (an account, a role, an API key, network access);
- the steps or a request that shows it, against a current version of `main` or the latest release;
- the version or commit, and how CompanyFlags runs (Docker image, from source, which database).

What to expect:

- we confirm we received it within **3 working days**;
- we tell you whether we can reproduce it, and our plan, within **10 working days**;
- we fix confirmed problems in the latest release, publish a GitHub security advisory, and credit you there unless
  you prefer not to be named.

Please give us a reasonable time to release a fix before you publish anything.

## Supported versions

CompanyFlags is before 1.0: only the **latest release** gets security fixes.

## What's in scope

- the server (`server/`): the console's API, sign-in and single sign-on, the first account and its setup link, roles
  and approvals, the keys of app and backend services, app links and app tokens, the app files, OpenFeature remote
  evaluation (OFREP) with its event stream, flagd downloads and app links for backends;
- the built-in plugins (`server/plugins/`): OFREP, flagd JSON, app files, webhooks out and in, the Cloudflare purge;
- JSONata expressions in imports, exports and webhooks;
- access tokens (`cfp_…`), the MCP server (`/mcp`), OAuth sign-in for MCP clients (`/oauth/…`, `/.well-known/…`),
  agents' tokens and what an agent may do, and alerts turning a kill switch off (`POST /api/alerts/kill`);
- the `companyflags` command (`server/cli.ts`), with the CLI over HTTP and `companyflags mcp`, and flags as code;
- the console (`web/`, `packages/ui`);
- the Docker image and the files we publish to deploy it.

Console admins are trusted with flags, people and settings, but not with the server's host or its network. A way
for an admin to reach addresses on the server's network, run code on the host, read its files, or crash or freeze
the server is in scope. So is anything an editor, viewer, app, backend or someone with no account can do beyond
their role: for example, an app service's key reading another service's flags, or the rules.

Out of scope: problems that need the server's own secrets (`BETTER_AUTH_SECRET`, the database) or access to its
host, denial of service by sheer volume (put a CDN or rate limiter in front, as the docs describe), an app service's
key read out of an app (it is public by design, and reads that service's values only), and reports from automated
scanners with no shown impact.

An agent doing more than an editor, a token above its person's role, a token that makes tokens, or OAuth giving more
than the person allowed is in scope. So is getting around a sign-in rule: two-factor sign-in for admins with a token
or OAuth, approving your own request (an incoming webhook's requests are its owner's), or an OIDC sign-in reaching a
private address. What we accept for agents, tokens and OAuth, and why, is listed under
[Agents, tokens and OAuth](docs/guide/security.md#agents-tokens-and-oauth): for example, an OAuth token working on
`/api` as well as `/mcp`, a client choosing its own name, and a token passed as `--token` showing in the process list.

## How CompanyFlags protects an installation

The [security model](docs/guide/security.md) describes it in full. In short:

- **The first account is the admin's, made with a setup link.** A new server prints the link when it starts, and makes
  no account without it, so whoever reaches a new server first can't make themselves its admin. It works until the
  first account is made.
- **Apps never see rules.** They get values only: checks on dimensions, services and environments are settled on the
  server, and each app file holds one entity's values.
- **Every service has its own keys.** An app service's key is public by design: it reads that service's values only,
  for the context the app sends, and can't download rules or hand out app links. A backend service's key is secret,
  and the server refuses it from a browser.
- **App links** pin an app to one entity. An app's link (as an address or as its OpenFeature token) reads that entity
  only; replacing it stops the old one at once. An admin can replace every link in an environment at once.
- **Sign-in** uses [Better Auth](https://www.better-auth.com): cookie sessions, password hashes, OAuth tokens stored
  encrypted, rate limits unless `NODE_ENV` is `development` or `test`, single sign-on with SAML (signed answers only)
  or OIDC. Where single sign-on is required, only admins sign in another way, and turning it on signs the others out.
- **What admins set up stays inside its limits.** Webhooks reach public addresses only, unless an operator allows an
  origin. JSONata runs in a worker with a time and memory limit. Every request body has a size limit.
- **Changes from the console** need a header another site can't send, so a page elsewhere can't act with your cookie.
- **Protected environments** require approval from someone other than the author, and every change is kept in an
  append-only history.
