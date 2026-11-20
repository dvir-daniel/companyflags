---
title: "Flags as code"
description: "Keep the flags your code reads in a file, reviewed in pull requests, and keep the server in step with the CLI."
---

The flags your code reads can live in a file next to it, reviewed in pull requests with the code that uses them. The
[CLI](/reference/cli) keeps CompanyFlags in step with the file.

```bash
companyflags flags pull     # write what CompanyFlags has to flags.json
companyflags flags plan     # see what a push would change
companyflags flags push     # make CompanyFlags match flags.json
```

## The file

```json
{
  "$schema": "https://dvir-daniel.github.io/companyflags/flags.schema.json",
  "source": "acme/web",
  "owns": ["name", "description", "owner", "tags", "removeBy", "variants", "default", "services"],
  "scope": { "prefix": "checkout_" },
  "flags": {
    "checkout_new": {
      "name": "New checkout",
      "kind": "release",
      "type": "bool",
      "owner": "payments",
      "tags": ["checkout"],
      "removeBy": "2027-02-17",
      "services": { "dev": ["web", "ios", "android"], "prod": ["web"] }
    },
    "checkout_layout": {
      "kind": "experiment",
      "type": "string",
      "removeBy": "2027-03-01",
      "variants": { "one_page": "one-page", "steps": "steps" },
      "default": "steps",
      "services": { "dev": ["web"], "prod": ["web"] }
    }
  }
}
```

Each flag:

| Field | What it is |
|---|---|
| `kind` | `release`, `kill_switch`, `ops`, `experiment`, `config` or `permission`. Releases and experiments need `removeBy`. |
| `type` | `bool`, `string`, `number` or `json`. It can't change once the flag exists. |
| `name`, `description`, `owner`, `tags`, `removeBy` | The flag's details, as in its Settings tab. |
| `variants` | Variant → value. An on/off flag has `on: true` and `off: false` when you leave it out. |
| `default` | The variant everyone gets when no rule decides, in every environment. An on/off flag starts on `off`. |
| `services` | Per environment, the [services](/guide/services) the flag is in. |
| `freeValues` | `true` for a flag whose values are typed into its rules. Such a flag is made in the console. |
| `jsonSchema` | A JSON flag's [JSON Schema](/guide/flags-and-rules#a-json-schema): every variant must match it. `null` removes it. |

A field you leave out of a flag is left as it is.

The file itself:

