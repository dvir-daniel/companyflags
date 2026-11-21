---
title: "Enterprise"
description: "What a large organization needs from feature flags, and where each part is in CompanyFlags."
---

CompanyFlags is free and open source under the MIT license. There's no paid plan and no enterprise edition: everything
on this page is in the same server you run with one `docker run`. It runs on your own servers, so your flags, your
users and their data never leave them.

## Sign-in with your identity provider

People sign in with your organization's single sign-on, over **SAML 2.0** or **OIDC** (Okta, Entra ID, Google
Workspace, JumpCloud and others). People at your email domains can join by themselves, with the role you choose
(Viewer by default), or the role their identity provider groups give. Require single sign-on, and someone removed
from the identity provider is out of the console within 12 hours; one break-glass admin keeps a password. Email and
password (with two-factor sign-in, which you can require of admins), Google, GitHub and Microsoft sign-in work too.
Sign-ins and other security events can go to your SIEM. See [Single Sign-On](/self-hosting/single-sign-on) and [Sign-In](/self-hosting/sign-in).

## Roles and approvals

- **Five roles:** viewer, editor, approver, on call and admin. Each person has one, and an access token is never
  above its person's role. See [Roles](/guide/approvals#roles).
- **Approvals per environment:** Production can need one or more approvals before any change goes out. Nobody
  approves their own change. See [Protected environments](/guide/approvals#protected-environments).
- **Scheduled changes:** an approved change can wait for the time you choose.
- **Break-glass:** on call can turn any flag off, pause a release, or serve a kill switch's safe value in an emergency,
  without waiting for approval. The change is recorded with its reason. See [Break-glass](/guide/approvals#break-glass).

## Audit history and restore

Every change is kept in an append-only history: who made it, when, from where (the console, a token, an agent or a
webhook) and what it changed. You can filter it and export it to CSV. Each environment has versions you can compare and
restore. See [History](/guide/approvals#history) and [Revisions and restore](/guide/approvals#revisions-and-restore).

## Security

- **Apps get values only:** never the rules, and never a list of your customers or other entities.
- **Keys per service and environment:** backend keys are refused from a browser.
- **Signed app links:** these can be turned on per entity.
- **Tokens and agents:** access tokens act as their person, and AI agents sign in with OAuth and act with a role you
  choose.

See the [Security model](/guide/security).

## Your look

Each server can show its own name, logo and colors in the console, and a notice for everyone or a note on the sign-in
page. You can set it in the console, or in the config file so it's kept in Git. See [Appearance](/self-hosting/appearance).

## Running it at scale

- **Your own Postgres:** use your backups and replicas.
- **Several instances:** run them behind a load balancer, on one database.
- **CDN files:** each file is cached per entity, so very large fleets of devices read from the cache. With
  Cloudflare set up, each publish clears it within seconds.
- **Operations:** health checks and graceful shutdown. Upgrades migrate the database when the server starts.

See the [Self-Hosting Overview](/self-hosting/overview), [Monitoring](/self-hosting/monitoring) and [CDN](/self-hosting/cdn).

## Moving over from another system

Run CompanyFlags next to the system you have now, import its flags, and move one flag at a time. Webhooks keep both the
same while both run. See [Moving from another system](/guide/migration) and [Webhooks](/guide/webhooks).

## Support

Questions, bugs and feature requests go to [GitHub issues](https://github.com/dvir-daniel/companyflags/issues). Report
security problems privately, as [Security](/guide/security#reporting-a-vulnerability) says.
