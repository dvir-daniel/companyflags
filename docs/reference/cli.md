# CLI

`companyflags` runs the server, sets it up, migrates its database and keeps your flags in a file. Like Better
Auth's CLI, it reads [`companyflags.config.ts`](/self-hosting/configuration#the-config-file) from the folder it
runs in (or `FF_CONFIG`), then the environment, and works on the database they name.

| Where | How to run it |
|---|---|
| A clone of the repository | `pnpm cli <command>`, or `node server/cli.ts <command>` |
| The Docker image | `docker compose exec companyflags companyflags <command>` |

::: warning Embedded Postgres: one process at a time
Without `DATABASE_URL`, the data is in embedded Postgres, which only one process can open. Stop the server before
`migrate` or `flags`, or use a Postgres server.
:::

## Commands

### `start`

Runs the server: the console, its API and the [plugins](/reference/plugins). The same as `node server/index.ts`.

### `init`

Writes `companyflags.config.ts` in this folder, with the database, sign-in and every built-in plugin. It won't
write over one that's there unless you add `--force`. Run it in the server's folder: the file's imports come from the
server it sits next to. Run anywhere else, it writes the file and warns that the server can't load it there.

### `secret`

Prints a random secret for `BETTER_AUTH_SECRET`.

### `migrate`

Applies the database migrations the database doesn't have yet. Every start does it too; run it yourself to migrate as
a step of a deploy, before the new version starts.

```bash
companyflags migrate --check     # lists what's pending; exits with 1 if anything is
companyflags migrate
```

### `flags pull`, `flags plan`, `flags push`

Your flags as code: see [Flags as code](/guide/flags-as-code).

```bash
companyflags flags pull flags.json        # writes every flag to the file
companyflags flags plan flags.json        # what a push would change
companyflags flags push flags.json --as ci@acme.test
```

The file defaults to `flags.json`. `--as` is the name History shows for the push (default: your user name); it needs
a value.

| Exit code | Means |
|---|---|
| `0` | Done, or nothing to change. |
| `1` | The file has problems (nothing was pushed), a step was refused (what was done before it is listed), or the command was wrong. |

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
`--as` isn't taken. Pull and plan work with any token; push needs an Editor's. Where an environment needs approval, a
change of services is a request, as in the console. When the server refuses (an unknown token, a role that can't
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
key as a whole word. It skips `node_modules`, `.git`, `dist`, `build`, the flags file, binary files and files over
1 MB. A key is "read" when it is the first argument of `getBooleanValue`, `getStringValue`, `getNumberValue` or
`getObjectValue` (or their `…ValueDetails`). It exits with `0`; with `--strict`, with `1` when there's anything to
report.

`migrate` and the `flags` commands also exit with `1` when the config file can't be loaded, or when the embedded
database is open in another process. The `flags` commands do when the database is missing migrations or has ones
this version doesn't know, and `migrate --check` does when migrations are pending.

### `mcp`

MCP over stdio, for AI clients that only start local servers. Each JSON-RPC line on stdin goes to the server's
`/mcp` with the token, and each answer is a line on stdout. Nothing else goes to stdout: errors go to stderr.

```bash
companyflags mcp --url https://flags.example.com --token cfp_…
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
