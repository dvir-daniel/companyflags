---
title: "Writing a Plugin"
description: "The plugin API, for building an integration of your own: routes, console routes, middleware, work after each publish."
---

Every [integration](/integrations/overview) is a **plugin**: OFREP, flagd, CDN files, the CDN purges, webhooks,
metrics and the MCP server are all built with the API on this page. This page is for people building their own: a
new way to read flags, or something to do after a publish. To turn the built-in ones on and off, see
[Integrations](/integrations/overview).

A plugin runs when a config file lists it. Keep the built-in ones in the list with `defaultPlugins()`:

```ts
// companyflags.config.ts
import { defineConfig } from 'companyflags/config';
import { defaultPlugins } from 'companyflags/plugins';
import { auditFeed } from './audit-feed.ts';

export default defineConfig({
  plugins: [...defaultPlugins(), auditFeed({ webhook: 'https://hooks.example.com/flags' })],
});
```

With a list, only the plugins on it run, whatever the environment says, and the start names the integration
variables it ignored. The file goes where `companyflags/config` resolves: the clone's root, or `/app` in the Docker
image ([Configuration → The config file](/reference/configuration#the-config-file)).

## Built-in plugins

The built-in integrations are plugins you can list, each with its id. Each page says what it does and its options.

| Plugin | Id | In `defaultPlugins()` | Page |
|---|---|---|---|
| `ofrep()` | `ofrep` | yes | [OFREP](/integrations/ofrep) |
| `flagd()` | `flagd` | yes | [flagd](/integrations/flagd) |
| `cdnFiles()` | `cdn-files` | yes | [CDN Files](/integrations/cdn-files) |
| `cloudflare({ zoneId, token })` | `cloudflare` | yes | [CDN Purge → Cloudflare](/integrations/cdn-purge#cloudflare) |
| `webhooks({ allowedOrigins })` | `webhooks` | yes | [Webhooks](/integrations/webhooks) |
| `mcp()` | `mcp` | yes | [AI Agents (MCP)](/integrations/mcp) |
| `metrics({ token })` | `metrics` | no | [Metrics](/integrations/metrics) |
| `cloudfront({ distributionId })` | `cloudfront` | no | [CDN Purge → CloudFront](/integrations/cdn-purge#cloudfront) |
| `cloudCdn({ project, urlMap, host })` | `cloud-cdn` | no | [CDN Purge → Cloud CDN](/integrations/cdn-purge#cloud-cdn) |

Options left out come from their environment variables. The ones that reach another system also take `fetch`: how
the server reaches it. Leave it out.

## Writing a plugin

A plugin is an object with an `id` and a `setup` function. Make it with `definePlugin`, as a function that takes its
options:

```ts
// audit-feed.ts
import { consoleRoutes, definePlugin, pluginRoutes } from 'companyflags/plugins';

export const auditFeed = (o: { webhook: string }) => definePlugin({
  id: 'audit-feed',
  setup: ({ plane, log }) => {
    const routes = pluginRoutes();                  // a Hono app made with the server's own hono
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

Then list it, as above: `plugins: [...defaultPlugins(), auditFeed({ webhook: 'https://hooks.example.com/flags' })]`.

`hono` is a peer dependency of the `companyflags` package: installing it installs hono beside it, so a plugin that
imports `hono` itself (for a middleware such as `hono/cors`) gets the server's copy, and the types match.

This `onPublish` returns nothing. A plugin that purges a cache returns `'purged'` when it did (**Settings → CDN**
shows when), or `'off'` when it had nothing to do.

### What `setup` gets

| Field | What it is |
|---|---|
| `db` | The server's database. Writing to it doesn't add to History or publish anything, and a plugin has no tables of its own: the migrations are the core's. |
| `plane` | `plane.snapshots`, read only: what each environment serves now, by environment key. |
| `hub` | `hub.subscribe((environment, revision, scope) => …)`: every server process hears each publish, for live readers such as an event stream. `scope` says whose answers it may have changed since the one before: `null` for anyone's, else `{ entities, links }` (these entities and those under them; these entities' replaced app links), both empty for nobody's. It returns the way to stop listening. `onPublish` runs once per publish, in one process, for work done once. |
| `evaluate` | `evaluate(environment, { service, entity, attrs }, flagKey?)`: the one evaluator, answering as OFREP does. Without `flagKey`, every flag sent to the service. An unknown environment or entity is a `404`. |
| `env` | The server's environment variables. |
| `baseURL` | The console's address (`FF_PUBLIC_URL`), for links in what the plugin sends; unset when it isn't known. |
| `log` | Writes a line to the server's log. |
| `request` | The server's own fetch for its API: `request('/api/v1/environments/prod/flags', { headers: { authorization } })`. It is answered in the same process. Send the caller's own access token, so their role and the approvals hold. Call it from a request, not from `setup`. Prefer the [stable API](/reference/http-api#the-stable-api-apiv1): the rest of `/api` may change in any release. |
| `secrets` | `secrets.seal(value)` and `secrets.open(sealed)`: a secret the plugin keeps for another system, sealed before it goes into the database (AES-GCM, with a key from `FF_SECRET`). `open` throws a `SealError` for one sealed with another secret: ask for it again. |
| `publishState` | `await publishState()`: per environment, its `revision`, the one this process is `serving`, `lagSeconds`, the `error` of a publish that fails and the `purgeError` of its last purge, as `/readyz` reports them. |
| `warnings` | `await warnings()`: what `/readyz` lists under `warnings`. |

`entity` left out (or `null`) asks as no entity: what every device gets before sign-in. `attrs` are what the device
says about itself, flat (`{ "app.version": "6.0.0" }`); only the attributes an app may report are used.

### What it returns

All are optional.

| Field | When it's used |
|---|---|
| `routes` | A Hono app (`pluginRoutes()`), mounted at the root. Every route must be under one of its `prefixes`: one that isn't (`GET /`, `*`, or another address) stops the start. |
| `prefixes` | Its address prefixes. Its routes live under them, and an unknown address under one answers a JSON 404 instead of the console's page. Each starts with `/` and doesn't end with one. None may be, sit under or hold the core's (`/api`, `/sdk/v1/links`, `/oauth`, `/.well-known`, `/healthz`, `/readyz`, `/assets`, `/index.html`), or overlap another plugin's (the built-ins have `/ofrep`, `/sdk/v1/flagd`, `/cdn`, `/hooks`, `/mcp` and `/metrics`): the server checks at start. |
| `middleware` | Hono middleware, `async (c, next) => { …; await next(); … }`: it runs on every request, before any route, and sees every answer after `await next()`. For an access log, tracing or metrics (`metrics()` uses it). It may add headers; it must not change who may do what. |
| `console` | A function that gets `{ actor, adminOnly, body }` and returns routes made with `consoleRoutes()`. `await body(c)` is the request's JSON object (an empty body is a `400 bad_json`; `body(c, true)` makes it `{}`). They're mounted under `/api`, behind the console's sign-in, after the core's own routes, so a core route always answers first. `c.get('user')` is the person asking. A change needs the console's `X-Requested-With: companyflags` header. |
| `purges` | `true` when its `onPublish` purges a CDN's cache (`cloudflare()`, `cloudfront()`, `cloudCdn()`). |
| `onPublish` | Runs after each publish of an environment, once per publish, with its key and the publish's `scope` (as `hub` gives it), so a cache drops only what changed. Each plugin's runs whatever the others do. A failure is logged and kept on the publish, with the plugin's name, and never undoes the publish. |
| `warnings` | `() => string[]` (or a promise of them): what an operator should know though the server serves. `/readyz` lists them under `warnings` and still answers `200`; `cloudflare()` warns when its saved token can't be read. |
| `worker` | Work it does on its own, in the background: `{ wake, stop, drain }`. It runs from `setup`; `stop` is called before the database closes. `webhooks()` sends with one. |

`setup` runs once, when the server starts, in the order of the list. Every entry must be a plugin with an `id` of its
own (lowercase letters, digits and dashes), checked before any setup runs: two with the same `id` stop the start. If
a `setup` throws, the background work of the plugins before it is stopped and the server doesn't start. The ids the
server runs are in the console's `GET /api/meta`, as `plugins`.

## Errors and types

Throw an `HttpError` from a route to answer with its status and `{"error": "…", "code": "…"}`:
`new HttpError(409, 'that name is taken already', {}, 'already_exists')`. Without a code it gets its status's
(`invalid` for 422, `not_found` for 404, …; the codes are in [HTTP API](/reference/http-api#errors), and
`ERROR_CODES` lists them). Any other error is logged with its stack and answers
`500 {"error":"internal error","code":"internal"}`. Inside the `console` function above, with `evaluate` from
`setup`:

```ts
import { HttpError } from 'companyflags/plugins';

app.get('/audit-feed/check/:entity', (c) => {
  adminOnly(c.get('user'));
  const r = evaluate('prod', { service: 'web', entity: c.req.param('entity') }, 'new_checkout');
  if (r.errorCode) throw new HttpError(422, `new_checkout: ${r.errorDetails}`);
  return c.json({ value: r.value, reason: r.reason });
});
```

`companyflags/plugins` exports:

| | |
|---|---|
| The built-in plugins | `ofrep`, `flagd`, `cdnFiles`, `cloudflare`, `webhooks`, `mcp`, `metrics`, `cloudfront`, `cloudCdn`, `defaultPlugins` (the six that run without a list), and the types `CloudflareOptions`, `WebhooksOptions`, `MetricsOptions`, `CloudFrontOptions`, `CloudCdnOptions` |
| For writing one | `definePlugin`, `pluginRoutes`, `consoleRoutes`, `HttpError`, `ERROR_CODES`, `PluginError`, `SealError`, `CORE_PREFIXES` |
| Types | `Plugin`, `PluginContext`, `PluginParts`, `ConsoleHelpers`, `ConsoleRoutes`, `OnPublish`, `Evaluate`, `Asking`, `Snapshots`, `Sealer`, `PublishState`, `ErrorCode`, `Db`, `Queryable`, `Snapshot`, `EvalResult`, `Person`, `Actor` |

Throw a `PluginError` from `setup` when the plugin can't run as configured: the server stops with your message. The
server throws one too when the list itself is wrong (a duplicate `id`, a prefix that's taken, a route outside the
plugin's prefixes).
