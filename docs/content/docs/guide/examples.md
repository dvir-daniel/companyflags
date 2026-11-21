---
title: "Examples"
description: "Small apps that read CompanyFlags with OpenFeature: a React page, a Node server and flagd, with a script that sets up a server for them."
---

Small, working apps in the repo's [`examples/`](https://github.com/dvir-daniel/companyflags/tree/main/examples)
folder. Each reads CompanyFlags with OpenFeature's own SDKs and providers.

| Example | What it shows |
|---|---|
| [React](https://github.com/dvir-daniel/companyflags/tree/main/examples/react) | A Vite + React page: OpenFeature's React SDK and the OFREP web provider, with the `web` service's key. A new checkout banner from `new_checkout`, a heading from `welcome_message` |
| [Node](https://github.com/dvir-daniel/companyflags/tree/main/examples/node) | A Node HTTP server: OpenFeature's server SDK and the OFREP provider, with the `api` service's key. `GET /upload-limit?company=acme` answers `max_upload_mb` for that company |
| [flagd](https://github.com/dvir-daniel/companyflags/tree/main/examples/flagd) | Docker Compose: CompanyFlags, and flagd syncing Acme's flagd JSON from `/sdk/v1/flagd/company/acme` |

## Set up a server for them

A token never changes settings, so you make those in the console, and a seed script makes the rest through the
console's API, with an Editor's token.

1. Start CompanyFlags and make the admin account with its setup link (see the [Quickstart](/guide/quickstart)).
2. In the console, as the admin: **Settings → Environments**, add Development, key `dev`. **Settings → Dimensions**,
   add `company`. **Services**, add `web` (kind **App**) and `api` (kind **Backend**).
3. Make an access token: your name at the foot of the sidebar → **Account** → **+ New token**, with the role
   **Editor**.
4. From the repo:

   ```bash
   FLAGS_URL=http://localhost:8787 FLAGS_TOKEN=cfp_… node examples/seed.ts
   ```

   It checks step 2 is done, then adds the companies `acme` (Acme Corp) and `globex` (Globex), and the flags.
5. Make the API keys in the console: **API Keys → + New key**, one for `dev` and `web`, one for `dev` and `api`. The
   seed's last lines say which file each goes in.

Then follow the example's README.
