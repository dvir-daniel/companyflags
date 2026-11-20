# Contributing to CompanyFlags

Thanks for helping. Bug reports, docs fixes, tests and features are all welcome. For anything bigger than a small fix,
open an issue or a discussion first, so we can agree on the shape before you spend time on it.

By contributing you agree that your work is released under the project's [MIT license](LICENSE.md), and you follow our
[code of conduct](CODE_OF_CONDUCT.md). Security problems go to **Security → Report a vulnerability**, never to a public
issue ([SECURITY.md](SECURITY.md)).

## Set up

You need Node.js 22.18 or later (24 recommended; Node runs the TypeScript directly) and pnpm 11 (`corepack enable`
gives you the right one).

```bash
git clone https://github.com/dvir-daniel/companyflags.git
cd companyflags
pnpm install
pnpm dev          # the console on http://localhost:5173 with hot reload, the API on :8787 restarting on changes
```

Data lives in `./data` (embedded Postgres, nothing to install); delete the folder to start over. `pnpm serve` builds
the console and serves it with the API on http://localhost:8787, as in production.

## What's where

| Path | What it is |
|---|---|
| `server/` | The server: Hono on Node. `evaluator.ts` decides every answer; `api.ts` is the console's API; `plugin.ts` and `plugins/` are the plugins (OFREP in `ofrep.ts`, app files and flagd JSON in `delivery.ts`, the Cloudflare purge in `cdn.ts`); `config.ts` is the type of `companyflags.config.ts` and `configFile.ts` reads it; `cli.ts` is the `companyflags` command, with flags as code in `flagsAsCode.ts`; `access.ts` and `policy.ts` decide who may do what; `migrations/` is the schema |
| `web/` | The console: React 19, Vite, Tailwind 4 |
| `packages/ui` | The console's design system (tokens, components); [DESIGN.md](packages/ui/DESIGN.md) has the rules |
| `packages/companyflags` | The npm package, built from `server/` and `web/dist` by `build.ts` (`pnpm pack:npm`; `pnpm test:npm` installs it and tries it). Not a workspace project: its version and dependencies are the root's |
| `test/` | The server's and console's tests (`node --test`) |
| `docs/` | The documentation site (Next.js and Fumadocs, like better-auth.com): pages in `docs/content/docs/`, the landing page and illustrations in `docs/components/`; `docs/design/` holds design notes and decision records |
| `examples/` | Example apps (React, Node, flagd), each its own package with its own `pnpm build`; not in the root's typecheck or lint. `seed.ts` sets up a server for them |
| `GLOSSARY.md` | Words we use, and the ones we avoid |

## Checks

```bash
pnpm check        # types (server and console), lint (oxlint), and every test
pnpm test         # just the tests: about 20 seconds, on an in-memory database
pnpm test:pg      # the same tests on a real Postgres server (each test file in its own new database)
```

For `pnpm test:pg`, start a Postgres server first:

```bash
docker run -d -p 55432:5432 -e POSTGRES_PASSWORD=postgres postgres:18
```

CI runs all of these on every pull request.

## How we build

- **One evaluator.** `server/evaluator.ts` decides every answer. OpenFeature's OFREP answers (`ofrep.ts`), flagd
  JSON (`flagd.ts`: backends' and apps' CDN files) and the console's trace all come from it, and tests check each
  of them against it, with OpenFeature's own providers and flagd's own logic, for many devices and entities.
- **No SDK of our own.** Apps and backends use OpenFeature's providers (OFREP, flagd). A new delivery feature fits one of
  those protocols, or it isn't built.
- **The schema only moves forward.** A schema change is the next numbered file in `server/migrations/`. Never edit a
  file a real database has applied: the server refuses to start if an applied file changed.
- **No fixed business words.** Each installation names its own dimensions (customer, company › brand, region ›
  store), so nothing a console user or rule author reads may say "customer", "tenant" or "brand" on its own.
  `test/no-domain-words.test.ts` checks it; use the installation's words (`server/words.ts`, `web/src/dimWords.ts`).
- **Console files.** A `.tsx` file exports only components, so React Fast Refresh can swap it in place. Hooks, class
  strings and helpers go in a `.ts` file beside it (`uiKit.ts`, `pages/settingsKit.ts`).
- **Plain words.** Console text and docs say what happens in short, plain sentences: "Production needs an approval",
  not "Approval workflow is enforced for protected environments". Words we use: [GLOSSARY.md](GLOSSARY.md).
- **Tests come with the change.** Anything about who may do what (sign-in, roles, API keys, links) or about what a
  device gets needs a test that would fail without your change.

## Pull requests

- Keep each pull request to one change, with a title that says what changes for people using CompanyFlags.
- Fill in the template: what changes, how you tested it.
- A maintainer reviews within a few days. We may ask for changes; that's normal, not a rejection.

## Releases

Maintainers release with a `vX.Y.Z` tag: it builds and publishes the Docker image
(`ghcr.io/dvir-daniel/companyflags`), the npm package `companyflags` ([npm.yml](.github/workflows/npm.yml) says
what to set up once), and a GitHub release with that version's notes from [CHANGELOG.md](CHANGELOG.md). Bump the
version in both `package.json` and `packages/companyflags/package.json`. Add your change to the "Unreleased" section of CHANGELOG.md.
