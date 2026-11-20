# Quickstart

Run CompanyFeatures, set up your first flag, then read it the way an app does.

## 1. Start it

::: code-group

```bash [Docker]
docker run -d -p 8787:8787 -v companyfeatures:/data \
  -e BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
  -e BETTER_AUTH_URL=http://localhost:8787 \
  ghcr.io/dvir-daniel/companyfeatures
```

```bash [Docker Compose]
curl -O https://raw.githubusercontent.com/dvir-daniel/companyfeatures/main/docker-compose.yml
echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)" > .env
docker compose up -d
```

```bash [From source]
git clone https://github.com/dvir-daniel/companyfeatures.git
cd companyfeatures
corepack enable          # gives you pnpm 11
pnpm install
pnpm serve               # builds the console and serves it on http://localhost:8787
```

:::

Docker keeps the data in the `companyfeatures` volume; Compose runs Postgres beside it. See [Docker](/self-hosting/docker).

## 2. Set it up

Open <http://localhost:8787> and **create the admin account**: the first person to sign up becomes the admin. The
console then walks you through four steps in **Settings**:

1. **Environments.** Add Development, and Production with 1 approval needed.
2. **Flag sets.** Add `web`, a flag set for apps. Add one for a backend later, a flag set for backends.
3. **Dimensions.** Say what config is served per: pick a preset such as `company`, or name your own levels.
4. **Your first flag.** Add an entity on its dimension's page (for example the company `acme`), then **Flags → + New
   flag**: `new_checkout`, on or off, in the flag set `web`.

![The flags list](/screenshots/console-flags.png)

Open the flag to give it rules: 10% of devices, everyone on app version 6 or later, or settings of its own for
`acme`. The **Try it** panel answers for any entity, flag set and device, and explains each step.

## 3. Read the flag

Every entity has an app link per environment, and from it an **OpenFeature token** for each flag set: open the
entity's page, then **App link**. Ask with it as an app would, with what the device knows about itself:

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
- [Docker](/self-hosting/docker) and the [production checklist](/self-hosting/production) when you're ready to run it
  for real.
