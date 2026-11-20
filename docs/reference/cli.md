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

`migrate` and the `flags` commands also exit with `1` when the config file can't be loaded, or when the embedded
database is open in another process. The `flags` commands do when the database is missing migrations or has ones
this version doesn't know, and `migrate --check` does when migrations are pending.

### `help`

Lists the commands.

## Unknown options

Every command refuses an option or argument it doesn't know, and exits with `1` before it does anything:

```text
$ companyflags migrate --chek
companyflags: migrate: unknown option "--chek" (see companyflags help)
```
