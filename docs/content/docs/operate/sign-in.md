---
title: "Sign-In and People"
description: "The first account, who can join, passwords, two-factor, and sign-in with Google, GitHub or Microsoft."
---

Every install needs this page: it makes the first account and decides who else gets in. People sign in to the
console with an email and password, with Google, GitHub or
Microsoft when you set them up, or with your organization's identity provider
([Single Sign-On](/operate/single-sign-on)). The session is a cookie. Accounts, sessions and password hashes are
kept in your database; each person's role is kept next to them, and the two meet on the email.

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

:::warning[Make the account right after the first start]
Until the admin account exists, whoever has the link can make it, and the link is in the server's log at every
start. On every platform, make the account as soon as the server first starts, and limit who can read the logs until
then. Keep the link as you keep the secret: don't paste it anywhere others can read.
:::

- The link is built on `FF_PUBLIC_URL` (or the server's own address without it). Its secret is made from
  `FF_SECRET`, so it stays the same across restarts, and every instance on one database prints the same one.
  Nothing about it is stored.
- It works until the first account exists. After that, or with a wrong secret, it answers `404`.
- Until then nobody else can join at all: not with Google, GitHub or Microsoft at a domain in `FF_SIGNUP_DOMAINS`,
  and not with single sign-on.
- Scripts can send the secret in an `X-Setup` header instead of opening the link.

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
gives them a role in People, or the identity provider's groups do (see [Single Sign-On → Group roles](/operate/single-sign-on#group-roles)). People an admin
added keep the role the admin chose, however they sign in, unless they sign in with a connection that gives roles
from groups: then their groups decide, at each sign-in with it.

Password accounts are only made from an invite link (or as the first account, with the setup link), so nobody can
claim an address they weren't invited as. Passwords have at least 10 characters.

## Email and password

Always on. An invited person opens their link, chooses a name and a password, and is signed in. Later they sign in
with the same email and password, unless a single sign-on connection for their domain requires single sign-on
([Single Sign-On → Require single sign-on](/operate/single-sign-on#require-single-sign-on)).

## Forgotten passwords

The server sends no email, so an admin makes the reset link: **Settings → People → Reset password** on the person's
row. Send it to them however you like. It works once, for 24 hours; they choose a new password (at least 10
characters) and are signed out everywhere. The link is shown once, and History records that it was made.

It also gives a **first password** to someone who signed in only with single sign-on or a provider. That is how
people get back in when they have no other way: their connection was removed, or their identity provider is down.
History marks it `first: true`. Where single sign-on is still required at their domain, the password works only for
the break-glass admin, and the link says so; see [Single Sign-On → When the identity provider is down](/operate/single-sign-on#when-the-identity-provider-is-down).
Someone with no account yet gets an invite link instead. Asking for a reset by email is switched off.

A reset link also turns off the person's two-factor sign-in, for someone who lost their phone and their recovery
codes. They set it up again.

## Two-factor sign-in

Anyone with a password can add a second step: a code from an authenticator app (1Password, Google Authenticator,
Authy and others). They set it up in their account menu → **Access tokens and two-factor sign-in → Set up**: their
password, then the app's setup key, then a code from the app. They also get ten **recovery codes**, shown once; each
signs in once, for a lost phone. **New recovery codes** replaces them.

Then signing in with a password asks for the code next. Ten wrong codes in a row lock the second step for 15 minutes.
The secret and the recovery codes are kept encrypted with `FF_SECRET`. After that secret changes, the codes
can't be read, and everyone who uses two-factor needs a reset link
([Configuration → Changing a secret](/reference/configuration#changing-a-secret)).

To require it of admins, turn on **Settings → Single Sign-On → Admins with a password use two-factor sign-in**. An
admin with a password and no second factor then sees only the setup page until they set it up; the API refuses them
everything else. Their access tokens are refused too, even ones made before, and their MCP clients can't sign in over
OAuth or renew a sign-in, until they set it up. Turn it on after you set up your own. Admins who sign in only with
single sign-on or a provider have no password here: your identity provider asks for its own second factor.

Codes by email or text message are off: the server sends neither.

## Google, GitHub and Microsoft

Each is turned on by setting both its values (see [Configuration](/reference/configuration#sign-in-providers)).
Register this redirect URL with the provider:

```text
<FF_PUBLIC_URL>/api/auth/callback/google
<FF_PUBLIC_URL>/api/auth/callback/github
<FF_PUBLIC_URL>/api/auth/callback/microsoft
```

For example `https://flags.example.com/api/auth/callback/microsoft`. For Microsoft, set `MICROSOFT_TENANT_ID` to your
directory's tenant ID to allow only your organization (the default, `common`, allows any Microsoft account; who may
join is still decided as above). When `FF_SIGNUP_DOMAINS` includes a domain your Entra directory owns, set
`MICROSOFT_TENANT_ID`: then only your directory's accounts at that domain join by themselves.

Someone with a password account who later signs in with a provider for the same email is the same person.

## Sessions

A session lasts **7 days** and is renewed while it is used. Where a single sign-on connection requires single
sign-on, it lasts **12 hours** at most (`FF_SSO_SESSION_HOURS`, from 1 to 720). Then it ends, and signing in again
asks the identity provider whether the person still works there. Changing `FF_SECRET` signs everyone out.

- Turning on **Require single sign-on** ends the sessions of everyone at its domains but the break-glass admin, at
  once, single sign-on sessions too. They sign in again with single sign-on.
- **Remove** in Settings → People ends that person's sessions at once.
- Removing a single sign-on connection signs out everyone who signed in through it, at once.

People shows when each person last signed in. Each sign-in, and each one that didn't go through (a wrong password or
code, a refusal), is in History, and can go to a SIEM: see [Webhooks](/integrations/webhooks#security-events).

## Removing access

**Settings → People → Remove** signs the person out everywhere, deletes their accounts (password, providers, single
sign-on, two-factor), and revokes their access tokens and their agents' OAuth sign-ins. They stay in the list and in
History, with their role. **Invite again** gives them a new invite link and their role back, not their old tokens.
You can't remove yourself, and there is always at least one admin.

People, invites, password resets, single sign-on, the sign-in rules and the appearance are changed by an admin signed
in to the console: access tokens are refused there.

## Roles

Each person has one role: Viewer, Editor, Approver, On call or Admin. An admin sets it in **Settings → People**, or
an identity provider's groups do. What each may do is in [Approvals and history → Roles](/guide/approvals#roles).

## Not built yet

- **Email.** The server sends none: invite links and password reset links are made by an admin and sent by hand, and
  email addresses aren't verified by a code (invites only work for the address they were made for).
- **Passkeys.** Two-factor sign-in is an authenticator app's code or a recovery code.
- **Roles per environment or entity.** A person, and a group, has one role everywhere.
- SCIM provisioning and single logout: see [Single Sign-On → Not built yet](/operate/single-sign-on#not-built-yet).

## Next

Sign in with your identity provider: [Single Sign-On](/operate/single-sign-on). Without one:
[Appearance](/operate/appearance).
