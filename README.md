<p align="center">
  <picture>
    <source srcset=".github/assets/banner-dark.png" media="(prefers-color-scheme: dark)">
    <source srcset=".github/assets/banner-light.png" media="(prefers-color-scheme: light)">
    <img src=".github/assets/banner-light.png" alt="CompanyFeatures: the most comprehensive feature flag framework">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/dvir-daniel/companyfeatures/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/dvir-daniel/companyfeatures/ci.yml?branch=main&style=flat&colorA=000000&colorB=000000&label=CI" alt="CI"></a>
  <a href="LICENSE.md"><img src="https://img.shields.io/badge/license-MIT-000000?style=flat&colorA=000000&colorB=000000" alt="MIT license"></a>
  <a href="https://openfeature.dev"><img src="https://img.shields.io/badge/OpenFeature-OFREP%20%7C%20flagd-000000?style=flat&colorA=000000&colorB=000000" alt="OpenFeature"></a>
  <a href="https://github.com/dvir-daniel/companyfeatures/stargazers"><img src="https://img.shields.io/github/stars/dvir-daniel/companyfeatures?style=flat&colorA=000000&colorB=000000" alt="GitHub stars"></a>
</p>

<p align="center">
  The most comprehensive feature flag framework: open source, self-hosted, and read with OpenFeature.
  <br>
  <a href="https://dvir-daniel.github.io/companyfeatures/"><strong>Learn more »</strong></a>
  <br>
  <br>
  <a href="https://dvir-daniel.github.io/companyfeatures/guide/quickstart">Quickstart</a>
  ·
  <a href="https://dvir-daniel.github.io/companyfeatures/">Docs</a>
  ·
  <a href="https://github.com/dvir-daniel/companyfeatures/issues">Issues</a>
  ·
  <a href="https://github.com/dvir-daniel/companyfeatures/discussions">Discussions</a>
</p>

## About the project

CompanyFeatures is everything feature flags and remote config need, in one server you run yourself: rules and %
rollouts, releases, reviewed changes and a full history, settings for any part of your product, and OpenFeature for
every app and backend.

<p align="center">
  <img src=".github/assets/console.png" alt="The console: a release flag with an override, settings for one company, and a rule for 10% of devices">
</p>

### Why CompanyFeatures?

Feature flags start simple and grow. Some rules must hold for everyone, whatever else is set. Parts of your product
need settings of their own. Production changes need a second pair of eyes and a way back. Every app and backend should
get the same answer. CompanyFeatures covers all of it in one place, and your code reads it through OpenFeature.

- **Your own dimensions.** Serve config per `region` › `store`, per `team`, per `customer` › `brand`, or whatever
  your product is made of. You name the levels, up to four.
- **Settings per entity, rules for everyone.** Any region, store or customer can have settings of its own on any flag,
  inherited down the chain. Locked rules apply to everyone, always. The console traces every answer step by step.
- **OpenFeature, no SDK of ours.** Apps use OpenFeature's own OFREP providers (web, Android, iOS); backends use OFREP
  or flagd JSON, evaluated in-process. Your flag-reading code stays standard.
- **Nothing private reaches a device.** An app asks as its own entity, with a token it can't change, and gets its own
  answers only: no rules, no lists of entities, no one else's values.
- **Reviewed changes.** Production can require an approval for every change, with scheduling, break-glass for on
  call, an append-only history, restore, and side-by-side compare.
- **Releases and version releases.** Give early access to a few, then 1% → 5% → 25% → 50% of devices,
  then everyone, then clean it up; or move devices from version 1.0.0 to 1.0.1 the same way, with rollback.
- **Move over one flag at a time.** Run it next to the config system you have now: import its values (key-value
  JSON, flagd, or any shape through JSONata), apps read the old system for what hasn't moved, and webhooks out and in
  keep both the same until the last flag is here.
