---
title: "Sign-in and single sign-on"
description: "Email and password, Google, GitHub, Microsoft, and single sign-on over OIDC or SAML, through Better Auth."
---

People sign in to the console with [Better Auth](https://www.better-auth.com): with an email and password, with
Google, GitHub or Microsoft when you set them up, or with your organization's identity provider over OIDC or SAML.
The session is a cookie. Accounts, sessions and password hashes are kept in your database; each person's role is kept
next to them, and the two meet on the email.

Who may join, what each role may do and what removing access takes away are decided in one place,
[`server/access.ts`](https://github.com/dvir-daniel/companyflags/blob/main/server/access.ts).

## The first account

A new install has no accounts. The first one is the **admin**'s, and only a **setup link** can make it. While nobody
has an account, the server prints the link at every start:

```text
[companyflags] nobody has an account yet: make the admin account at https://flags.example.com/api/setup/<secret>
```

Opening it keeps its secret in a cookie for an hour and opens the console, where you create the admin account. Then
invite everyone else from **Settings → People**.

- The link is built on `BETTER_AUTH_URL` (or the server's own address without it). Its secret is made from
  `BETTER_AUTH_SECRET`, so it stays the same across restarts, and every instance on one database prints the same one.
  Nothing about it is stored.
- It works until the first account exists. After that, or with a wrong secret, it answers `404`.
- Until then nobody else can join at all: not with Google, GitHub or Microsoft at a domain in `FF_SIGNUP_DOMAINS`,
  and not with single sign-on.
- Scripts can send the secret in an `X-Setup` header instead of opening the link.

:::warning[Keep the setup link secret]
Until the admin account exists, whoever has the link can make it. Don't paste it anywhere others can read.
:::

## Who can join

After the first account, nobody makes an account on their own. A person can join when:

- **an admin invited them.** In **Settings → People**, an admin adds the person's email and role and gets an
  **invite link**. The link works once, for 7 days, and only for that email. **Invite link** on their row makes a new
  one; the old one stops working.
- **they sign in with Google, GitHub or Microsoft** and the provider confirms their email, and that email is one an
  admin added, or is at a domain in `FF_SIGNUP_DOMAINS` (exact domain, subdomains not included).
- **they sign in with single sign-on** and their email is at one of the connection's domains (subdomains included).
  A connection vouches only for emails at its own domains: someone an admin added at another domain joins with their
  invite link, while it works.

People who join without an invite get the **join role**: Viewer, unless an admin chose another in **Settings → Single
sign-on → New people join as** (never Admin). Viewers can see every flag and entity, and change nothing. An admin
gives them a role in People, or the identity provider's groups do (see [Group roles](#group-roles)). People an admin
added keep the role the admin chose, however they sign in.

Password accounts are only made from an invite link (or as the first account, with the setup link), so nobody can
claim an address they weren't invited as. Passwords have at least 10 characters.

## Email and password

Always on. An invited person opens their link, chooses a name and a password, and is signed in. Later they sign in
with the same email and password, unless a single sign-on connection for their domain requires single sign-on (see
below).

## Forgotten passwords

The server sends no email, so an admin makes the reset link: **Settings → People → Reset password** on the person's
row. Send it to them however you like. It works once, for 24 hours; they choose a new password (at least 10
characters) and are signed out everywhere. The link is shown once, and History records that it was made.

Only people with a password have one to reset: someone who signs in with single sign-on or a provider resets it
there. Asking for a reset by email is switched off.

A reset link also turns off the person's two-factor sign-in, for someone who lost their phone and their recovery
codes. They set it up again.

## Two-factor sign-in

Anyone with a password can add a second step: a code from an authenticator app (1Password, Google Authenticator,
Authy and others). They set it up in their account menu → **Access tokens and two-factor sign-in → Set up**: their
password, then the app's setup key, then a code from the app. They also get ten **recovery codes**, shown once; each
signs in once, for a lost phone. **New recovery codes** replaces them.

Then signing in with a password asks for the code next. Ten wrong codes in a row lock the second step for 15 minutes.
The secret and the recovery codes are kept encrypted with `BETTER_AUTH_SECRET`.

To require it of admins, turn on **Settings → Single sign-on → Admins with a password use two-factor sign-in**. An
admin with a password and no second factor then sees only the setup page until they set it up; the API refuses them
everything else. Turn it on after you set up your own. Admins who sign in only with single sign-on or a provider have
no password here: your identity provider asks for its own second factor.

Codes by email or text message are off: the server sends neither.

## Google, GitHub and Microsoft

Each is turned on by setting both its values (see [Configuration](/self-hosting/configuration#sign-in-providers)).
Register this redirect URL with the provider:

```text
<BETTER_AUTH_URL>/api/auth/callback/google
<BETTER_AUTH_URL>/api/auth/callback/github
<BETTER_AUTH_URL>/api/auth/callback/microsoft
```

For example `https://flags.example.com/api/auth/callback/microsoft`. For Microsoft, set `MICROSOFT_TENANT_ID` to your
directory's tenant ID to allow only your organization (the default, `common`, allows any Microsoft account; who may
join is still decided as above).

Someone with a password account who later signs in with a provider for the same email is the same person.

## Single sign-on (OIDC and SAML)

An admin adds a connection in **Settings → Single sign-on**: a connection ID (lowercase letters, digits and dashes,
e.g. `okta`), the email domains it signs in, and the identity provider's details. The drawer shows what to enter on
the identity provider's side before you save.

### OIDC

On your side: the issuer URL, client ID and client secret of an app you make for CompanyFlags in the identity
provider (Okta, Entra ID, Google Workspace, Auth0, Keycloak and others).

On the identity provider's side, the sign-in redirect URI:

```text
<console>/api/auth/sso/callback/<connection id>
```

When you save, the server reads the issuer's `/.well-known/openid-configuration` and checks that it names the same
issuer. The issuer must be on the public internet unless its origin is in `BETTER_AUTH_TRUSTED_ORIGINS`: the address
is checked as the connection is made, and redirects aren't followed. If something is wrong, the message says so
without repeating what the address answered. It asks for the `openid`, `email` and `profile` scopes and uses PKCE. In production the issuer must be
`https`. The client secret stays on the server and is never shown again.

### SAML 2.0

On your side: the identity provider's metadata XML, or its sign-in (SSO) URL, entity ID and signing certificate.

On the identity provider's side:

| Setting | Value |
|---|---|
| ACS URL (reply URL) | `<console>/api/auth/sso/saml2/sp/acs/<connection id>` |
| Entity ID (audience) | `<console>/api/auth/sso/saml2/sp/metadata?providerId=<connection id>` |
| SP metadata URL | the same address as the entity ID |
| Name ID | the person's email address (`emailAddress` format) |

SAML answers must be signed. They are checked against the request they answer, and each works once.

`<console>` is `BETTER_AUTH_URL` when it is set, otherwise the address of the admin's own request.

### Signing in

People type their work email on the sign-in page and choose **Sign in with SSO**. Everyone at the connection's
domains can sign in and joins with the join role. Someone with a password account at that email becomes the same
person. Nobody at another domain joins through it, even someone an admin added.

A domain can belong to only one connection. Only admins add, change or remove connections, signed in (never with an
access token): Better Auth's own endpoints for managing them are switched off.

### Test sign-in and editing

**Test sign-in** on a connection's row sends you to the identity provider and back. You come back signed in as
whoever signed in there, so sign in as yourself, or test as someone else in a private window. The row then says when
someone last signed in with it.

**Edit** changes a connection's domains, its identity provider's details and its group roles. A client secret, a
certificate or metadata left empty stays as it was. Its protocol and its ID stay: for another, add a new connection.
History records each change, never the secret.

### Require single sign-on

Turn on **Require single sign-on** on a connection's row. It can be turned on only once someone has signed in with
the connection, so a connection that doesn't work can't lock people out, and it asks you to confirm first. Then nobody
at its domains (and their subdomains) signs in with a password, Google, GitHub or Microsoft, or makes a password
account.

One admin keeps their password there: the **break-glass admin**, chosen in **Settings → Single sign-on → Break-glass
admin**, in case the identity provider is down. Every other admin uses single sign-on too. With nobody chosen, nobody
keeps a password. The break-glass admin counts only while they are an admin; choosing another one signs the old one
out where single sign-on is required.

Turning it on signs out everyone at its domains but the break-glass admin, at once. They sign in again with single
sign-on.

### What leaving the identity provider does

Where single sign-on is required, each session lasts **12 hours** at most (`FF_SSO_SESSION_HOURS`, from 1 to 720).
Then it ends, and signing in again asks the identity provider whether the person still works there. So someone
removed from your identity provider is out of the console within 12 hours, without anyone doing anything here.

**Access tokens** aren't sessions: a token keeps working until it expires (90 days by default, a year at most) or is
revoked. When someone leaves, **Remove** them in Settings → People: that ends their sessions and tokens at once.

Where single sign-on isn't required, a session lasts 7 days and renews while it's used, so leaving the identity
provider ends nothing by itself: remove the person in People.

### Group roles

A connection can give roles from the identity provider's groups. In its drawer, under **Roles from your identity
provider's groups**, name the OIDC claim or SAML attribute that lists the person's groups (often `groups`), and give
groups their roles, one per line:

```text
flag-admins = admin
flag-approvers = approver
flag-editors = editor
```

Each time someone signs in with the connection, they get the highest role of their groups that are named, and the
join role when none is. A role set in People is replaced at their next sign-in. The break-glass admin's role is left
alone, and the last admin is never made anything else. History records each change, by `sso:<connection id>`.

Make sure the identity provider sends the groups: in the ID token or the user info for OIDC (Okta: a groups claim on
the app; Entra ID: "Groups claim" in Token configuration), or as an attribute of the SAML answer. Groups give one role
for everything; roles per environment or per entity aren't built.

### An identity provider on a private network

The server refuses to read an issuer's settings from this machine, a private network or a cloud metadata address. If
your identity provider is on your private network, add its origin to `BETTER_AUTH_TRUSTED_ORIGINS`, e.g.
`BETTER_AUTH_TRUSTED_ORIGINS=https://idp.internal.example.com`.

## Sessions

A session lasts 7 days and is renewed while it is used. Where single sign-on is required, it lasts 12 hours at most
(`FF_SSO_SESSION_HOURS`). Changing `BETTER_AUTH_SECRET` signs everyone out.

- Turning on **Require single sign-on** ends the sessions of everyone at its domains but the break-glass admin, at
  once, single sign-on sessions too. They sign in again with single sign-on.
- **Remove** in Settings → People ends that person's sessions at once.
- Removing a single sign-on connection signs out everyone who signed in through it, at once.

People shows when each person last signed in. Each sign-in, and each one that didn't go through (a wrong password or
code, a refusal), is in History, and can go to a SIEM: see [Webhooks](/guide/webhooks#security-events).

## Removing access

**Settings → People → Remove** signs the person out everywhere, deletes their accounts (password, providers, single
sign-on, two-factor), and revokes their access tokens and their agents' OAuth sign-ins. They stay in the list and in
History, with their role. **Invite again** gives them a new invite link and their role back, not their old tokens.
You can't remove yourself, and there is always at least one admin.

People, invites, password resets, single sign-on, the sign-in rules and the appearance are changed by an admin signed
in to the console: access tokens are refused there.

## Roles

| Role | In the API | What it may do |
|---|---|---|
| Viewer | `viewer` | Look at everything, use the Debug tab and Compare. Changes nothing, and can't see app links. |
| Editor | `editor` | Change flags and entities, see and replace app links. |
| Approver | `approver` | What an editor does, and review other people's requests. |
| On call | `oncall` | What an approver does, and break-glass in a protected environment: turn any flag off, serve a kill switch's safe value, pause a release, or roll a version release back, without review and with a reason. |
| Admin | `admin` | Everything, including Settings (environments, services, dimensions, people, single sign-on, the CDN) and API keys. An admin's access token is On call at most. |

Nobody approves their own request. The roles are defined in
[`server/policy.ts`](https://github.com/dvir-daniel/companyflags/blob/main/server/policy.ts); see
[Approvals and history](/guide/approvals).

## Not built yet

- **Email.** The server sends none: invite links and password reset links are made by an admin and sent by hand, and
  email addresses aren't verified by a code (invites only work for the address they were made for).
- **SCIM provisioning.** People are added on their first single sign-on, not ahead of it, and leaving your identity
  provider doesn't remove them here. Where single sign-on is required, their sessions end within 12 hours; their
  access tokens don't, so remove them in Settings → People when they leave.
- **Single logout.** Signing out of the identity provider doesn't end the console session.
- **Roles per environment or entity.** A person, and a group, has one role everywhere.
- **Passkeys.** Two-factor sign-in is an authenticator app's code or a recovery code.
