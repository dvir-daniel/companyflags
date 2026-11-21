---
title: "Plugins"
description: "Everything that reads flags besides the console is a plugin, listed in companyflags.config.ts."
---

The core of CompanyFlags is the console and its API, sign-in, the evaluator, approvals, history and publishing.
Everything that reads flags besides the console is a **plugin**, and so is anything that runs after a publish. You
list the ones you want in [`companyflags.config.ts`](/self-hosting/configuration#the-config-file), as you do with
Better Auth's plugins:

```ts
import { defineConfig } from 'companyflags/config';
import { cdnFiles, cloudflare, flagd, mcp, ofrep, webhooks } from 'companyflags/plugins';

export default defineConfig({
  plugins: [
    ofrep(),
    flagd(),
    cdnFiles(),
    cloudflare(),
    webhooks(),
    mcp(),
  ],
});
```

With no config file, or a config without `plugins`, these six built-in plugins run (`defaultPlugins()` is that
list). With a list, only the plugins on it run. `metrics()`, `cloudfront()` and `cloudCdn()` run only when they're
listed: `plugins: [...defaultPlugins(), metrics()]`. The server says which ones when it starts, and the console hides what belongs to a plugin that's off: the CDN
settings without `cloudflare()`, for example, the CDN file's address without `cdnFiles()`, or the webhooks without
`webhooks()`.

## Built-in plugins

| Plugin | Id | What it adds |
|---|---|---|
| `ofrep()` | `ofrep` | [OpenFeature's Remote Evaluation Protocol](/reading/overview): `POST /ofrep/v1/evaluate/flags`, one flag, and change events. For OpenFeature's OFREP providers on the web, Android, iOS and servers. |
| `flagd()` | `flagd` | [flagd JSON](/reading/overview) for backends that evaluate in-process: `GET /sdk/v1/flagd/<dimension>/<entity>`, with a backend service's key. |
| `cdnFiles()` | `cdn-files` | [CDN files](/reading/local-apps): flagd JSON per environment, app service and entity, for a CDN to cache. `GET /cdn/v1/flags/…`. |
| `cloudflare(options?)` | `cloudflare` | [Purges Cloudflare's cache](/self-hosting/cdn#purge-on-publish) after each publish, and adds **Settings → CDN** to the console. |
| `webhooks(options?)` | `webhooks` | [Webhooks](/guide/webhooks): out, after each change (signed JSON, Slack, or your own shape), and in, `POST /hooks/v1/<token>`. Adds them to the console's **Settings → Migration** page. |
| `mcp()` | `mcp` | An MCP server for AI agents at `POST /mcp` (Streamable HTTP, stateless), with an access token (`Authorization: Bearer cfp_…`). Its tools read, explain and compare flags, and change them through the console's API (flags, services, defaults, rules, an entity's own default, release steps), so roles and approvals hold: where an environment needs approval, a change is a request, and `request_status` follows it. For clients that only start local servers: `companyflags mcp`. |
| `metrics(options?)` | `metrics` | Prometheus's text format at `GET /metrics`: requests by route, apps' and backends' reads, publish lag, open event streams ([Monitoring → Metrics](/self-hosting/monitoring#metrics)). Not in `defaultPlugins()`. |
| `cloudfront(options?)` | `cloudfront` | Invalidates the CDN files a publish changed in an AWS CloudFront distribution, by cache tag. Not in `defaultPlugins()`. |
| `cloudCdn(options?)` | `cloud-cdn` | Invalidates the CDN files a publish changed in Google Cloud CDN, by cache tag. Not in `defaultPlugins()`. |

App links stay in the core: `GET /sdk/v1/links/<dimension>/<entity>?service=<key>` always answers with the OFREP
token, and with the CDN file's `path` when `cdnFiles()` runs.

### `cloudflare(options)`

| Option | What it does |
|---|---|
| `zoneId`, `token` | The zone the CDN files are served through, and an API token with **Zone → Cache Purge → Purge** on it. Each one left out comes from `CF_ZONE_ID` or `CF_API_TOKEN`. With both, they win over the console's; with neither, an admin sets them in the console. |
| `fetch` | How the server reaches Cloudflare. Leave it out. |

### `cloudfront(options)`

After each publish, it sends one `CreateInvalidation` to the distribution, with the publish's cache tags as `#tag`
paths. More than 100 tags invalidate the environment's tag instead. Apps get the change in seconds instead of within
a minute.

```ts
plugins: [...defaultPlugins(), cloudfront({ distributionId: 'E2QWRUHAPOMQZL' })]
```

| Option | What it does |
|---|---|
| `distributionId` | The distribution the CDN files are served through. Left out: `FF_CLOUDFRONT_DISTRIBUTION_ID`. Without either, `/readyz` warns and nothing is purged. |
| `fetch` | How the server reaches AWS. Leave it out. |

- **The distribution** needs cache tags turned on when you create it: `CacheTagConfig` with the header `Cache-Tag`.
  Files cached before that carry no tags.
- **No key is stored.** The server finds AWS credentials as AWS's SDKs do: `AWS_ACCESS_KEY_ID` and
  `AWS_SECRET_ACCESS_KEY` (with `AWS_SESSION_TOKEN`), then a web identity token (EKS IRSA:
  `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_ROLE_ARN`), then the container's credentials (an ECS task role, EKS Pod
  Identity), then the instance's profile (EC2, IMDSv2). Credentials that expire are fetched again shortly before they
  do.
- **The permission:** `cloudfront:CreateInvalidation` on the distribution, and nothing else:

  ```json
  {
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": "cloudfront:CreateInvalidation",
      "Resource": "arn:aws:cloudfront::123456789012:distribution/E2QWRUHAPOMQZL"
    }]
  }
  ```

- **A purge that fails** (`TooManyInvalidationsInProgress`, a missing permission) is kept on the publish, and
  `/readyz` warns of it. The server purges each publish again about 11 seconds later, which tries again.

### `cloudCdn(options)`

After each publish, it calls `invalidateCache` on the load balancer's URL map with the publish's cache tags. Cloud CDN
takes 10 tags a call, so it sends up to 3 calls; more tags than that invalidate the environment's tag instead. An
invalidation takes effect in about 10 seconds.

```ts
plugins: [...defaultPlugins(), cloudCdn({ project: 'acme-flags', urlMap: 'flags-map', host: 'flags.example.com' })]
```

| Option | What it does |
|---|---|
| `project`, `urlMap` | The Google Cloud project, and the URL map the CDN files go through. Left out: `FF_CLOUD_CDN_PROJECT` and `FF_CLOUD_CDN_URL_MAP`. Without them, `/readyz` warns and nothing is purged. |
| `host` | Only this host's files. Left out: `FF_CLOUD_CDN_HOST`, else every host of the URL map. |
| `fetch` | How the server reaches Google Cloud. Leave it out. |

- **No key is stored.** The token is the service account's, from the metadata server (Cloud Run, GKE, Compute
  Engine), kept until shortly before it expires. To try it from your own machine, set `GOOGLE_OAUTH_ACCESS_TOKEN`
  (`gcloud auth print-access-token`).
