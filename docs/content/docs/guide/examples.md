---
title: "Examples"
---

Small, working apps in the repo's [`examples/`](https://github.com/dvir-daniel/companyflags/tree/main/examples)
folder. Each reads CompanyFlags with OpenFeature's own SDKs and providers.

| Example | What it shows |
|---|---|
| [React](https://github.com/dvir-daniel/companyflags/tree/main/examples/react) | A Vite + React page: OpenFeature's React SDK and the OFREP web provider, with the `web` service's key. A new checkout banner from `new_checkout`, a heading from `welcome_message` |
| [Node](https://github.com/dvir-daniel/companyflags/tree/main/examples/node) | A Node HTTP server: OpenFeature's server SDK and the OFREP provider, with the `api` service's key. `GET /upload-limit?company=acme` answers `max_upload_mb` for that company |
| [flagd](https://github.com/dvir-daniel/companyflags/tree/main/examples/flagd) | Docker Compose: CompanyFlags, and flagd syncing Acme's flagd JSON from `/sdk/v1/flagd/company/acme` |

## Set up a server for them

A seed script makes what the examples read, through the console's API: the environment `dev`, the dimension
`company` with `acme` and `globex`, the services `web` and `api`, the flags, and a key for each service.

1. Start CompanyFlags and make the admin account with its setup link (see the [Quickstart](/guide/quickstart)).
2. Make an access token: your name at the foot of the sidebar → **Access tokens** → **+ New token**, with the role
   **Admin**.
3. From the repo:

   ```bash
   FLAGS_URL=http://localhost:8787 FLAGS_TOKEN=cfp_… node examples/seed.ts
   ```

It prints the keys and the file each one goes in. Then follow the example's README.
