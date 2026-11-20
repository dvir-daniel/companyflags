# Architecture

CompanyFlags is built the way Better Auth is: a small core, plugins for everything around it, one typed config
file, and a CLI that reads it. Unlike Better Auth, it runs as a server of its own rather than inside your app. Flags
are read by many apps and backends at once, so they need one place that decides, publishes and keeps history.

<IllusArchitecture />

## The core

| Part | What it does | Where |
|---|---|---|
| Console and its API | Flags, rules, entities, approvals, history, settings | `web/`, `server/api.ts` |
| Sign-in | Better Auth: email and password, providers, single sign-on, roles | `server/betterAuth.ts`, `server/access.ts` |
| Evaluator | Decides every answer, the same way for every plugin and the console's trace | `server/evaluator.ts` |
| Change journal | Every change is recorded in History, and published once it commits | `server/journal.ts` |
| Publishing | Builds each environment's snapshot after a change; several servers catch up from the database | `server/snapshot.ts`, `server/workers.ts` |
| Keys | Each service's keys: an app's is public and reads values only, a backend's is secret | `server/auth.ts` |
| App links | Each entity's signed link and OFREP token, for your backend to hand to its apps (optional) | `server/delivery.ts` |

## Plugins

Everything that reads flags besides the console is a plugin, and so is anything that runs after a publish. The five
built-in ones (`ofrep()`, `flagd()`, `appFiles()`, `cloudflare()`, `webhooks()`) run unless the config lists
others: see [Plugins](/reference/plugins), and how to write your own. Each one is answered by the same evaluator, so
an app reading OFREP, a backend reading flagd JSON and a device reading its app file all get the same answer for the
same entity and context.

## One config file

[`companyflags.config.ts`](/self-hosting/configuration#the-config-file) says which database, which sign-in and
which plugins. It's TypeScript, typed by `defineConfig`, and optional: without it, environment variables decide, as
in the Docker image. `server/config.ts` is its type (what `companyflags/config` gives the file), and
`server/configFile.ts` reads it for the server and the CLI.

## The CLI

[`companyflags`](/reference/cli) starts the server, writes the config file, migrates the database and keeps your
[flags as code](/guide/flags-as-code). It reads the same config file as the server and goes through the same
functions as the console, so its changes are checked, recorded and reviewed the same way.

## What we left out

- **No SDK of our own.** Apps and backends read flags with OpenFeature's own providers (OFREP, flagd). A new way to
  read flags is a plugin that speaks one of their protocols.
- **No database adapters.** Better Auth supports many databases because it lives in your app's. CompanyFlags
  brings its own: Postgres, or embedded Postgres for a single server.
- **Not a library inside your app.** One server decides for every app and backend, and keeps the history in one
  place.
