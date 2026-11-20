# Quickstart

Run CompanyFlags, set up your first flag, then read it the way an app does.

## 1. Start it

::: code-group

```bash [Docker]
docker run -d --name companyflags -p 8787:8787 -v companyflags:/data \
  -e BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
  -e BETTER_AUTH_URL=http://localhost:8787 \
  ghcr.io/dvir-daniel/companyflags
```

```bash [Docker Compose]
curl -O https://raw.githubusercontent.com/dvir-daniel/companyflags/main/docker-compose.yml
echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)" > .env
docker compose up -d
```

```bash [From source]
git clone https://github.com/dvir-daniel/companyflags.git
cd companyflags
corepack enable          # gives you pnpm 11
pnpm install
pnpm serve               # builds the console and serves it on http://localhost:8787
```

:::

Docker keeps the data in the `companyflags` volume; Compose runs Postgres beside it. See [Docker](/self-hosting/docker).

## 2. Set it up

A new server has no accounts. It prints a **setup link** in its log when it starts: see `docker logs companyflags`,
`docker compose logs companyflags`, or the terminal running `pnpm serve`.

```text
[companyflags] nobody has an account yet: make the admin account at http://localhost:8787/api/setup/<secret>
```

Open that link and **create the admin account**. Only the link can make it, so whoever reaches your server first
can't make themselves its admin. It stops working once the account exists.

The console then walks you through four steps, as a checklist:

1. **Environments.** Add Development with the key `dev`, and Production with 1 approval needed.
2. **Services.** Add `web`, of the kind **App**: what your web app reads. Add a **Backend** service, such as `api`,
   when a server needs flags too.
3. **Your first flag.** **Flags → + New flag**: key `new_checkout`, type **On / off**, purpose **Config**,
   **Default** `on`, and tick the service `web`.
4. **Connect an app.** **API keys → + New key** (admins): the environment Development and the service `web`. Copy the
   key: it is shown once.

![The flags list](/screenshots/console-flags.png)

Open the flag to give it rules: 10% of devices, or everyone on app version 6 or later. The flag's **Debug** tab
(**Test a device**) answers for any service and device, and explains each step.

[Dimensions](/guide/dimensions) are optional. Add them when config differs per company, store or region: then `acme`
can have settings of its own on any flag.

## 3. Read the flag

Ask with the key you copied (`ff_dev_web_…`), as the app would, with what the device knows about itself:

```bash
curl -X POST http://localhost:8787/ofrep/v1/evaluate/flags \
  -H "Authorization: Bearer ff_dev_web_…" -H "Content-Type: application/json" \
  -d '{"context": {"targetingKey": "device-1", "app": {"version": "6.0.0"}}}'
```

```json
{
  "flags": [{ "key": "new_checkout", "reason": "STATIC", "variant": "on", "value": true }],
  "metadata": { "environment": "dev" },
  "eventStreams": [{ "type": "sse", "endpoint": { "requestUri": "/ofrep/v1/events/dev/…" }, "inactivityDelaySec": 120 }]
}
```

In a web app that is OpenFeature's own OFREP provider (see [OpenFeature](/sdk/openfeature)):

```ts
import { OpenFeature } from '@openfeature/web-sdk';
import { OFREPWebProvider } from '@openfeature/ofrep-web-provider';

await OpenFeature.setContext({ targetingKey: 'device-1', app: { version: '6.0.0' } });
await OpenFeature.setProviderAndWait(new OFREPWebProvider({
  baseUrl: 'http://localhost:8787',
  headers: [['Authorization', 'Bearer ff_dev_web_…']],   // the web service's key
}));
OpenFeature.getClient().getBooleanValue('new_checkout', false);
```

Change the flag in the console and the provider hears about it at once, through the answer's change events.

An app service's key is public: it goes in the app, and reads that service's values only. A backend service's key
is secret and stays on your servers. To pin an app to one entity, such as the company `acme`, your backend can hand it
a signed [app link](/guide/services#signed-app-links) at sign-in. That is optional.

## Next

- [How it fits together](/guide/concepts): environments, services, dimensions, flags and rules.
- [Services](/guide/services): apps and backends, their keys, and signed app links.
- [Moving from another system](/guide/migration): already have flags somewhere else? Bring them over one at a time,
  with both running meanwhile.
- [Docker](/self-hosting/docker) and the [production checklist](/self-hosting/production) when you're ready to run it
  for real.