- **The permission:** give the service account a custom role with only `compute.urlMaps.invalidateCache`, not
  Compute Network Admin:

  ```bash
  gcloud iam roles create cdnInvalidator --project=acme-flags \
    --title="CDN invalidator" --permissions=compute.urlMaps.invalidateCache
  gcloud projects add-iam-policy-binding acme-flags \
    --member=serviceAccount:companyflags@acme-flags.iam.gserviceaccount.com --role=projects/acme-flags/roles/cdnInvalidator
  ```

- **A purge that fails** (a missing permission, too many invalidations a minute) is kept on the publish, and `/readyz`
  warns of it. The server purges each publish again about 11 seconds later.

### `metrics(options)`

| Option | What it does |
|---|---|
| `token` | A scraper sends it as `Authorization: Bearer <token>`. Left out: `FF_METRICS_TOKEN`. Without either, `/metrics` is open to whoever reaches the server: keep it on your own network. |

### `webhooks(options)`

| Option | What it does |
|---|---|
| `allowedOrigins` | Origins on your own network that webhooks out may reach, such as `['http://ci.internal:8080']`. Left out: `FF_WEBHOOK_ALLOWED_ORIGINS`. Without either, webhooks go to public addresses only. |
| `fetch` | How the server sends them. Leave it out: the default sends to public addresses only. |

Admins add the webhooks themselves, on the console's Webhooks page: see [Webhooks](/guide/webhooks).

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

Then list it: `plugins: [ofrep(), flagd(), auditFeed({ webhook: 'https://hooks.example.com/flags' })]`.

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
| `baseURL` | The console's address (`BETTER_AUTH_URL`), for links in what the plugin sends; unset when it isn't known. |
| `log` | Writes a line to the server's log. |
| `request` | The server's own fetch for its API: `request('/api/v1/environments/prod/flags', { headers: { authorization } })`. It is answered in the same process. Send the caller's own access token, so their role and the approvals hold. Call it from a request, not from `setup`. Prefer the [stable API](/reference/http-api#the-stable-api-apiv1): the rest of `/api` may change in any release. |
| `secrets` | `secrets.seal(value)` and `secrets.open(sealed)`: a secret the plugin keeps for another system, sealed before it goes into the database (AES-GCM, with a key from `BETTER_AUTH_SECRET`). `open` throws a `SealError` for one sealed with another secret: ask for it again. |
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
