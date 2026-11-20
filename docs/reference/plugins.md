# Plugins

The core of CompanyFeatures is the console and its API, sign-in, the evaluator, approvals, history and publishing.
Everything that reads flags besides the console is a **plugin**, and so is anything that runs after a publish. You
list the ones you want in [`companyfeatures.config.ts`](/self-hosting/configuration#the-config-file), as you do with
Better Auth's plugins:

```ts
import { defineConfig } from 'companyfeatures/config';
import { appFiles, cloudflare, flagd, ofrep, webhooks } from 'companyfeatures/plugins';

export default defineConfig({
  plugins: [ofrep(), flagd(), appFiles(), cloudflare(), webhooks()],
});
```

With no config file, or a config without `plugins`, all five built-in plugins run. With a list, only the plugins on it
run. The server says which ones when it starts, and the console hides what belongs to a plugin that's off: the CDN
settings without `cloudflare()`, for example, the app file's address without `appFiles()`, or the webhooks without
`webhooks()`.

## Built-in plugins

| Plugin | Id | What it adds |
|---|---|---|
| `ofrep()` | `ofrep` | [OpenFeature's Remote Evaluation Protocol](/sdk/openfeature): `POST /ofrep/v1/evaluate/flags`, one flag, and change events. For OpenFeature's OFREP providers on the web, Android, iOS and servers. |
| `flagd()` | `flagd` | [flagd JSON](/guide/backends) for backends that evaluate in-process: `GET /sdk/v1/flagd/<dimension>/<entity>`, with an API key. |
| `appFiles()` | `app-files` | [App files](/sdk/app-file): one values-only file per environment, flag set and entity, made to sit behind a CDN. `GET /client/v1/flags/…`. |
| `cloudflare(options?)` | `cloudflare` | [Purges Cloudflare's cache](/self-hosting/cdn#purge-on-publish) after each publish, and adds **Settings → CDN** to the console. |
| `webhooks(options?)` | `webhooks` | [Webhooks](/guide/webhooks): out, after each change (signed JSON, Slack, or your own shape), and in, `POST /hooks/v1/<token>`. Adds them to the console's **Migration** page. |

App links stay in the core: `GET /sdk/v1/links/<dimension>/<entity>?flagSet=<key>` always answers with the OFREP
token, and with the app file's `path` when `appFiles()` runs.

### `cloudflare(options)`

| Option | What it does |
|---|---|
| `zoneId`, `token` | The zone the app files are served through, and an API token with **Zone → Cache Purge → Purge** on it. Set both, or neither: an admin can set them in the console instead. Without a config file they come from `CF_ZONE_ID` and `CF_API_TOKEN`. |
| `fetch` | How the server reaches Cloudflare. Leave it out. |

### `webhooks(options)`

| Option | What it does |
|---|---|
| `fetch` | How the server sends them. Leave it out. |

Admins add the webhooks themselves, on the console's Migration page: see [Webhooks](/guide/webhooks).

## Writing a plugin

A plugin is an object with an `id` and a `setup` function. Make it with `definePlugin`, as a function that takes its
options:

```ts
// audit-feed.ts
import { Hono } from 'hono';
import { consoleRoutes, definePlugin } from 'companyfeatures/plugins';

export const auditFeed = (o: { webhook: string }) => definePlugin({
  id: 'audit-feed',
  setup: ({ plane, log }) => {
    const routes = new Hono();
    routes.get('/audit-feed/v1/revisions', (c) =>
      c.json(Object.fromEntries([...plane.snapshots].map(([env, s]) => [env, s.revision]))));
    return {
      routes,                                       // served at the root, for apps and backends
      prefixes: ['/audit-feed'],                    // an unknown address under it is a JSON 404
      console: ({ adminOnly }) => {                 // under /api, behind the console's sign-in
        const app = consoleRoutes();
        app.get('/audit-feed', (c) => { adminOnly(c.get('user')); return c.json({ webhook: o.webhook }); });
        return app;
      },
      onPublish: async (environment) => {           // after each publish of an environment
        await fetch(o.webhook, { method: 'POST', body: JSON.stringify({ environment }) });
        log(`told ${o.webhook} about ${environment}`);
        return 'purged';                            // or 'off' when it had nothing to do
      },
    };
  },
});
```

Then list it: `plugins: [ofrep(), flagd(), auditFeed({ webhook: 'https://hooks.example.com/flags' })]`.

### What `setup` gets

| Field | What it is |
|---|---|
| `db` | The database, through the change journal: a change made with it is recorded in History and published once it commits. |
| `plane` | `plane.snapshots`: what each environment serves now, by environment key. |
| `hub` | Live updates: what the console and OFREP's change events listen to. |
| `keys`, `links`, `flagSets` | The API keys, app-link secrets and flag sets the server keeps in memory. |
| `baseURL` | The console's address (`BETTER_AUTH_URL`), for links in what the plugin sends; unset when it isn't known. |
| `log` | Writes a line to the server's log. |

### What it returns

All are optional.

| Field | When it's used |
|---|---|
| `routes` | A Hono app, mounted at the root. Pick addresses of your own: `/api`, `/client`, `/sdk`, `/ofrep` and `/hooks` are taken. |
| `prefixes` | Its address prefixes. An unknown address under one answers a JSON 404 instead of the console's page. |
| `console` | A function that gets `{ actor, adminOnly }` and returns routes made with `consoleRoutes()`. They're mounted under `/api`, behind the console's sign-in: `c.get('user')` is the person asking. A change needs the console's `X-Requested-With: companyfeatures` header. |
| `onPublish` | Runs after each publish of an environment, once per publish, with its key. A failure is logged and shown with the publish in Settings, and never undoes the publish. Return `'off'` when it had nothing to do. |
| `worker` | Work it does on its own, in the background: `{ wake, stop, drain }`. It runs from `setup`; `stop` is called before the database closes. `webhooks()` sends with one. |

`setup` runs once, when the server starts, in the order of the list. Two plugins with the same `id` stop the start.
The ids the server runs are in the console's `GET /api/meta`, as `plugins`.
