---
title: "Secrets"
description: "The secrets an installation has, where to keep them, what BETTER_AUTH_SECRET protects, and how to change one."
---

Every install has secrets: one the server needs to start, a database password, and the ones people make in the
console. This page lists them all, where to keep them, and what changing each one does.

## BETTER_AUTH_SECRET

The server's own secret. Make it once, with at least 32 random characters:

```bash
openssl rand -base64 32          # or: companyflags secret
```

With `NODE_ENV=production` (the Docker image sets it), the server refuses to start without it, or with one shorter
than 32 characters. Outside production, a server without it makes one on its first start and keeps it in the
database. Give every instance the same one.

It signs, seals or keys all of these:

- **sessions**: the session cookies are signed with it;
- **the setup link**: its secret is made from it, so every instance prints the same link;
- **sign-in providers' tokens**: Google's, GitHub's and Microsoft's tokens are stored encrypted with it;
- **two-factor sign-in**: each person's authenticator secret and recovery codes are stored encrypted with it;
- **the Cloudflare token** saved in **Settings → CDN**: sealed with a key from it;
- **webhooks out**: their headers' values and signing secrets are sealed with a key from it;
- **plugins' sealed values**: a plugin that seals what it stores uses a key from it;
- **cache tags**: an entity's and a link's tag on the CDN files are keyed hashes made with it.

Never rotate it on a schedule: see [Changing a secret](#changing-a-secret). Keep it with your backups: a backup
restored with another secret loses everything on that list.

## Where to keep it

| Where it runs | Where the secret goes |
|---|---|
| Docker Compose | `.env` beside `docker-compose.yml`, with `chmod 600 .env` ([Docker](/self-hosting/docker#docker-compose-with-postgres)) |
| `docker run` | A `.env` file, passed with `--env-file .env`, never inline with `-e` |
| AWS | Secrets Manager, read as ECS secrets ([AWS](/self-hosting/aws#secrets)) |
| Google Cloud | Secret Manager, pinned to a version ([Google Cloud](/self-hosting/google-cloud#secrets)) |
| Azure | Key Vault, by a versioned reference ([Azure](/self-hosting/azure#secrets)) |

Platforms read secrets when an instance starts. Pin `BETTER_AUTH_SECRET` to one version: with "latest", instances
started after a new version get it and older ones don't, and people are signed out depending on which instance
answers.

## What the database holds

Everything is in the database: flags, history, people, and the secrets the server needs.

| Secret | Stored |
|---|---|
| Passwords | As hashes |
| API keys | Their SHA-256 hash and a readable prefix |
| Access tokens | Their hash and a prefix (`cfp_` and 6 characters) |
| AI agents' OAuth tokens and codes | As hashes |
| A webhook in's address | A hash of its secret |
| Each environment's link secret | As is. Every app link of that environment can be made from it |
| Single sign-on client secrets | As is |
| Webhooks out's addresses | As is |
| Webhooks out's headers' values and signing secrets | Sealed with a key from `BETTER_AUTH_SECRET` |
| The Cloudflare token | Sealed with a key from `BETTER_AUTH_SECRET` |
| Sign-in providers' tokens | Encrypted with `BETTER_AUTH_SECRET` |
| Two-factor secrets and recovery codes | Encrypted with `BETTER_AUTH_SECRET` |

A backup without `BETTER_AUTH_SECRET` doesn't give the sealed values away. Anyone who can read the database or a
backup can still read every entity's file, from the link secrets. Protect backups like production credentials.

## Changing a secret

### BETTER_AUTH_SECRET

Change it only on purpose. A new secret:

- signs everyone out;
- changes the setup link;
- makes the sealed and encrypted values unreadable: the Cloudflare token, webhooks' headers and signing secrets,
  plugins' sealed values, providers' tokens, and two-factor secrets and recovery codes;
- changes the cache tags, so a purge misses the files the CDN already holds until their minute is up.

After the change, save these again:

1. **The Cloudflare token** in **Settings → CDN**. Until then `/readyz` lists a warning and nothing is purged.
2. **Each webhook out**: **New secret** in its drawer, and set its headers again. Until then it isn't sent.
3. **Two-factor sign-in**: everyone who uses it gets a reset link from an admin (**Settings → People → Reset
   password**), which turns it off, and sets it up again.

:::warning[It can lock out the admins]
An admin who signs in with a password and two-factor can't sign in after the change: their codes can't be read. If
every admin signs in that way, nobody is left to make the reset links. Before you change the secret, make sure one
admin signs in another way (single sign-on, Google, GitHub or Microsoft).
:::

If it leaked:

1. Make a new secret.
2. Stop every instance, then start them all with the new one. Instances with two secrets sign and seal differently.
3. Save the Cloudflare token, the webhooks and two-factor again, as above. Replace the Cloudflare token itself, and
   each webhook out's signing secret and headers, since the old secret could open them in a backup.
4. In **Settings → CDN**, **Purge now** for each environment.

### The database password

With Postgres in Docker Compose, Postgres sets the password once, when its volume is new. To change it later:

1. Change it in Postgres:

   ```bash
   docker compose exec postgres psql -U companyflags -c "ALTER USER companyflags PASSWORD '<new password>'"
   ```

2. Set `POSTGRES_PASSWORD` in `.env` to the same password.
3. Run `docker compose up -d`, which starts the server with it.

With a managed database, change it with no downtime: make a second user, put its address in a new version of the
secret, deploy, then drop the old user.

### Everything else

| Secret | How to change it |
|---|---|
| An API key | **API Keys**: make a new key, move the app or backend to it, then revoke the old one. A key is shown once |
| An access token | Your name at the foot of the sidebar → **Account**: make a new one, then **Revoke** the old one |
| An environment's link secret | **Settings → Environments → Edit → Replace every link in this environment**. Old links stop working |
| One entity's app link | The entity's page → **App link** → **Replace link** |
| A single sign-on client secret | **Settings → Single Sign-On → Edit**. On a connection that requires single sign-on, this turns the requirement off until a new **Test sign-in** ([Single Sign-On](/self-hosting/single-sign-on#test-sign-in-and-editing)) |
| `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_SECRET`, `MICROSOFT_CLIENT_SECRET` | In the provider, then in the environment, and restart |
| The Cloudflare token | **Settings → CDN**, or `CF_API_TOKEN` and a restart |
| A webhook out's signing secret | **New secret** in the webhook's drawer, on the **Webhooks** page. It is shown once |
| A webhook in's address | **New address** in the webhook's drawer. The old address stops at once |
| The metrics token | `FF_METRICS_TOKEN` (or `metrics({ token })`) and a restart; then your scraper's |

## Keep secrets out of logs

- **The setup link** is in the server's log at every start until the admin account exists. Make the account right
  after the first start, and limit who can read the logs until then.
- **CDN file addresses** carry each entity's link secret. Load balancer and CDN access logs record them: treat those
  logs as secret.
- **`--token`** on `companyflags mcp` and `companyflags flags` shows the token in the computer's process list. Use
  `COMPANYFLAGS_TOKEN` instead on a shared computer.
- **The migrate step's secret** holds the address of the role that changes the schema. Limit who may start the
  migrate job or task: starting it grants the use of its secrets.

## Next

Make the first account: [Sign-In](/self-hosting/sign-in).
