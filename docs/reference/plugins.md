# Plugins

The core of CompanyFlags is the console and its API, sign-in, the evaluator, approvals, history and publishing.
Everything that reads flags besides the console is a **plugin**, and so is anything that runs after a publish. You
list the ones you want in [`companyflags.config.ts`](/self-hosting/configuration#the-config-file), as you do with
Better Auth's plugins:

```ts
import { defineConfig } from 'companyflags/config';
import { appFiles, cloudflare, flagd, ofrep, webhooks } from 'companyflags/plugins';

export default defineConfig({
  plugins: [
    ofrep(),
    flagd(),
    appFiles(),
    cloudflare(),
    webhooks(),
  ],
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
| `zoneId`, `token` | The zone the app files are served through, and an API token with **Zone → Cache Purge → Purge** on it. Each one left out comes from `CF_ZONE_ID` or `CF_API_TOKEN`. With both, they win over the console's; with neither, an admin sets them in the console. |
| `fetch` | How the server reaches Cloudflare. Leave it out. |

### `webhooks(options)`

| Option | What it does |
|---|---|
| `allowedOrigins` | Origins on your own network that webhooks out may reach, such as `['http://ci.internal:8080']`. Left out: `FF_WEBHOOK_ALLOWED_ORIGINS`. Without either, webhooks go to public addresses only. |
| `fetch` | How the server sends them. Leave it out: the default sends to public addresses only. |

Admins add the webhooks themselves, on the console's Migration page: see [Webhooks](/guide/webhooks).

## Writing a plugin

A plugin is an object with an `id` and a `setup` function. Make it with `definePlugin`, as a function that takes its
options:

```ts
// audit-feed.ts
import { Hono } from 'hono';
import { consoleRoutes, definePlugin } from 'companyflags/plugins';

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
      },
    };
  },
});
```

Then list it: `plugins: [ofrep(), flagd(), auditFeed({ webhook: 'https://hooks.example.com/flags' })]`.

This `onPublish` returns nothing. A plugin that purges a cache returns `'purged'` when it did (**Settings → CDN**
shows when), or `'off'` when it had nothing to do.

### What `setup` gets

| Field | What it is |
|---|---|
| `db` | The server's database. Writing to it doesn't add to History or publish anything, and a plugin has no tables of its own: the migrations are the core's. |
| `plane` | `plane.snapshots`, read only: what each environment serves now, by environment key. |
| `hub` | `hub.subscribe((environment, revision) => …)`: every server process hears each publish, for live readers such as an event stream. It returns the way to stop listening. `onPublish` runs once per publish, in one process, for work done once. |
| `evaluate` | `evaluate(environment, { flagSet, entity, attrs }, flagKey?)`: the one evaluator, answering as OFREP does. Without `flagKey`, every flag sent to the flag set. An unknown environment or entity is a `404`. |
| `env` | The server's environment variables. |
| `baseURL` | The console's address (`BETTER_AUTH_URL`), for links in what the plugin sends; unset when it isn't known. |
| `log` | Writes a line to the server's log. |

`entity` left out (or `null`) asks as no entity: what every device gets before sign-in. `attrs` are what the device
says about itself, flat (`{ "app.version": "6.0.0" }`); only the attributes an app may report are used.

### What it returns

All are optional.

| Field | When it's used |
|---|---|
| `routes` | A Hono app, mounted at the root. Pick addresses of your own: `/api` and `/sdk` are the core's, and `/client`, `/ofrep` and `/hooks` the built-in plugins'. |
| `prefixes` | Its address prefixes. An unknown address under one answers a JSON 404 instead of the console's page. Each starts with `/` and doesn't end with one. None may be or sit under `/api` or `/sdk`, or overlap another plugin's: the server checks at start. |
| `console` | A function that gets `{ actor, adminOnly }` and returns routes made with `consoleRoutes()`. They're mounted under `/api`, behind the console's sign-in, after the core's own routes, so a core route always answers first. `c.get('user')` is the person asking. A change needs the console's `X-Requested-With: companyflags` header. |
| `onPublish` | Runs after each publish of an environment, once per publish, with its key. Each plugin's runs whatever the others do. A failure is logged and kept on the publish, with the plugin's name, and never undoes the publish. |
| `worker` | Work it does on its own, in the background: `{ wake, stop, drain }`. It runs from `setup`; `stop` is called before the database closes. `webhooks()` sends with one. |

`setup` runs once, when the server starts, in the order of the list. Every entry must be a plugin with an `id` of its
own (lowercase letters, digits and dashes), checked before any setup runs: two with the same `id` stop the start. If
a `setup` throws, the background work of the plugins before it is stopped and the server doesn't start. The ids the
server runs are in the console's `GET /api/meta`, as `plugins`.

## Errors and types

Throw an `HttpError` from a route to answer with its status and `{"error": "…"}`. Any other error is logged with its
stack and answers `500 {"error":"internal error"}`. Inside the `console` function above, with `evaluate` from
`setup`:

```ts
import { HttpError } from 'companyflags/plugins';

app.get('/audit-feed/check/:entity', (c) => {
  adminOnly(c.get('user'));
  const r = evaluate('prod', { flagSet: 'web', entity: c.req.param('entity') }, 'new_checkout');
  if (r.errorCode) throw new HttpError(422, `new_checkout: ${r.errorDetails}`);
  return c.json({ value: r.value, reason: r.reason });
});
```

`companyflags/plugins` exports:

| | |
|---|---|
| The built-in plugins | `ofrep`, `flagd`, `appFiles`, `cloudflare`, `webhooks`, and the types `CloudflareOptions`, `WebhooksOptions` |
| For writing one | `definePlugin`, `consoleRoutes`, `HttpError`, `PluginError` |
| Types | `Plugin`, `PluginContext`, `PluginParts`, `ConsoleHelpers`, `ConsoleRoutes`, `OnPublish`, `Evaluate`, `Asking`, `Snapshots`, `Db`, `Queryable`, `Snapshot`, `EvalResult`, `Person`, `Actor` |

Throw a `PluginError` from `setup` when the plugin can't run as configured: the server stops with your message. The
server throws one too when the list itself is wrong (a duplicate `id`, a prefix that's taken).
