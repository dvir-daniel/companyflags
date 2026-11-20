# Changelog

Every release of the server and console. The Docker image's tags follow these versions.

## 0.1.0

The first public release.

- **Dimensions.** Each installation defines what config is served per: one chain of up to four levels, in its own
  words (`customer`; `company` › `brand`; `region` › `chain` › `store`). Each entity has settings of its own on any
  flag, inherited down the chain, under locked rules that apply to everyone.
- **OpenFeature.** OFREP 0.4 (`/ofrep/v1/evaluate/flags`), for OpenFeature's own providers on the web, Android, iOS
  and servers, with change events (server-sent events) so apps hear about a publish at once. Apps use an app token,
  made from their entity's app link for their flag set; backends use an API key and name the entity in the evaluation
  context. flagd JSON for backends evaluating in-process, with `flagSetId` `<environment>/<flag set>/<entity>`.
- **Flag sets.** Flags are sent in flag sets, OpenFeature's term: groups such as `web`, `ios` and `api`, each for apps
  or for backends, with the flags in it chosen per environment.
- **App files.** One values-only file per environment, flag set and entity, cached by a CDN, purged on publish
  (Cloudflare), readable from any origin.
- **Releases.** A % of devices step by step, early access for some entities, clean-up; version releases (1.0.0 →
  1.0.1) with rollbacks by on call.
- **Change control.** Protected environments with approvals, scheduling, break-glass, an append-only history, restore
  and compare.
- **Sign-in.** Better Auth: email and password, Google, GitHub, Microsoft, single sign-on with SAML or OIDC, invites,
  roles, password reset links made by an admin. Only admins manage API keys. Sign-in rate limits read the connection's
  address, or a header you trust behind a proxy (`FF_CLIENT_IP_HEADER`, `FF_TRUSTED_PROXIES`).
- **Running it.** A Docker image and a Compose file with Postgres; several instances on one database; `/healthz` and
  `/readyz`; security headers and a strict Content-Security-Policy on the console; a first screen that walks an admin
  through setting up.