- **Your sign-in.** Email and password, Google, GitHub or Microsoft, and single sign-on with SAML or OIDC, through
  [Better Auth](https://www.better-auth.com).
- **Cheap at any scale.** Every entity's values are also one file your CDN caches, rebuilt once per publish, for
  fleets where no request should reach the server.
- **Plugins, one config file, a CLI.** Built the way Better Auth is: a small core, plugins for each way flags are read,
  one typed `companyfeatures.config.ts`, and a `companyfeatures` command that migrates and keeps your flags as code.

## Quickstart

```bash
docker run -d -p 8787:8787 -v companyfeatures:/data \
  -e BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
  -e BETTER_AUTH_URL=http://localhost:8787 \
  ghcr.io/dvir-daniel/companyfeatures
```

Open <http://localhost:8787>, create the admin account, and the console walks you through four steps: environments,
flag sets, dimensions, and your first flag.

For production, run it with Postgres:

```bash
curl -O https://raw.githubusercontent.com/dvir-daniel/companyfeatures/main/docker-compose.yml
echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)" > .env
docker compose up -d
```

Or from source (Node.js 22.18+, pnpm 11):

```bash
git clone https://github.com/dvir-daniel/companyfeatures.git && cd companyfeatures
corepack enable && pnpm install
pnpm serve           # builds the console and serves it with the API on http://localhost:8787
```

## Read flags with OpenFeature

Each app reads a flag set: the flags you put in it. Your backend gets the app's token when someone signs in
(`GET /sdk/v1/links/<dimension>/<entity>?flagSet=web`, with an API key). The app uses OpenFeature's own OFREP provider:

```ts
import { OpenFeature } from '@openfeature/web-sdk';
import { OFREPWebProvider } from '@openfeature/ofrep-web-provider';

await OpenFeature.setContext({ targetingKey: installId, app: { version: '6.0.0' } });
await OpenFeature.setProviderAndWait(new OFREPWebProvider({
  baseUrl: 'https://flags.example.com',
  headers: [['Authorization', `Bearer ${session.flagsToken}`]],
}));

OpenFeature.getClient().getBooleanValue('new_checkout', false);
```

A backend uses its API key and names the entity by its dimension, as the rules do:

```ts
const limit = await client.getNumberValue('max_upload_mb', 100, { company: 'acme', targetingKey: userId });
```

Or it runs [flagd](https://flagd.dev) next to it, which downloads the entity's rules as flagd JSON, and evaluates every
flag in memory. See [OpenFeature](https://dvir-daniel.github.io/companyfeatures/sdk/openfeature) and
[Backends](https://dvir-daniel.github.io/companyfeatures/guide/backends).

## Configure it

Everything is optional: without a file, environment variables decide. With one, it's typed, like Better Auth's
`auth.ts`:

```ts
// companyfeatures.config.ts (companyfeatures init writes one)
import { defineConfig } from 'companyfeatures/config';
import { appFiles, cloudflare, flagd, ofrep, webhooks } from 'companyfeatures/plugins';

export default defineConfig({
  database: { url: process.env.DATABASE_URL },
  auth: { baseURL: 'https://flags.example.com' },
  plugins: [ofrep(), flagd(), appFiles(), cloudflare(), webhooks()],
});
```

Keep the flags your code reads in a file next to it, and push it from CI:

```bash
companyfeatures flags plan     # what would change
companyfeatures flags push     # new flags, details, variants, flag sets; reviewed where production needs it
```

See [Plugins](https://dvir-daniel.github.io/companyfeatures/reference/plugins),
[CLI](https://dvir-daniel.github.io/companyfeatures/reference/cli) and
[Architecture](https://dvir-daniel.github.io/companyfeatures/guide/architecture).

## How it works

<p align="center">
  <picture>
    <source srcset=".github/assets/how-it-works-dark.png" media="(prefers-color-scheme: dark)">
    <source srcset=".github/assets/how-it-works-light.png" media="(prefers-color-scheme: light)">
    <img src=".github/assets/how-it-works-light.png" width="720" alt="How it works: describe your dimensions, decide with rules then defaults, read with OpenFeature; a change goes from draft to approved, published, a change event, and every device">
  </picture>
</p>

One evaluator decides every answer: OFREP's, the app files', the backends' flagd JSON and the console's trace. The
tests check each against it, with OpenFeature's own providers and flagd's own logic, for many entities and devices
(about 380 tests, on embedded and real Postgres). Several server instances can share one Postgres database.

## Documentation

| | |
|---|---|
| [Introduction](https://dvir-daniel.github.io/companyfeatures/guide/introduction) | What it is, who it's for, what it doesn't do yet |
| [Concepts](https://dvir-daniel.github.io/companyfeatures/guide/concepts) | Environments, flag sets, dimensions, flags, rules |
| [OpenFeature](https://dvir-daniel.github.io/companyfeatures/sdk/openfeature) | Web, React, Android, iOS and backends |
| [Migration](https://dvir-daniel.github.io/companyfeatures/guide/migration) | Moving from another system, import, export, webhooks |
| [Self-hosting](https://dvir-daniel.github.io/companyfeatures/self-hosting/docker) | Docker, configuration, sign-in, CDN, production |
| [Plugins](https://dvir-daniel.github.io/companyfeatures/reference/plugins) and [CLI](https://dvir-daniel.github.io/companyfeatures/reference/cli) | The built-in plugins, writing your own, and the `companyfeatures` command |
| [HTTP API](https://dvir-daniel.github.io/companyfeatures/reference/http-api) | OFREP, app files, flagd JSON, links, health |

The docs are in [`docs/`](docs) and run locally with `pnpm docs:dev`.

## Status

CompanyFeatures is before 1.0: tested and usable, but young, and the console's own API may change. Not built yet:
experiment statistics, your own attributes beyond the built-in list, sending email (invite and password reset links
are sent by hand), SCIM provisioning, and secret values (don't put secrets in flags). See
[the introduction](https://dvir-daniel.github.io/companyfeatures/guide/introduction#what-it-doesn-t-do-yet).

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) explains how to set up (`pnpm dev`), how the
code is organised and what we check (`pnpm check`). Please read the [code of conduct](CODE_OF_CONDUCT.md).

## Security

Please report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md). Never in a public issue.

## License

[MIT](LICENSE.md)
