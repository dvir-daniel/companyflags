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
corepack enable   # the pnpm version package.json names
pnpm install
pnpm dev          # the console on http://localhost:5173 with hot reload, the API on :8787 restarting on changes
```

Data lives in `./data` (embedded Postgres, nothing to install); delete the folder to start over. `pnpm serve` builds
the console and serves it with the API on http://localhost:8787, as in production.

With `pnpm dev` the console isn't built, so it is on :5173 only: the setup link the server prints points there, and
http://localhost:8787 itself just says where the console is.

## What's where

| Path | What it is |
|---|---|
| `server/` | The server: Hono on Node. `evaluator.ts` decides every answer; `api.ts` is the console's API; `plugin.ts` and `plugins/` are the plugins (`plugins/ofrep.ts` serves OFREP from `ofrep.ts`; `plugins/flagd.ts` and `plugins/cdnFiles.ts` serve flagd JSON, made by `flagd.ts`, through `delivery.ts`: backends' downloads and apps' CDN files; `plugins/cloudflare.ts` purges the CDN with `cdn.ts`); `config.ts` is the type of `companyflags.config.ts` and `configFile.ts` reads it; `cli.ts` is the `companyflags` command, with flags as code in `flagsAsCode.ts`; `access.ts` and `policy.ts` decide who may do what; `migrations/` is the schema |
| `web/` | The console: React 19, Vite, Tailwind 4 |
| `packages/ui` | The console's design system (tokens, components); [DESIGN.md](packages/ui/DESIGN.md) has the rules |
| `packages/companyflags` | The npm package, built from `server/` and `web/dist` by `build.ts` (`pnpm pack:npm`; `pnpm test:npm` installs it and tries it). Not a workspace project: its version and dependencies are the root's |
| `test/` | The server's and console's tests (`node --test`) |
| `docs/` | The documentation site (Next.js and Fumadocs): pages in `docs/content/docs/`, the landing page and illustrations in `docs/components/` |
| `examples/` | Example apps (React, Node, flagd), each its own package with its own `pnpm build`; not in the root's typecheck or lint. `seed.ts` sets up a server for them |
| `GLOSSARY.md` | Words we use, and the ones we avoid |

## Checks

```bash
pnpm check        # types (server and console), lint (oxlint), and every test
pnpm test         # just the tests: about 20 seconds, on an in-memory database
pnpm test:pg      # the same tests on a real Postgres server (each test file in its own new database)
```

One file, one test by name, or on every save:

```bash
node --test test/plugins.test.ts
node --test --test-name-pattern="prefixes" test/plugins.test.ts
node --test --watch test/plugins.test.ts
```

The tests' people are in `test/fixtures.ts`: alice is an editor, bob an approver, carol on call and dana an admin.

For `pnpm test:pg`, start a Postgres server first:

```bash
docker run -d -p 55432:5432 -e POSTGRES_PASSWORD=postgres postgres:18
```

`FF_TEST_PG` points `pnpm test:pg` at another Postgres server for the test suite. The server itself never reads it.

CI runs all of these on every pull request.

## How we build

- **One evaluator.** `server/evaluator.ts` decides every answer. OpenFeature's OFREP answers (`ofrep.ts`), flagd
  JSON (`flagd.ts`: backends' and apps' CDN files) and the console's trace all come from it, and tests check each
  of them against it, with OpenFeature's own providers and flagd's own logic, for many devices and entities.
- **No SDK of our own.** Apps and backends use OpenFeature's providers (OFREP, flagd). A new delivery feature fits one of
  those protocols, or it isn't built.
- **The schema only moves forward.** A schema change is the next numbered file in `server/migrations/`. Never edit a
  file a real database has applied: the server refuses to start if an applied file changed. See
  [Adding a migration](#adding-a-migration).
- **The HTTP API's errors** are `{ error, code }`: throw an `HttpError` with a code from `ERROR_CODES`
  (`server/db.ts`) when the status's own isn't the one; never let the database's words through. `/api/v1`
  (`server/apiV1.ts`) is the stable API: add to it, never rename or remove; `docs/reference/http-api.md` lists it,
  and `test/http-api-docs.test.ts` checks the two agree.
- **No fixed business words.** Each installation names its own dimensions (customer, company › brand, region ›
  store), so nothing a console user or rule author reads may say "customer", "company" or "brand" on its own.
  `test/no-domain-words.test.ts` checks those three; use the installation's words (`server/words.ts`,
  `web/src/dimWords.ts`). The generic word is "entity", never "tenant".
- **Console files.** A `.tsx` file exports only components, so React Fast Refresh can swap it in place. Hooks, class
  strings and helpers go in a `.ts` file beside it (`uiKit.ts`, `pages/settingsKit.ts`).
- **Plain words.** Console text and docs say what happens in short, plain sentences: "Production needs an approval",
  not "Approval workflow is enforced for protected environments". Words we use: [GLOSSARY.md](GLOSSARY.md).
- **Tests come with the change.** Anything about who may do what (sign-in, roles, API keys, links) or about what a
  device gets needs a test that would fail without your change.

## Adding a migration

1. Add `server/migrations/00NN_what_it_does.sql`, the next number, starting with `-- Migration 00NN: …` and what it
   does and why.
2. Make it work with the version before it still running (a rolling upgrade,
   [docs/operate/upgrading.md](docs/content/docs/operate/upgrading.md)): add before you remove, and split a
   rename over two releases.
3. Run `pnpm schema` and commit `server/schema.sql`: the schema as the migrations leave it, to read in one place.
   `test/ops.test.ts` fails while it's out of date, and while two files share a number (someone else took yours:
   take the next one, and run `pnpm schema` again).
4. Run `pnpm test:pg` too: PGlite and Postgres differ in small ways.

## Formatting

`.oxfmtrc.json` holds the style (oxfmt, from the oxc tools that lint the code): run `pnpm format <files>` on the
files you change. The repository isn't formatted as a whole yet, so don't run it on everything in a change of its own
kind.

## Pull requests

- Keep each pull request to one change, with a title that says what changes for people using CompanyFlags.
- Add your change to the "Unreleased" section of [CHANGELOG.md](CHANGELOG.md), in a sentence or two for people
  using CompanyFlags.
- Fill in the template: what changes, how you tested it.
- A maintainer reviews within a few days. We may ask for changes; that's normal, not a rejection.

## Releases

Maintainers release with a `vX.Y.Z` tag. CI ([ci.yml](.github/workflows/ci.yml)) runs on the tagged commit first;
only if it passes does the tag build and publish the Docker image (`ghcr.io/dvir-daniel/companyflags`, as `X.Y.Z`,
`X.Y` and `latest`, with provenance and an SBOM), the npm package `companyflags`
([npm.yml](.github/workflows/npm.yml) says what to set up once), and a GitHub release with that version's notes from
[CHANGELOG.md](CHANGELOG.md).

Before the tag: bump the version in both `package.json` and `packages/companyflags/package.json`, rename
"Unreleased" in CHANGELOG.md to the version, and set the default of `COMPANYFLAGS_VERSION` in `docker-compose.yml`
and `examples/flagd/docker-compose.yml` to the new `X.Y`.

The workflows pin every action to a commit SHA, with its version in a comment; Dependabot proposes the updates.