| Field | What it is |
|---|---|
| `$schema` | The file's [JSON Schema](https://dvir-daniel.github.io/companyflags/flags.schema.json), so your editor completes and checks it. Each server also serves its own version at `/flags.schema.json`. `flags pull` writes it. |
| `owns` | The fields the file decides. See [Who owns what](#who-owns-what). |
| `scope` | The flags this file may touch, when several repositories share one server. See [Several repositories](#several-repositories). |
| `source` | A name for the file, like `acme/web`. The console shows it on the flags the file manages. |

## Who owns what

Rules stay in the console. They are where most changes happen, and each one is reviewed where it must be. The file
owns what each flag is.

`owns` lists the fields the file decides, for every flag in it. A flag's key, kind and type are always the file's.
Without `owns`, the file owns each flag's definition: `name`, `description`, `owner`, `tags`, `removeBy`, `variants`,
`freeValues`, `jsonSchema` and `default`. It owns `services` only when `owns` lists it. A field the file doesn't own
can't be in it: `plan` says so, and nothing is pushed.

The first `flags pull` lists every field in `owns`. Take out the ones you'd rather change in the console. Later pulls
keep the file's `owns`, `scope` and `source`, and write only those fields and flags.

Each push records what the file applied to each flag. On those flags, the console shows **Managed in repo** and
the fields the file owns. A change made there to one of them is undone by the next push. The plan says so on that step:

```text
~ change checkout_new: description (undoes a change made outside this file since its last push)
```

To keep a change made in the console, put it in the file too.

`default` applies to flags that exist already, not only new ones. Where changes need approval, changing it is a
request, as in the console. `flags pull` leaves out the default of a release (the console moves it as the release
goes on) and of a flag whose environments differ. Leave `default` out for a flag whose default you change in the
console.

## Several repositories

When several repositories share a server, give each file a `scope` and a `source`:

```text
{ "source": "acme/web", "scope": { "prefix": "checkout_" }, "flags": { … } }
{ "source": "acme/api", "scope": { "services": ["api"] }, "flags": { … } }
```

- `prefix`: the file's flags are the ones whose keys start with it.
- `services`: the file's flags are the ones in these services, and no others.

A push refuses a flag outside the file's scope, and a flag another file (another `source`) manages. `plan` lists
only the flags in the scope that the file doesn't have, and `flags unused --url` checks only those.

## What a push does

A push:

- **makes** the flags the file has and CompanyFlags doesn't, with their variants, services and default;
- **changes** the fields the file owns: details, variants and their values, services and the default;
- **lists** the flags in its scope that only CompanyFlags has, and leaves them as they are. Archive a flag in the console.

It goes through the same checks as the console. Where changes need approval, changing a flag's services or its
default makes a request, as the console does, and the push prints its number. A new flag starts switched off there.
A value that is served where changes need approval can't change: add a new variant and point the rules at it.

A request that is already open for the same change isn't filed again. `plan` shows it as waiting, and `push` prints
the open request's number:

```text
… services of checkout_new in prod: web → web, ios (waiting in request #12)
```

Give a push a reason with `--reason`, and a link to the pull request with `--link`. In GitHub Actions and GitLab CI,
the link is the pull request's (or the commit's) when you don't give one. Both are on each request the push makes,
and in History.

A file with a problem pushes nothing: `plan` and `push` list every problem and exit with `1`. A step CompanyFlags
refuses stops the push. What was done before it is listed, and the next push goes on from there.

## In CI

Plan on every pull request, push when it merges. CI goes through your server's API with
[access tokens](/reference/cli#over-http---url-and---token), never with the database:

- **Plan** with a Viewer's token. Viewers can plan and pull, not push.
- **Push** with an Editor's token, kept in a protected GitHub environment that only `main` can use. History shows
  the token's person.

```yaml
# .github/workflows/flags.yml, in the repository with flags.json
name: Flags
on:
  pull_request:
    paths: [flags.json]
  push:
    branches: [main]
    paths: [flags.json]
permissions:
  contents: read
jobs:
  plan:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Plan
        run: |
          docker run --rm -e CI -e COMPANYFLAGS_URL -e COMPANYFLAGS_TOKEN -v "$PWD/flags.json:/app/flags.json:ro" \
            ghcr.io/dvir-daniel/companyflags:0.9.0 companyflags flags plan
        env:
          COMPANYFLAGS_URL: ${{ vars.COMPANYFLAGS_URL }}
          COMPANYFLAGS_TOKEN: ${{ secrets.COMPANYFLAGS_VIEWER_TOKEN }}
  push:
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    environment: flags            # a protected environment: only main, its secret only here
    steps:
      - uses: actions/checkout@v4
      - name: Push
        run: |
          docker run --rm -e CI -e COMPANYFLAGS_URL -e COMPANYFLAGS_TOKEN \
            -e GITHUB_SERVER_URL -e GITHUB_REPOSITORY -e GITHUB_REF -e GITHUB_SHA \
            -v "$PWD/flags.json:/app/flags.json:ro" \
            ghcr.io/dvir-daniel/companyflags:0.9.0 companyflags flags push --reason "Merged to main"
        env:
          COMPANYFLAGS_URL: ${{ vars.COMPANYFLAGS_URL }}
          COMPANYFLAGS_TOKEN: ${{ secrets.COMPANYFLAGS_EDITOR_TOKEN }}
```

Use the image tag of the version your server runs (`0.9.0` here), and change it when you upgrade the server.

A missing secret fails the job. An empty `COMPANYFLAGS_URL` or `COMPANYFLAGS_TOKEN` (a pull request from a fork,
a misspelled name) is an error, and in CI (`CI` set) the `flags` commands never open an embedded database.

`plan --exit-code` exits with `2` when there are changes, and `push --exit-code` when a change waits for approval.
`--json` prints the plan (and, for a push, what was done) as JSON, for a bot that comments on the pull request.

### Without a server to reach

Where CI can't reach the server's API, the CLI can work on the database itself, with `DATABASE_URL`. Then the
database is the secret, not an API key: anyone who can change the workflow can read every secret in it, and no role
check runs. Keep it in a protected environment, and use a database role that isn't the owner. Use the image of the
version your server runs: the CLI refuses a database that is missing migrations, and an older CLI refuses a
database a newer server migrated. The running server publishes what a push changes within a second.

## flagd JSON for tests

`flags export --flagd` writes one service's flags in one environment as flagd JSON, for one entity or none. It is the
document a backend downloads, made from the database with no server running: for tests, and for flagd where it
can't reach the server.

```bash
companyflags flags export --flagd --env prod --service api --entity acme flagd.json
```
