# Sign-in and single sign-on

People sign in to the console with [Better Auth](https://www.better-auth.com): with an email and password, with
Google, GitHub or Microsoft when you set them up, or with your organization's identity provider over OIDC or SAML.
The session is a cookie. Accounts, sessions and password hashes are kept in your database; each person's role is kept
next to them, and the two meet on the email.

Who may join, what each role may do and what removing access takes away are decided in one place,
[`server/access.ts`](https://github.com/dvir-daniel/companyflags/blob/main/server/access.ts).

## The first account

A new install has no accounts. The first person to create one on the sign-in page becomes the **admin**.

::: warning Make the admin account right after deploying
Until it exists, whoever reaches the sign-in page first becomes the admin.
:::

## Who can join

After the first account, nobody makes an account on their own. A person can join when:

- **an admin invited them.** In **Settings → People**, an admin adds the person's email and role and gets an
  **invite link**. The link works once, for 7 days, and only for that email. **Invite link** on their row makes a new
  one; the old one stops working.
- **they sign in with Google, GitHub or Microsoft** and the provider confirms their email, and that email is one an
  admin added, or is at a domain in `FF_SIGNUP_DOMAINS` (exact domain, subdomains not included).
- **they sign in with single sign-on** and their email is at one of the connection's domains (subdomains included),
  or an admin added them.

People who join without an invite start as viewers; an admin gives them a role. People an admin added keep the role
the admin chose, however they sign in.

Password accounts are only made from an invite link (or as the very first account), so nobody can claim an address
they weren't invited as. Passwords have at least 10 characters.

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
issuer. It asks for the `openid`, `email` and `profile` scopes and uses PKCE. In production the issuer must be
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
domains can sign in and joins as a viewer. Someone with a password account at that email becomes the same person.

A domain can belong to only one connection. Only admins add, change or remove connections: Better Auth's own endpoints
for managing them are switched off.

### Require single sign-on

Turn on **Require single sign-on** for a connection, when you add it or later on its row. Then nobody at its domains
signs in with a password or makes a password account, so someone removed from your identity provider can't sign in.
Admins keep their password, in case the identity provider is down.

### An identity provider on a private network

The server refuses to read an issuer's settings from this machine, a private network or a cloud metadata address. If
your identity provider is on your private network, add its origin to `BETTER_AUTH_TRUSTED_ORIGINS`, e.g.
`BETTER_AUTH_TRUSTED_ORIGINS=https://idp.internal.example.com`.

## Sessions

A session lasts 7 days and is renewed while it is used. Changing `BETTER_AUTH_SECRET` signs everyone out.

- Turning on **Require single sign-on** stops new password sign-ins at once. Sessions already open keep working
  until they expire (about 7 days after their last use) or the person is removed.
- **Remove** in Settings → People ends that person's sessions at once.
- Removing a single sign-on connection signs out everyone who signed in through it, at once.

## Removing access

**Settings → People → Remove** signs the person out everywhere and deletes their accounts (password and providers).
They stay in the list and in History, with their role. **Invite again** gives them a new invite link and their role
back. You can't remove yourself, and there is always at least one admin.

## Roles

| Role | In the API | What it may do |
|---|---|---|
| Viewer | `viewer` | Look at everything, run Trace and Compare. Changes nothing, and can't see app links. |
| Editor | `editor` | Change flags and entities, see and replace app links. |
| Approver | `approver` | What an editor does, and review other people's requests. |
| On call | `oncall` | What an approver does, and break-glass in a protected environment: turn a kill switch or ops flag off, or roll a version release back, without review and with a reason. |
| Admin | `admin` | Everything, including Settings (environments, flag sets, dimensions, people, single sign-on, the CDN) and API keys. |

Nobody approves their own request. The roles are defined in
[`server/policy.ts`](https://github.com/dvir-daniel/companyflags/blob/main/server/policy.ts); see
[Approvals and history](/guide/approvals).

## Not built yet

- **Email.** The server sends none: invite links and password reset links are made by an admin and sent by hand, and
  email addresses aren't verified by a code (invites only work for the address they were made for).
- **SCIM provisioning.** People are added on their first single sign-on, not ahead of it, and leaving your identity
  provider doesn't remove them here. A session that is still in use keeps being renewed, so remove them in
  Settings → People when they leave.
- **Single logout.** Signing out of the identity provider doesn't end the console session.
