---
title: "Integrations"
description: "What's on by default, what each integration does, and how to turn one on or off with an environment variable."
---

The core of CompanyFlags is the console and its API, sign-in, the evaluator, approvals, history and publishing.
Everything that reads flags besides the console is an **integration**, and so is anything that runs after a publish.
Six are on by default. The rest turn on with an environment variable: no config file, and no image of your own.

## What each one does

| Integration | Id | On by default | What it does |
|---|---|---|---|
| [OFREP](/integrations/ofrep) | `ofrep` | yes | Apps and backends ask the server for their flags, with OpenFeature's OFREP providers. |
| [flagd](/integrations/flagd) | `flagd` | yes | Backends download their flags as flagd JSON and decide them in-process. |
| [CDN Files](/integrations/cdn-files) | `cdn-files` | yes | One flagd JSON file per environment, app service and entity, for your CDN to cache. |
| [CDN Purge: Cloudflare](/integrations/cdn-purge#cloudflare) | `cloudflare` | yes, once it has a zone and a token | Drops the files a publish changed from Cloudflare's cache. |
| [Webhooks](/integrations/webhooks) | `webhooks` | yes | Posts each change to Slack, CI or another system, and imports another system's values. |
| [AI Agents (MCP)](/integrations/mcp) | `mcp` | yes | An MCP server at `/mcp`, so AI agents read and change flags with your roles and approvals. |
| [Metrics](/integrations/metrics) | `metrics` | no: `FF_METRICS=on` | Prometheus's text format at `/metrics`. |
| [CDN Purge: CloudFront](/integrations/cdn-purge#cloudfront) | `cloudfront` | no: `FF_CLOUDFRONT_DISTRIBUTION_ID` | Invalidates the files a publish changed in a CloudFront distribution. |
| [CDN Purge: Cloud CDN](/integrations/cdn-purge#cloud-cdn) | `cloud-cdn` | no: `FF_CLOUD_CDN_PROJECT` and `FF_CLOUD_CDN_URL_MAP` | Invalidates the files a publish changed in Google Cloud CDN. |

App links stay in the core: `GET /sdk/v1/links/<dimension>/<entity>?service=<key>` always answers with the OFREP
token, and with the CDN file's `path` when CDN Files is on.

## Turn them on and off

With environment variables, which is all the Docker image and a cloud container need:

| Variable | What it does |
|---|---|
| (none set) | The six default integrations run. |
| `FF_INTEGRATIONS_OFF` | Comma-separated ids of default integrations to turn off, e.g. `mcp,webhooks`. An unknown id, or a part of the core, stops the start. |
| `FF_METRICS=on` | Turns on Metrics. `FF_METRICS_TOKEN` guards `/metrics`; a token without `FF_METRICS=on` stops the start. |
| `FF_CLOUDFRONT_DISTRIBUTION_ID` | Turns on the CloudFront purge, for that distribution. |
| `FF_CLOUD_CDN_PROJECT`, `FF_CLOUD_CDN_URL_MAP` | Turn on the Cloud CDN purge. Both are needed: one alone stops the start. `FF_CLOUD_CDN_HOST` is optional. |

```bash
# .env: no MCP server, metrics on
FF_INTEGRATIONS_OFF=mcp
FF_METRICS=on
FF_METRICS_TOKEN=<openssl rand -hex 24>
```

When it starts, the server says which integrations run: `integrations: OFREP, flagd, CDN files, …`. The console hides
what belongs to one that's off: **Settings → CDN** without the Cloudflare purge, the CDN file's address without CDN
Files, or the **Webhooks** page without Webhooks. `GET /api/meta` lists the ids that run, as `plugins`.

### In the config file

A config file can list the integrations instead, for one of your own or to keep the list in Git. Then the list
decides, whatever the environment says, and the start names the variables it ignored. The variables still fill in
the options of the integrations the list names, such as `FF_CLOUDFRONT_DISTRIBUTION_ID` for `cloudfront()`.

```ts
// companyflags.config.ts
import { defineConfig } from 'companyflags/config';
import { cloudfront, defaultPlugins, metrics } from 'companyflags/plugins';

export default defineConfig({ plugins: [...defaultPlugins(), metrics(), cloudfront()] });
```

`defaultPlugins()` is the six default integrations. See
[Configuration → The config file](/reference/configuration#the-config-file) for where the file goes, and
[Writing a Plugin](/reference/writing-a-plugin) to build an integration of your own.
