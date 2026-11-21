---
title: "Single Sign-On"
description: "Sign in with your organization's identity provider over OIDC or SAML, require it, and keep a way in when it's down."
---

This page is optional: it is for an organization with its own identity provider (Okta, Entra ID, Google Workspace,
Auth0, Keycloak and others). People then sign in to the console with it, over OIDC or SAML 2.0. Without one, people
sign in as [Sign-In](/operate/sign-in) says.

## Add a connection

An admin adds a connection in **Settings → Single Sign-On**: a connection ID (lowercase letters, digits and dashes,
e.g. `okta`), the email domains it signs in, and the identity provider's details. The drawer shows what to enter on
the identity provider's side before you save.

`<console>` below is `FF_PUBLIC_URL` when it is set, otherwise the address of the admin's own request.

### OIDC

On your side: the issuer URL, client ID and client secret of an app you make for CompanyFlags in the identity
provider.

On the identity provider's side, the sign-in redirect URI:

```text
<console>/api/auth/sso/callback/<connection id>
```

When you save, the server reads the issuer's `/.well-known/openid-configuration` and checks that it names the same
issuer.

- The issuer must be on the public internet unless its origin is in `FF_TRUSTED_ORIGINS` (see
  [below](#an-identity-provider-on-a-private-network)). The address is checked as the connection is made, and
  redirects aren't followed.
- So must the token, keys (JWKS) and user info addresses it gives (`https` in production). At each sign-in, the
  server reaches them through the same checked connection, so a name that later points at your network is refused.
- If something is wrong, the message says so without repeating what the address answered.
- It asks for the `openid`, `email` and `profile` scopes and uses PKCE.
- In production the issuer must be `https`.
- The client secret stays on the server and is never shown again.

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

## Signing in

People type their work email on the sign-in page and choose **Sign in with SSO**. Everyone at the connection's
domains (subdomains included) can sign in, and joins with the join role
([Sign-In → Who can join](/operate/sign-in#who-can-join)). Someone with a password account at that email becomes
the same person. Nobody at another domain joins through it, even someone an admin added.

A domain can belong to only one connection. Only admins add, change or remove connections, signed in (never with an
access token): the sign-in's own endpoints for managing them are switched off.

## Test sign-in and editing

**Test sign-in** on a connection's row sends you to the identity provider and back. You come back signed in as
whoever signed in there, so sign in as yourself, or test as someone else in a private window. The row then says when
someone last signed in with it.

**Edit** changes a connection's domains, its identity provider's details and its group roles. A client secret, a
certificate or metadata left empty stays as it was. Its protocol and its ID stay: for another, add a new connection.
History records each change, never the secret.

On a connection that requires single sign-on:

- **A change to the identity provider's details** (OIDC: issuer, client ID or client secret; SAML: metadata, sign-in
  URL, entity ID or certificate) turns the requirement off and forgets the last test sign-in. Passwords work there
  again until you use **Test sign-in** and require it again. A typo then can't lock everyone out. The drawer says so
  before you save.
- **A new domain** signs out the people at that domain only. Everyone else stays signed in.
- Changing only the group roles changes nothing else.

## Require single sign-on

Turn on **Require single sign-on** on a connection's row. It can be turned on only once someone has signed in with
the connection, so a connection that doesn't work can't lock people out, and it asks you to confirm first. Then nobody
at its domains (and their subdomains) signs in with a password, Google, GitHub or Microsoft, or makes a password
account.

Turning it on signs out everyone at its domains but the break-glass admin, at once, single sign-on sessions too. They
sign in again with single sign-on.

**The break-glass admin** keeps their password there, in case the identity provider is down. Choose them in
**Settings → Single Sign-On → Break-glass admin**.

- They must have a password: give an admin who signs in only with single sign-on one first, with a password link
  (**People → Reset password**).
- Every other admin uses single sign-on too. With nobody chosen, nobody keeps a password.
- The break-glass admin counts only while they are an admin with a password. Choosing another one signs the old one
  out where single sign-on is required.

## When the identity provider is down

1. The break-glass admin signs in with their password.
2. If others need in before it's back, they turn **Require single sign-on** off on the connection.
3. They make each person a password link (**People → Reset password**). It sets a first password for someone who had
   only single sign-on.
4. When the identity provider is back, turn the requirement on again: everyone at its domains signs in with it
   again.

If the connection was removed, step 3 is all it takes: nothing requires single sign-on there any more.

## What leaving the identity provider does

Where single sign-on is required, a session lasts 12 hours at most, then signing in again asks the identity provider
whether the person still works there. So someone removed from your identity provider is out of the console within
12 hours, without anyone doing anything here. See [Sign-In → Sessions](/operate/sign-in#sessions).

**Access tokens** aren't sessions: a token keeps working until it expires (90 days by default, a year at most) or is
revoked. When someone leaves, **Remove** them in **Settings → People**: that ends their sessions and tokens at once.

Where single sign-on isn't required, leaving the identity provider ends nothing by itself: remove the person in
People.

## Group roles

A connection can give roles from the identity provider's groups. In its drawer, under **Roles from your identity
provider's groups**, name the OIDC claim or SAML attribute that lists the person's groups (often `groups`), and give
groups their roles, one per line:

```text
flag-admins = admin
flag-approvers = approver
flag-editors = editor
```

- Each time someone signs in with the connection, they get the highest role of their groups that are named, and the
  join role when the claim lists none of them.
- A role set in People is replaced at their next sign-in with it.
- A sign-in without the claim at all leaves the role as it is, so a claim named wrong demotes nobody.
- The break-glass admin's role is left alone, and the last admin is never made anything else.
- History records each change, by `sso:<connection id>`.

Make sure the identity provider sends the groups: in the ID token or the user info for OIDC (Okta: a groups claim on
the app; Entra ID: "Groups claim" in Token configuration), or as an attribute of the SAML answer. Groups give one role
for everything; roles per environment or per entity aren't built.

## An identity provider on a private network

The server refuses to read an issuer's settings from this machine, a private network or a cloud metadata address. If
your identity provider is on your private network, add its origin to `FF_TRUSTED_ORIGINS`, e.g.
`FF_TRUSTED_ORIGINS=https://idp.internal.example.com`
([Configuration → Sign-in](/reference/configuration#sign-in)).

## Not built yet

- **SCIM provisioning.** People are added on their first single sign-on, not ahead of it, and leaving your identity
  provider doesn't remove them here. Where single sign-on is required, their sessions end within 12 hours; their
  access tokens don't, so remove them in **Settings → People** when they leave.
- **Single logout.** Signing out of the identity provider doesn't end the console session.

## Next

Give the console your own look: [Appearance](/operate/appearance).
