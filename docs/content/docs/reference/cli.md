---
title: "CLI"
description: "Run, set up and migrate the server, and keep your flags in a file, with the companyflags command."
---

`companyflags` runs the server, sets it up, migrates its database and keeps your flags in a file. Like Better
Auth's CLI, it reads [`companyflags.config.ts`](/self-hosting/configuration#the-config-file) from the folder it
runs in (or `FF_CONFIG`), then the environment, and works on the database they name.

| Where | How to run it |
|---|---|
| A clone of the repository | `pnpm cli <command>`, or `node server/cli.ts <command>` |
| The Docker image | `docker compose exec companyflags companyflags <command>` |

An npm package is coming, but isn't published yet. Until it is, use a clone or the Docker image.

:::warning[Embedded Postgres: one process at a time]
Without `DATABASE_URL`, the data is in embedded Postgres, which only one process can open. Stop the server before
`migrate` or `flags`, or use a Postgres server.
:::

## Commands

### `start`

Runs the server: the console, its API and the [plugins](/reference/plugins). The same as `node server/index.ts`.
`companyflags start` serves the console too. Its first line says the version.

`--no-migrate` (or `FF_MIGRATE=off`): it doesn't apply migrations, only checks the schema has every one it needs,
and stops if not. A newer version's migrations are allowed, for a [rolling upgrade](/self-hosting/upgrading).

### `init`

Writes `companyflags.config.ts` in this folder, with the database, sign-in and every built-in plugin. It won't
write over one that's there unless you add `--force`. Run it where the file's imports resolve: the clone's root, or `/app` in
Docker. Run anywhere else, it writes the file and warns that the
server can't load it there.

### `secret`

Prints a random secret for `BETTER_AUTH_SECRET`.

### `migrate`

Applies the database migrations the database doesn't have yet. Every start does it too; run it yourself to migrate as
a step of a deploy, before the new version starts.

```bash
companyflags migrate --check     # lists what's pending; exits with 1 if anything is
companyflags migrate
```

### `backup`

```bash
companyflags backup [path]
```

With `DATABASE_URL`: runs `pg_dump` (it must be installed, the same major version as the server or newer) into one
file, `companyflags-backup-<date>-<time>.dump` unless you name one; `pg_restore --no-owner -d <database> <file>` puts
it back. The password goes to `pg_dump` in its environment, never on its command line.

With embedded Postgres: copies its folder to `companyflags-backup-<date>-<time>` (or the path you name). Stop the
server first: it refuses while a server has the folder open. To put it back, stop the server and copy the folder into
place. See [Backups](/self-hosting/backups).

### `copy-to-postgres`

```bash
companyflags copy-to-postgres postgres://user:pass@db.example.com:5432/flags
```

