---
title: "Security model"
description: "This page says what each part of an installation can see and do: apps, backends, people in the console, and the database. Read it before you decide what to put in a flag and who gets which key."
---

## What an app can see

An app gets values for one app service in one environment, never the rules. It reads them in one of three ways: over
OFREP with its app service's key (see [API keys](#api-keys)), over OFREP with a token from its entity's signed app
link (see [App tokens](#app-tokens)), or as its entity's file at a secret link (see [The CDN file](/reading/local-apps)).
A backend service's key never goes in an app.

- **Values only.** Rules on the dimensions, the service and the environment are settled on the server before the
  answer or the file is made. Lists of entities and the rules themselves never reach a device. Acme's web app gets
  Acme's values, not the rule that gave them.
- **What only the device knows stays as small lines.** Checks on the device's model, OS, browser, app version,
  country, or its ID for a % of devices are left in the file as flagd rules the app checks itself. Those lines show
  the conditions and the values the entity could get, for example "6.0.0 and later get the new checkout". With
  OFREP the server checks those too, and the app gets only its answers.
- **The service and environment come from the credential.** An app's key, link or token says them, never anything
  else it sends.
- **With an app's key, the entity is targeting, not proof.** The app names its entity in the context
  (`"company": "acme"`), and gets that entity's values, within the key's scope. With an app link or token, the entity
  comes from the link, and the app can't ask as another.
- **The file before sign-in is public.** `GET /cdn/v1/flags/<env>/<service>` needs no secret: anyone who knows
  the environment and service keys can read what every device gets before sign-in.

:::warning[An app's key is public]
Anyone can take the key out of an app. A key that asks about any entity then reads the values of whichever one a
request names: Globex's, not only Acme's. Values only, never rules or lists of entities. When an entity's values must
stay its own, give the app a key for that entity only, or hand it a signed app link at sign-in.
:::

## Signed app links

App links are the optional, signed way for an app to read as one entity and no other. Each entity, at every level,
has one secret link per environment. The service is in the path, so the same link reads every app service of that
entity:

```text
/cdn/v1/flags/prod/web/acme/<secret>
```

- The secret is an HMAC-SHA256 of the entity and its link version, made with the environment's own secret, and cut
  to 22 characters. It differs per environment; the service is in the path, not in the secret.
- Anyone with the link can read the file. Treat it as a secret you hand to signed-in users of that entity: your
  backend gives it to the app at sign-in (see [Backends](/reading/context#signed-app-links)). Viewers can't see links
  in the console.
- **Replacing** an entity's link (its page → **App link** → **Replace link**) gives it a new version in every
  environment. The old link and its token stop working at once on the instance that replaced it and within a minute
  on the others, and every environment publishes again, which purges the CDN. Links of the entities under it don't
  change.
- Every wrong link to an entity's file gets the same `404 {"error":"no file at this link"}`, after the same work:
  a wrong environment, service, entity or secret. So links can't be used to find out which entities exist.
- **Replacing every link in an environment** (admins: Settings → the environment's **Edit** → **Replace every link in this environment**, or `POST /api/environments/<env>/links/rotate`) gives that
  environment a new secret, for when it may have leaked. Every app link, app token and OFREP change-event address
  there stops working at once; the other environments' don't change. The environment publishes again, which purges
  the CDN, and History records it. Hand apps their new links from your backend as usual.

### App tokens

For OpenFeature's OFREP providers (web, Android, iOS), an app sends a token made from its entity's link:

```http
Authorization: Bearer ffl_prod.web.acme.<secret>
```

- It is `ffl_<environment>.<service>.<entity>.<secret>`, its secret made from the environment's secret, the service,
  the entity and the link's version, so a token for `web` can't be turned into one for `ios`. Your backend gets it and
  the link from `/sdk/v1/links` and hands them to the app at sign-in; the console shows it on the entity's **App
  link** as **OpenFeature token**.
- A token asks about its own entity only, like an API key with scope `entity`. Naming any other entity in the
  evaluation context gets the same `403` (`this key can’t ask about "…"`), whether that entity exists or not, so a
  token can't be used to find out which entities exist. Keys scoped to `entity` or `below` answer the same way.
- Replacing the link stops the token at the same moment. Every wrong token gets the same
  `401 {"error":"unknown or replaced app link"}`.
- Like the link, it is readable by anyone who has the app once it holds it: it gives that entity's values, nothing
  more. Treat it as you treat the link.

## API keys

Every service gets keys, one service and one environment each. A key goes in the `Authorization` header (or OFREP's
`X-API-Key`), and reads only its service's flags.

| Key | Kept | Reads | Refused with `403` |
|---|---|---|---|
| An **app** service's key | In the app: it is public | That service's values over OFREP, for the context the app sends | flagd JSON and app links |
| A **backend** service's key | On your servers: it is secret | Values over OFREP, the rules as flagd JSON, and app links to hand out | Any request with an `Origin` header (a browser) |

- A key's secret is shown once, when it is made. The server keeps only its SHA-256 hash and a readable prefix
  (`ff_prod_web_` or `ff_prod_api_`, and 4 characters of the secret), which the console shows.
- Its **scope** says which entities it may ask about: one entity (`entity`), one entity and every entity under it
  (`below`), or any (`all`).
- The entity is named in the address (`/sdk/v1/flagd/company/acme`) or, for OFREP, in the evaluation context by its
  dimension (`"company": "acme"`), never by a header. The scope is checked on every request against where the entity
  is now: moving an entity out from under a `below` key's entity takes it out of reach at once. Outside the scope, the
  answer is `403`.
- **Revoking** a key stops it at once on the instance that revoked it and within a minute on the others.
- **Expiry.** A key works until it is revoked, or for 30 days, 90 days, 1 or 2 years when it is made (`days` on
  `POST /api/api-keys`, up to 1095). The list shows when it ends; an expired key gets `401`, at once on every
  instance.
- Only admins make and revoke keys, as for the rest of Settings, signed in: an access token can't. Each is recorded in
  History.

:::warning[Keep backend keys on your servers]
A backend's key reads the rules, and with scope `all` every entity's. Never put one in an app or a web page. The server
refuses it from a browser, but a mobile app sends no `Origin` header, so it can't catch a key built into one. Apps use
their app service's own key.
:::

A backend's flagd JSON holds one entity's flags: the rules still to check on the request, and only the values that
entity can get. Another entity's own values and keys aren't in it.

## Access tokens

An access token is for the console's API (`/api`): scripts, the CLI and MCP clients. It acts as you, with a role up
to yours, and **On call at most**: a token never changes settings.

- **Make one** in the console: your name at the foot of the sidebar → **Account** → **+ New token**. Give it a
  name, a role (Viewer, Editor or your own; an admin's is On call at most) and how long it works: 30, 90 or 365 days.
  It is shown once; the server keeps only its hash and a prefix (`cfp_` and 6 characters). A token made as an admin
  before acts as On call.
- **Only a person, signed in,** manages people, invites and password resets, single sign-on, the sign-in rules and
  the appearance, and lowers an environment's approvals. A token gets `403` there, so a leaked one can't hand out
  access or take a safeguard away.
- **Send it** as `Authorization: Bearer cfp_…` on `/api`. No cookie and no `X-Requested-With` header: a token isn't
  sent by a browser on its own, so it needs neither.
- **For an agent** (Claude, Cursor, Codex…), tick **For an agent**. Its role is Viewer or Editor only, so it never
  approves, breaks glass or manages anything. Its changes show as an agent's in History, under your name. Where
  changes need approval they're requests, marked **agent** in Approvals, and someone else approves them.
- **Not from a browser.** A request with a token and an `Origin` header gets `403`. A token belongs in a script or an
  agent's settings, never in a web page.
- **Revoke** a token on the same page: it stops at once, on every server. An expired token stops the same way. If your
  role goes down, your tokens go down with it.
- Tokens are made and revoked only in the signed-in console, never with a token. Admins see and revoke everyone's.
  Each is recorded in History.
- **Removing a person** revokes all their tokens and OAuth sign-ins. Inviting them again gives back their role, not
  their old tokens.

## Agents, tokens and OAuth

What protects the MCP server (`/mcp`), OAuth sign-in for MCP clients, access tokens and the CLI over HTTP:

- **An agent is never above an editor.** An agent's token, made in the console or through OAuth, is Viewer or Editor.
  It can't approve, break glass (`POST /api/alerts/kill` refuses it), schedule others' requests or change Settings.
  Its requests carry its person's name, so its person can't approve them either.
- **Every MCP tool calls the console's API** with the caller's token, in this process. So roles, approvals and
  History hold as for any script. A tool sends no request to any other address. A key of `.` or `..` is refused, so
  a tool can't reach another endpoint than its own.
- **Tokens and codes are kept as hashes** and looked up by their hash, so comparing them leaks no timing. History
  keeps a token's prefix (`cfp_` and 6 characters), never the token.
- **OAuth is OAuth 2.1 with PKCE (S256 only).** The redirect URI must match one the client registered: exactly, or
  for `http://127.0.0.1`, `http://[::1]` and `http://localhost`, on any port (RFC 8252). A code works once, for 10
  minutes, for its client, redirect URI and resource; used again, the token it gave is revoked. A refresh token works
  once; an old one back revokes the sign-in. A revoked, expired or removed sign-in can't be refreshed.
- **No open redirect.** A request the authorize page can't use is shown on the page, never sent back to the client:
  anyone may register a client, so its redirect URI proves nothing until a person allows it.
- **The consent page** escapes everything it shows, loads nothing, can't be framed, and takes the answer only from
  its own page (the `Origin` and `Sec-Fetch-Site` headers, and the sign-in cookie is `SameSite=Lax`). A client's name
  loses control and invisible formatting characters.
- **Registration is open**, as MCP clients need (RFC 7591), but bounded: a client nobody signed in with goes after a
  day, and at most 1,000 such clients exist at once (then `429`).
- **`/mcp` refuses web pages.** A request with an `Origin` header is refused unless it is the server's own configured
  address (`BETTER_AUTH_URL`), so DNS rebinding can't reach it. It takes one JSON-RPC message per request (no
  batches) and at most 1 MB.

Accepted, and why:

- **An OAuth token also works on `/api`.** It is an agent's access token, bound to its person and role, and the MCP
  tools call `/api` with it anyway. Bounding it to `/mcp` would add nothing.
- **No rate limit of its own on `/oauth/token` and `/oauth/revoke`.** Codes, access and refresh tokens are 32 random
  bytes, so guessing one isn't possible. Volume is for a rate limiter in front, as for the rest of the server.
- **A client chooses its own name.** The page says it is an agent with your name, and the address the code goes to.
  Allow only an app you just connected.
- **Apps' own schemes** (`cursor://…`) are allowed as redirect URIs, as desktop MCP clients need. Another app on the
  same computer could claim the scheme; PKCE means a stolen code is useless without its verifier.
- **A token's role follows its person's.** It goes down with theirs, and back up if an admin raises theirs again (never
  above the token's own role). Revoke tokens you no longer trust.
- **Requiring single sign-on doesn't revoke tokens, and leaving the identity provider doesn't either.** Sessions end
  within 12 hours there; tokens last until they expire. Remove a person to end their tokens.
- **Without `BETTER_AUTH_URL`**, the OAuth documents name the address the request asked for (its `Host`). Set it in
  production.
- **`companyflags mcp --token` and `flags --token`** show the token in the computer's process list. Use
  `COMPANYFLAGS_TOKEN` instead on a shared computer, and an `https://` address: over `http://` the token crosses the
  network as it is.

## Sign-in

Sign-in is [Better Auth](https://www.better-auth.com) (see [Sign-in and single sign-on](/self-hosting/sign-in)):

- sessions are a cookie, signed with `BETTER_AUTH_SECRET`, lasting 7 days and renewed while used; where single
  sign-on is required, 12 hours at most (`FF_SSO_SESSION_HOURS`), so the identity provider is asked again;
- passwords are kept as hashes, and have at least 10 characters;
- **two-factor sign-in**: anyone with a password can add an authenticator app's code and recovery codes, kept
  encrypted. An admin can require it of admins with a password (**Settings → Single Sign-On**): until they set it up,
  the API refuses them everything but the setup. A password reset link turns it off for that person;
- each sign-in and each failed one (a wrong password or code, a refusal) is in History, with how; People shows when
  each person last signed in. Security events can go to a SIEM through a webhook
  ([Webhooks → Security events](/guide/webhooks#security-events));
- the providers' tokens are stored encrypted with the secret;
- rate limits on sign-in are on unless `NODE_ENV` is `development` or `test`. They count the connection's address,
  or what your own proxies say (`FF_TRUSTED_PROXIES`), never a header a client sets itself;
- SAML answers must be signed, are checked against the request they answer, and work once; OIDC uses PKCE;
- adding an OIDC connection won't read an issuer on a private or loopback address unless an admin trusted its origin
  (`BETTER_AUTH_TRUSTED_ORIGINS`), so it can't be used to look around your network. The address is checked as the
  connection is made (so DNS rebinding can't get past it), redirects aren't followed, and errors never repeat what
  the address answered;
- single sign-on makes accounts only for emails at the connection's domains. Someone an admin added at another
  domain joins with their invite link, so one connection can't claim an account, or its role, elsewhere;
- password accounts are made only from an admin's invite link for that email, or as the first account;
- **the first account is the admin's, made only with the setup link** the server prints while nobody has an
  account. Until then nobody else joins, however they sign in. See
  [Sign-in → The first account](/self-hosting/sign-in#the-first-account);
- where a single sign-on connection requires single sign-on, nobody at its domains but the one **break-glass admin**
  an admin chose signs in with a password, Google, GitHub or Microsoft. Turning it on asks first, needs a sign-in with
  the connection before (Test sign-in), and signs the others out at once;
- people who join without an invite get the join role: Viewer unless an admin chose another (never Admin). Viewers
  read every flag and entity. A connection can give roles from the identity provider's groups instead
  ([Sign-in → Group roles](/self-hosting/sign-in#group-roles)).

## Changes from the console

The session is a cookie, which a browser sends with any request to your server, whoever made the page. So every
change to the console's API (any method but `GET`, `HEAD` and `OPTIONS`) must carry the header
`X-Requested-With: companyflags`, which a page on another site can't add without the server's permission. A request
the browser marks `Sec-Fetch-Site: cross-site` is refused too, and a change's body must be JSON. The console's API
sends no CORS headers, so no other site gets that permission.

## Protected environments and history

- An environment with **approvals needed** above 0 is protected: a change there is a request, and it applies only
  after that many approvals. Nobody approves their own request, and an approval is recorded against the request's
  exact content, the values of the variants it serves included. A request can't be edited: to change it, its author
  withdraws it and sends a new one. While a request waits, nobody can change a value it uses, and if one changes
  anyway, the request ends as a conflict instead of serving it.
- **Break-glass** (on call and admins): turn any flag off, serve a kill switch's or ops flag's safe value, pause a
  release, or roll a version release back, without review. It needs a reason, and History keeps it. Only admins name a
  safe value while an environment is protected, since break-glass serves it without review.
- **Scheduled requests can be stopped.** Its author or any reviewer can unschedule one, and a reviewer can reject it
  until it applies. A scheduled request that can't apply, a withdrawal and an unschedule are in History and on the
  reviews webhook.
- **Lowering approvals asks first.** The drawer also warns when the people there can't meet the number.
- **History is append-only.** Database triggers refuse to update, delete or truncate it, whatever the server does.
  Someone with the database owner's credentials can still drop the triggers: keep those credentials away from people
  who use the console.

See [Approvals and history](/guide/approvals).

## Webhooks

[Webhooks](/guide/webhooks) are the `webhooks()` plugin.

- **A webhook in's address is a credential that writes.** Anyone with `/hooks/v1/<token>` can post values into its
  environment. Where changes need approval, a post makes a request; elsewhere it applies at once. The address is shown
  once and the server keeps only a hash of its secret. Keep it as you keep a backend's key.
- **Only admins** make, change or replace webhooks, in and out, and History records each of these. The changes a
  post makes are in History too, by *Webhook: &lt;its name&gt;*.
- **Webhooks out** keep their address and header on the server: the console never shows them again. The signing
  secret is shown once.
- **Webhooks out reach public addresses only**: not this machine, your private network or a cloud's metadata address,
  checked as each connection is made, with no redirects followed. An operator allows an origin on the network with
  `FF_WEBHOOK_ALLOWED_ORIGINS`. Whatever an address does, the console gets one message for an unreachable one, so a
  webhook's **Test** can't be used to look around your network.

## Limits

What admins and others send stays within limits, so it can't take the server down:

- **Request bodies.** 64 KB for OFREP, 256 KB for sign-in, 1 MB for webhooks in and the console's API, 4 MB for
  imports. A larger body gets `413` as it arrives, also when it's sent in chunks.
- **JSONata** (imports, exports, webhooks out) runs in a worker thread apart from the server: a second, 500 levels
  deep, a memory limit, and 4 MB of JSON in and out. One that runs over gets `422`; a webhook's is switched off.
  Only admins write expressions: for imports, webhooks, and exports with JSONata.

## Roles

Viewer, editor, approver, on call and admin. Viewers change nothing; only admins change Settings (environments,
services, dimensions, people, single sign-on, the CDN) and make API keys. The table is in [Sign-in → Roles](/self-hosting/sign-in#roles).

## The console page

The console's page has a Content-Security-Policy that runs scripts only from the server itself (plus its own inline
script, by hash) and refuses to be framed. Every response has `X-Frame-Options: DENY` and
`X-Content-Type-Options: nosniff`. The server sends no HSTS: add it where TLS ends. See
[Production checklist](/self-hosting/production).

## What the database holds

Besides your flags and history, the database keeps password hashes and the secrets the server needs: each
environment's link secret (from which every link can be made), single sign-on client secrets, the Cloudflare
token, and webhooks' addresses, headers and signing secrets. Anyone who can read the database or its backups can
read every entity's file. Restrict access to it, and protect its backups the same way.

## Don't put secrets in flag values

Any flag can be in any service, and a value is whatever JSON you type. A value in an app service is readable by
anyone who has the app, since its key is public. Keep API keys, passwords and tokens out of flag values. Flags that
can never be in an app service, and values that are references to a secret store, are not built yet.

## Errors

Errors are JSON: `{"error":"…"}` says what was wrong with the request. An unexpected error is logged on the server
with its stack, and the request gets `500 {"error":"internal error"}`, which gives nothing away.

## Reporting a vulnerability

Please don't open a public issue. Report it privately on GitHub: **Security → Report a vulnerability** on the
repository. What to include and what to expect is in
[SECURITY.md](https://github.com/dvir-daniel/companyflags/blob/main/SECURITY.md).
