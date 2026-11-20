---
title: "Flags as code"
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
  "flags": {
    "new_checkout": {
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

| Field | What it is |
|---|---|
| `kind` | `release`, `kill_switch`, `ops`, `experiment`, `config` or `permission`. Releases and experiments need `removeBy`. |
| `type` | `bool`, `string`, `number` or `json`. It can't change once the flag exists. |
| `name`, `description`, `owner`, `tags`, `removeBy` | The flag's details, as in its Settings tab. |
| `variants` | Variant → value. An on/off flag has `on: true` and `off: false` when you leave it out. |
| `default` | For a new flag: the variant everyone gets until you add rules. An on/off flag starts on `off`. |
| `services` | Per environment, the [services](/guide/services) the flag is in. Before 0.3 it was `flagSets`, which a push no longer reads: rename it. |
| `freeValues` | `true` for a flag whose values are typed into its rules. Such a flag is made in the console. |
| `jsonSchema` | A JSON flag's [JSON Schema](/guide/flags-and-rules#a-json-schema): every variant must match it. `null` removes it. |

## What a push does

The file says which flags exist and what they are. A push:

- **makes** the flags the file has and CompanyFlags doesn't, with their variants, services and default;
- **changes** the details, adds variants and changes their values, and changes services;
- **lists** the flags only CompanyFlags has, and leaves them as they are. Archive a flag in the console.

It goes through the same checks as the console. Where changes need approval, changing a flag's services makes a
request, as the console does, and the push prints its number. A new flag starts switched off there. A value that is
served where changes need approval can't change: add a new variant and point the rules at it.

Rules stay in the console: they are where most changes happen, and each one is reviewed where it must be.

A file with a problem pushes nothing: `plan` and `push` list every problem and exit with 1. A step CompanyFlags
refuses stops the push. What was done before it is listed, and the next push goes on from there.

## In CI

Plan on every pull request, push when it merges. The CLI works on the database directly, so CI runs the image with
`DATABASE_URL` and your file:

```yaml
# .github/workflows/flags.yml, in the repository with flags.json
- name: Plan
  run: |
    docker run --rm -e DATABASE_URL="$DATABASE_URL" -v "$PWD/flags.json:/app/flags.json:ro" \
      ghcr.io/dvir-daniel/companyflags companyflags flags plan
  env: { DATABASE_URL: "${{ secrets.FLAGS_DATABASE_URL }}" }
- name: Push
  if: github.ref == 'refs/heads/main'
  run: |
    docker run --rm -e DATABASE_URL="$DATABASE_URL" -v "$PWD/flags.json:/app/flags.json:ro" \
      ghcr.io/dvir-daniel/companyflags companyflags flags push --as "$GITHUB_ACTOR"
  env: { DATABASE_URL: "${{ secrets.FLAGS_DATABASE_URL }}" }
```

`FLAGS_DATABASE_URL` is the database itself, not an API key: anyone who can change the workflow can read every secret
in it. Keep it in a protected GitHub environment and, if you can, use a role that isn't the database owner.

Use the image of the version your server runs: the CLI refuses a database that is missing migrations, and an older
CLI refuses a database a newer server migrated. The running server publishes what a push changes within a second.
