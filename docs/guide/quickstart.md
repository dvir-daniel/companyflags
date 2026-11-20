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

The console then walks you through five steps, as a checklist:

1. **Environments.** Add Development with the key `dev`, and Production with 1 approval needed.
2. **Flag sets.** Add `web`, a flag set for apps. Add one for a backend later, a flag set for backends.
3. **Dimensions and a first entity.** Say what config is served per: pick a preset such as `company`, or name your
   own levels. Then add an entity on its dimension's page, for example the company `acme`.
4. **Your first flag.** **Flags → + New flag**: key `new_checkout`, type **On / off**, purpose **Config**,
   **Default** `on`, in the flag set `web`.
5. **Connect an app.** An app reads its flags with a token from its entity's **App link**, as the next section shows.

![The flags list](/screenshots/console-flags.png)

Open the flag to give it rules: 10% of devices, everyone on app version 6 or later, or settings of its own for
`acme`. The flag's **Debug** tab (**Test a device**) answers for any entity, flag set and device, and explains each
step.

## 3. Read the flag

Every entity has an app link per environment, and from it an **OpenFeature token** for each flag set: open the
entity's page, then **App link**, and take Development's token for `web`. Ask with it as an app would, with what the
device knows about itself:

```bash
curl -X POST http://localhost:8787/ofrep/v1/evaluate/flags \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
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
  headers: [['Authorization', 'Bearer <token>']],
}));
OpenFeature.getClient().getBooleanValue('new_checkout', false);
```

Change the flag in the console and the provider hears about it at once, through the answer's change events.

## Next

- [How it fits together](/guide/concepts): environments, flag sets, dimensions, flags and rules.
- [Flag sets](/guide/flag-sets): how your backend hands each app its token at sign-in.
- [Moving from another system](/guide/migration): already have flags somewhere else? Bring them over one at a time,
  with both running meanwhile.
- [Docker](/self-hosting/docker) and the [production checklist](/self-hosting/production) when you're ready to run it
  for real.
