# Security model

This page says what each part of an installation can see and do: apps, backends, people in the console, and the
database. Read it before you decide what to put in a flag and who gets which key.

## What an app can see

An app gets its entity's values in one environment, in one of two ways: it reads its entity's file at a secret link
(see [The app file](/sdk/app-file)), or it asks with OpenFeature's OFREP provider, using its app token
(see [below](#app-tokens)). Apps never hold an API key.

- **Values only.** Rules on the dimensions, the flag set and the environment are settled on the server before the
  file is built. Lists of entities, other entities' values and the rules themselves never reach a device. Acme's web
  app gets Acme's values, not Globex's, and not the rule that gave them.
- **What only the device knows stays as small lines.** Checks on the device's model, OS, browser, app version,
  country, or its ID for a % of devices are left in the file as `when` lines the app checks itself. Those lines show
  the conditions and the values the entity could get, for example "6.0.0 and later get the new checkout". With
  OFREP the server checks those too, and the app gets only its answers.
- **What an app says about itself is ignored.** Its entity, flag set and environment come from its link or token,
  never from anything else it sends.
- **The file before sign-in is public.** `GET /client/v1/flags/<env>/<flag set>` needs no secret: anyone who knows
  the environment and flag set keys can read what every device gets before sign-in.

## Secret links

Each entity, at every level, has a secret link per environment and flag set for apps:

```text
/client/v1/flags/prod/web/acme/<secret>
```

- The secret is an HMAC-SHA256 of the entity and its link version, made with the environment's own secret, and cut
  to 22 characters. It differs per environment; the flag set is in the path, not in the secret.
- Anyone with the link can read the file. Treat it as a secret you hand to signed-in users of that entity: your
  backend gives it to the app at sign-in (see [Backends](/guide/backends#hand-links-to-apps)). Viewers can't see links
  in the console.
- **Replacing** an entity's link (its page → **App link** → **Replace link**) gives it a new version in every
  environment. The old link and its token stop working at once on the instance that replaced it and within a minute
  on the others, and every environment publishes again, which purges the CDN. Links of the entities under it don't
  change.
- Every wrong link to an entity's file, a wrong secret or an entity that doesn't exist, gets the same
  `404 {"error":"no file at this link"}`, so links can't be used to find out which entities exist.

### App tokens

For OpenFeature's OFREP providers (web, Android, iOS), an app sends a token made from its entity's link:

```http
Authorization: Bearer ffl_prod.web.acme.<secret>
```

- It is `ffl_<environment>.<flag set>.<entity>.<secret>`, its secret made from the environment's secret, the flag set,
  the entity and the link's version, so a token for `web` can't be turned into one for `ios`. Your backend gets it and
  the link from `/sdk/v1/links` and hands them to the app at sign-in; the console shows it on the entity's **App
  link** as **OpenFeature token**.
- A token asks about its own entity only, like an API key with scope `entity`. Naming another entity in the
  evaluation context gets `403`.
- Replacing the link stops the token at the same moment. Every wrong token gets the same
  `401 {"error":"unknown or replaced app link"}`.
- Like the link, it is readable by anyone who has the app once it holds it: it gives that entity's values, nothing
  more. Treat it as you treat the link.

## API keys

Backends use an API key in the `Authorization` header (or OFREP's `X-API-Key`). Keys can only be made for flag sets
for backends: the server refuses a key for a flag set for apps, whose apps use their link or token instead.

- A key belongs to one environment and one flag set for backends. Its secret is shown once, when it is made. The
  server keeps only its SHA-256 hash and a readable prefix (`ff_prod_api_` and 4 characters of the secret), which the
  console shows.
- Its **scope** says which entities it may ask about: one entity (`entity`), one entity and every entity under it
  (`below`), or any (`all`).
- The entity is named in the address (`/sdk/v1/flagd/company/acme`) or, for OFREP, in the evaluation context by its
  dimension (`"company": "acme"`), never by a header. The scope is checked on every request against where the entity
  is now: moving an entity out from under a `below` key's entity takes it out of reach at once. Outside the scope, the
  answer is `403`.
- **Revoking** a key stops it at once on the instance that revoked it and within a minute on the others.
- Only admins make and revoke keys, as for the rest of Settings. Each is recorded in History.

::: warning Keep API keys on your servers
A key with scope `all` reads every entity's values. Never put an API key in an app or a web page: apps use their
entity's link or token.
:::

A backend's flagd JSON holds one entity's flags: the rules still to check on the request, and only the values that
entity can get. Another entity's own values and keys aren't in it.

## Sign-in

Sign-in is [Better Auth](https://www.better-auth.com) (see [Sign-in and single sign-on](/self-hosting/sign-in)):

- sessions are a cookie, signed with `BETTER_AUTH_SECRET`, lasting 7 days and renewed while used;
- passwords are kept as hashes, and have at least 10 characters;
- the providers' tokens are stored encrypted with the secret;
- rate limits on sign-in are on in production (`NODE_ENV=production`);
- SAML answers must be signed, are checked against the request they answer, and work once; OIDC uses PKCE;
- adding an OIDC connection won't read an issuer on a private or loopback address unless an admin trusted its origin
  (`BETTER_AUTH_TRUSTED_ORIGINS`), so it can't be used to look around your network;
- password accounts are made only from an admin's invite link for that email, or as the very first account.

## Changes from the console

The session is a cookie, which a browser sends with any request to your server, whoever made the page. So every
change to the console's API (any method but `GET`, `HEAD` and `OPTIONS`) must carry the header
`X-Requested-With: companyfeatures`, which a page on another site can't add without the server's permission. A request
the browser marks `Sec-Fetch-Site: cross-site` is refused too, and a change's body must be JSON. The console's API
sends no CORS headers, so no other site gets that permission.

## Protected environments and history

- An environment with **approvals needed** above 0 is protected: a change there is a request, and it applies only
  after that many approvals. Nobody approves their own request, and an approval counts only for the request as it is
  now; editing it asks for approval again.
- **Break-glass** (on call and admins): turn a kill switch or ops flag off, or roll a version release back, without
  review. It needs a reason, and History keeps it.
- **History is append-only.** Database triggers refuse to update, delete or truncate it, whatever the server does.
  Someone with the database owner's credentials can still drop the triggers: keep those credentials away from people
  who use the console.

See [Approvals and history](/guide/approvals).

## Roles

Viewer, editor, approver, on call and admin. Viewers change nothing; only admins change Settings (environments, flag
sets, dimensions, people, single sign-on, the CDN). The table is in [Sign-in → Roles](/self-hosting/sign-in#roles).

## The console page

The console's page has a Content-Security-Policy that runs scripts only from the server itself (plus its own inline
script, by hash) and refuses to be framed. Every response has `X-Frame-Options: DENY` and
`X-Content-Type-Options: nosniff`. The server sends no HSTS: add it where TLS ends. See
[Production checklist](/self-hosting/production).

## What the database holds

Besides your flags and history, the database keeps password hashes and the secrets the server needs: each
environment's link secret (from which every link can be made), single sign-on client secrets and the Cloudflare
token. Anyone who can read the database or its backups can read every entity's file. Restrict access to it, and
protect its backups the same way.

## Don't put secrets in flag values

Any flag can be in any flag set, and a value is whatever JSON you type. A value in a flag set is readable by anyone with
its link or key. Keep API keys, passwords and tokens out of flag values. Flags that can never
be in a flag set for apps, and values that are references to a secret store, are not built yet.

## Errors

Errors are JSON: `{"error":"…"}` says what was wrong with the request. An unexpected error is logged on the server
with its stack, and the request gets `500 {"error":"internal error"}`, which gives nothing away.

## Reporting a vulnerability

Please don't open a public issue. Report it privately on GitHub: **Security → Report a vulnerability** on the
repository. What to include and what to expect is in
[SECURITY.md](https://github.com/dvir-daniel/companyfeatures/blob/main/SECURITY.md).
