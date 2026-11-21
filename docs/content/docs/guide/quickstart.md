---
title: "Quickstart"
description: "Run CompanyFlags, set up your first flag, then read it the way an app does."
---

## 1. Start it

```bash tab="Docker"
echo "FF_SECRET=$(openssl rand -base64 32)" > .env
docker run -d --name companyflags -p 8787:8787 -v companyflags:/data --env-file .env \
  -e FF_PUBLIC_URL=http://localhost:8787 ghcr.io/dvir-daniel/companyflags:0.9
```

```bash tab="Docker Compose"
curl -O https://raw.githubusercontent.com/dvir-daniel/companyflags/main/docker-compose.yml
echo "FF_SECRET=$(openssl rand -base64 32)" > .env
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" >> .env
docker compose up -d
```

```bash tab="From source"
git clone https://github.com/dvir-daniel/companyflags.git
cd companyflags
corepack enable          # gives you pnpm 11
pnpm install
pnpm serve               # builds the console and serves it on http://localhost:8787
```

The secret signs sign-in sessions and makes the setup link, so keep `.env`: start the server again with the same
file, or everyone is signed out. Docker keeps the data in the `companyflags` volume. Compose runs Postgres beside it,
and answers on `127.0.0.1:8787` only. See [Docker Compose](/deploy/docker-compose).

## 2. Set it up

A new server has no accounts. It prints a **setup link** in its log when it starts: see `docker logs companyflags`,
`docker compose logs companyflags`, or the terminal running `pnpm serve`.

```text
[companyflags] nobody has an account yet: make the admin account at http://localhost:8787/api/setup/<secret>
```

Open that link and **create the admin account**. Only the link can make it, so whoever reaches your server first
can't make themselves its admin. It stops working once the account exists.

The console then walks you through four steps, as a checklist. It stays above the flags list until each step is
done, and none of them needs a dimension:

1. **Environments.** Add Development with the key `dev`, and Production with the key `prod`. Leave **Approvals
   needed** at 0 for both while you are the only person: nobody approves their own request, so with 1 approval and
   nobody else to review, nothing could go out in Production (the drawer warns you). Once you invite a second person
   who reviews (Approver, On call or Admin), raise Production to 1 ([Approvals and history](/guide/approvals)).
2. **Services.** Add `web`, of the kind **App**: what your web app reads. Add a **Backend** service, such as `api`,
   when a server needs flags too.
3. **Your first flag.** **Flags → + New flag**: key `new_checkout`, and tick the service `web`. It is **On / off**
   already; set **Default** to `on`. The dialog says where the flag starts on: in Development at once, and off in
   Production until it is turned on there.
4. **Connect an app.** **API keys → + New key** (admins): the environment Development and the service `web`. Copy the
   key: it is shown once. Beside it is a curl and the OpenFeature code to read flags with it, filled in. The step is
   done once an app reads flags with a key.

![The flags list](/screenshots/console-flags.png)

Open the flag to give it rules: 10% of devices, or everyone on app version 6 or later. The flag's **Debug** tab
(**Test a device**) answers for any service and device, and explains each step.

[Dimensions](/guide/dimensions) are optional, and nothing above needs them. Add them when config differs per
company, store or region: then `acme` can have settings of its own on any flag.

## 3. Read the flag

Ask with the key you copied (`ff_dev_web_…`), as the app would, with what the device knows about itself. This is
the curl the key drawer shows:

```bash
curl -X POST http://localhost:8787/ofrep/v1/evaluate/flags \
  -H "Authorization: Bearer ff_dev_web_…" -H "Content-Type: application/json" \
  -d '{"context": {"targetingKey": "device-1", "app": {"version": "6.0.0"}}}'
```

```json
{
  "flags": [{ "key": "new_checkout", "reason": "STATIC", "variant": "on", "value": true, "metadata": { "revision": 3 } }],
  "metadata": { "environment": "dev" },
  "eventStreams": [{ "type": "sse", "endpoint": { "requestUri": "/ofrep/v1/events/dev/…" }, "inactivityDelaySec": 120 }]
}
```

In a web app that is OpenFeature's own OFREP provider (see [Reading flags](/reading/overview)):

```ts
import { OpenFeature } from '@openfeature/web-sdk';
import { OFREPWebProvider } from '@openfeature/ofrep-web-provider';

await OpenFeature.setContext({ targetingKey: 'device-1', app: { version: '6.0.0' } });
await OpenFeature.setProviderAndWait(new OFREPWebProvider({
  baseUrl: 'http://localhost:8787',
  headers: [['Authorization', 'Bearer ff_dev_web_…']],   // the web service's key
  pollInterval: 60_000,                                  // when it can't keep a change stream open: once a minute
}));
OpenFeature.getClient().getBooleanValue('new_checkout', false);
```

Change the flag in the console and the provider hears about it at once, through the answer's change events.

An app service's key is public: it goes in the app, and reads that service's values only. A backend service's key
is secret and stays on your servers. To pin an app to one entity, such as the company `acme`, your backend can hand it
a signed [app link](/guide/services#signed-app-links) at sign-in. That is optional.

## Next

- [Reading flags](/reading/overview): the four ways apps and backends read flags, and which to pick.
- [Examples](/guide/examples): a React page, a Node server and flagd, in the repo's
  [`examples/`](https://github.com/dvir-daniel/companyflags/tree/main/examples) folder, with a script that sets up a
  server for them.
- [How it fits together](/guide/concepts): environments, services, dimensions, flags and rules.
- [Services](/guide/services): apps and backends, their keys, and signed app links.
- [Moving from another system](/guide/migration): already have flags somewhere else? Bring them over one at a time,
  with both running meanwhile.
- [Installation](/guide/installation) when you're ready to run it for real: four steps, then a
  complete [deploy recipe](/deploy/builder) for your platform.