Copies everything in the embedded database (flags, history, people, keys, links, settings) into a new, empty Postgres
database, in one transaction: all of it, or nothing. Stop the server first. The embedded folder isn't changed. Then
set `DATABASE_URL` to the new database and start the server. See
[Database → Moving to Postgres](/self-hosting/database#moving-to-postgres).

### `version`

Prints the version (also `--version`).

### `flags pull`, `flags plan`, `flags push`

Your flags as code: see [Flags as code](/guide/flags-as-code).

```bash
companyflags flags pull flags.json        # writes the flags to the file
companyflags flags plan flags.json        # what a push would change
companyflags flags push flags.json --as ci@acme.test --reason "Web gets the new checkout"
```

The file defaults to `flags.json`. A pull into a file that exists keeps its `source`, `owns` and `scope`, and writes
only the flags in its scope and the fields it owns.

| Option | Means |
|---|---|
| `--as <name>` | On the database: the name History shows for the push (default: your user name). |
| `--reason <text>` | Push: why, on each request the push makes and in History. |
| `--link <url>` | Push: the pull request or commit, on the requests and in History. In GitHub Actions and GitLab CI it defaults to the job's pull request (or commit). |
| `--json` | Print the plan (and for a push, what was done) as JSON instead of lines. |
| `--exit-code` | Plan: exit with `2` when there are changes. Push: exit with `2` when a change waits for approval. |

| Exit code | Means |
|---|---|
| `0` | Done, or nothing to change. |
| `1` | The file has problems (nothing was pushed), a step was refused (what was done before it is listed), or the command was wrong. |
| `2` | With `--exit-code`: plan found changes, or a push left a change waiting for approval. |

The plan's lines:

| Line | Means |
|---|---|
| `+ create …` | A new flag. |
| `~ …` | A change. "(a request: …)" where it needs approval; "(undoes a change made outside this file …)" where the console changed it since the file's last push. |
| `… services of … (waiting in request #12)` | A change that an open request already makes. A push reuses it. |
| `… request #12 on … is waiting in prod` | Another open request on one of the file's flags. |
| `= 3 unchanged` | Flags that match. |
| `? only in CompanyFlags …` | Flags in the file's scope that the file doesn't have. They are left as they are. |
| `! …` | A problem: nothing is pushed. |

In CI (`CI` set), the `flags` commands need `--url` and `--token` or a `DATABASE_URL`: they never open an embedded
database there, unless `FF_DATA_DIR` says to. An empty `--url` or `--token` (or its variable) is an error.

### `flags export --flagd`

Writes one service's flags in one environment as flagd JSON, for one entity or none, from the database. It is the
document a backend downloads from `/sdk/v1/flagd`: for tests, and for flagd where it can't reach the server.

```bash
companyflags flags export --flagd --env prod --service api --entity acme flagd.json
```

`--env` and `--service` are needed. `--entity` takes the entity's key, or `<dimension>/<key>`; without it, the file
is what the service gets with no entity. The file defaults to `flagd.json`. It works on the database only, not with
`--url`.

### Over HTTP: `--url` and `--token`

With `--url`, the `flags` commands go through a server's API instead of opening its database. CI then needs no
`DATABASE_URL`, and the push has exactly the rights of its access token:

```bash
companyflags flags plan --url https://flags.example.com --token cfp_…
COMPANYFLAGS_URL=https://flags.example.com COMPANYFLAGS_TOKEN=cfp_… companyflags flags push
```

| Option | Environment variable | Means |
|---|---|---|
| `--url <server>` | `COMPANYFLAGS_URL` | The server, e.g. `https://flags.example.com`. |
| `--token <cfp_…>` | `COMPANYFLAGS_TOKEN` | An access token (`cfp_…`), made in the signed-in console. Needed with a URL. |

The lines are the same as on the database. History shows the token's person, or the agent for an agent's token, so
`--as` isn't taken. Pull and plan work with any token; push needs an Editor's. In CI, plan with a Viewer's token and
push with an Editor's ([Flags as code](/guide/flags-as-code#in-ci)). Where an environment needs approval, a
change of services or of the default is a request, as in the console. When the server refuses (an unknown token, a role that can't
push), the command prints one line and exits with `1`:

```text
companyflags: https://flags.example.com answered 403: viewers can look but not change anything: ask an admin for a role
```

### `flags unused`

Lists the flags no code mentions, and the keys the code reads with OpenFeature that aren't flags:

```bash
companyflags flags unused --src . flags.json
```

```text
? unused: old_banner, summer_sale
! unknown: new_chekout (src/checkout.ts:12)
```

It reads the flags file (or, with `--url`, the server's flags), then searches `--src` (default: this folder) for each
key as a whole word. It skips `node_modules`, `.git`, `dist`, `build`, `out`, `.next`, `.turbo`, `coverage`,
`vendor`, `target`, `.venv`, `venv` and `__pycache__`, the flags file, flagd JSON files, binary files and files over
1 MB. With `--url` and a flags file that has a `scope`, it checks only the server's flags in that scope.

A key is "read" when it is the flag key of an OpenFeature call:

| SDK | Calls |
|---|---|
| JavaScript, TypeScript, Java, Kotlin, PHP | `getBooleanValue`, `getStringValue`, `getNumberValue`, `getIntegerValue`, `getDoubleValue`, `getObjectValue`, and their `…Details` |
| React | `useBooleanFlagValue`, `useStringFlagValue`, `useNumberFlagValue`, `useObjectFlagValue`, their `…Details`, `useFlag`, `useSuspenseFlag` |
| Go | `BooleanValue`, `StringValue`, `IntValue`, `FloatValue`, `ObjectValue` and their `…ValueDetails` (the key after the context) |
| Python, Rust | `get_boolean_value`, `get_string_value`, `get_integer_value`, `get_float_value`, `get_object_value`, their `…_details`; Rust's `get_bool_value`, `get_int_value`, `get_struct_value` |
| Ruby | `fetch_boolean_value`, `fetch_string_value`, `fetch_number_value`, `fetch_integer_value`, `fetch_float_value`, `fetch_object_value` |
| .NET | `GetBooleanValueAsync`, `GetStringValueAsync`, `GetIntegerValueAsync`, `GetDoubleValueAsync`, `GetObjectValueAsync`, and their `…DetailsAsync` |

The key must be typed in, in quotes: a key in a variable isn't seen. It exits with `0`; with `--strict`, with `1`
when there's anything to report.

`migrate` and the `flags` commands also exit with `1` when the config file can't be loaded, or when the embedded
database is open in another process. The `flags` commands do when the database is missing migrations or has ones
this version doesn't know, and `migrate --check` does when migrations are pending.

### `mcp`

MCP over stdio, for AI clients that only start local servers. Each JSON-RPC line on stdin goes to the server's
`/mcp` with the token, and each answer is a line on stdout. Nothing else goes to stdout: errors go to stderr.

```bash
pnpm cli mcp --url https://flags.example.com --token cfp_…
```

`COMPANYFLAGS_URL` and `COMPANYFLAGS_TOKEN` work in place of `--url` and `--token`. The token is an access token made
in the console. It ends when stdin ends.

### `help`

Lists the commands.

## Unknown options

Every command refuses an option or argument it doesn't know, and exits with `1` before it does anything:

```text
$ companyflags migrate --chek
companyflags: migrate: unknown option "--chek" (see companyflags help)
```
