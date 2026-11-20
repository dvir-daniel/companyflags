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

- the server (`server/`): the console's API, sign-in and single sign-on, roles and approvals, API keys and app links,
  the app files, OpenFeature remote evaluation (OFREP) and backend downloads;
- the console (`web/`, `packages/ui`);
- the Docker image and the files we publish to deploy it.

Out of scope: problems that need a server admin's own credentials or host access, denial of service by sheer volume
(put a CDN or rate limiter in front, as the docs describe), and reports from automated scanners with no shown impact.

## How CompanyFlags protects an installation

The [security model](docs/guide/security.md) describes it in full. In short:

- **Apps never see rules or other customers' values.** Each app file holds one entity's values only; checks on
  dimensions, apps and environments are settled on the server.
- **App links and API keys** identify an entity or a backend. An app's link (as an address or as its OpenFeature token)
  reads that entity only; replacing it stops the old one at once. Apps never hold an API key.
- **Sign-in** uses [Better Auth](https://www.better-auth.com): cookie sessions, password hashes, OAuth tokens stored
  encrypted, rate limits in production, single sign-on with SAML (signed answers only) or OIDC.
- **Changes from the console** need a header another site can't send, so a page elsewhere can't act with your cookie.
- **Protected environments** require approval from someone other than the author, and every change is kept in an
  append-only history.
