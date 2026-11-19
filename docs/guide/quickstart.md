# Quickstart

Run CompanyFeatures with sample data, look around the console, then read a flag from an app.

## 1. Start it

::: code-group

```bash [Docker]
docker run --rm -p 8787:8787 \
  -e BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
  -e BETTER_AUTH_URL=http://localhost:8787 \
  -e FF_DEMO=1 \
  ghcr.io/dvir-daniel/companyfeatures
```

```bash [From source]
git clone https://github.com/dvir-daniel/companyfeatures.git
cd companyfeatures
corepack enable          # gives you pnpm 11
pnpm install
pnpm demo                # builds the console and serves it with the sample data, in memory
```

:::

`FF_DEMO=1` fills a new database with a made-up installation: Development and Production, the apps `web`, `ios`
and `android`, a backend `api`, the dimensions **company › brand** with five companies and three brands, and six
flags. Without it, CompanyFeatures starts empty and the console offers the same sample data with one click.

The Docker command keeps nothing when it stops. To keep your data, add a volume (`-v companyfeatures:/data`) or use
Postgres: see [Docker](/self-hosting/docker).

## 2. Look around

Open <http://localhost:8787> and **create the admin account**: the first person to sign up becomes the admin.

![The flags of the sample data](/screenshots/console-flags.png)

- **Flags** lists the six sample flags. Open **New checkout**: a release to 10% of devices, locked off for Android
  below 5.0, with Acme Corp on it everywhere. The **Try it** panel answers for any company, brand, app and device, and
  explains each step.
- **Companies** and **Brands** are your dimensions' pages. Globex has its own API address, and its brands Lumen and
  Bolt follow it. Lumen also has a theme of its own.
- **Compare** shows two entities side by side, flag by flag.
- **Settings → Environments**: Production needs one approval. Change a flag there and it becomes a request in
  **Approvals**, which someone else must approve.

## 3. Read a flag from an app

Every entity has a secret **app link** per environment: open **Companies → Acme Corp → App link**. Its **App file**
address is everything Acme's web app may know, in one file:

```bash
curl http://localhost:8787/client/v1/flags/dev/web/acme/<secret>
```

```json
{
  "environment": "dev",
  "revision": 18,
  "flags": {
    "api_base_url": { "value": "https://api.example.com" },
    "max_upload_mb": { "value": 1000 },
    "new_checkout": { "value": true },
    "payments_enabled": { "value": true },
    "theme": { "value": { "accent": "#0a0a0a", "radius": 0 } },
    "welcome_message": {
      "codeDefault": true,
      "when": [{ "if": [{ "field": "locale.language", "op": "in", "values": ["he"] }], "value": "ברוכים הבאים!" }]
    }
  }
}
```

That file is everything Acme's web app gets: values, no rules about companies or apps, and nothing about any other
company. The only line left is one the device checks itself: `welcome_message` keeps the text written in the app's
code (`codeDefault`), except on a device whose language is Hebrew.

Apps don't need the file: they use OpenFeature. The same drawer shows the **OpenFeature token**. Ask with it as an app
would, with what the device knows about itself:

```bash
curl -X POST http://localhost:8787/ofrep/v1/evaluate/flags \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"context": {"targetingKey": "device-1", "locale": {"language": "he"}}}'
```

In a web app that is OpenFeature's own OFREP provider (see [OpenFeature](/sdk/openfeature)):

```ts
import { OpenFeature } from '@openfeature/web-sdk';
import { OFREPWebProvider } from '@openfeature/ofrep-web-provider';

await OpenFeature.setProviderAndWait(new OFREPWebProvider({
  baseUrl: 'http://localhost:8787',
  headers: [['Authorization', 'Bearer <token>']],
}));
OpenFeature.getClient().getNumberValue('max_upload_mb', 100);   // 1000
```

## Next

- [How it fits together](/guide/concepts): the model behind what you just saw.
- [Apps](/guide/apps): how your backend hands each app its link at sign-in.
- [Docker](/self-hosting/docker) and the [production checklist](/self-hosting/production) when you're ready to run it
  for real.
