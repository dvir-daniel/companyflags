---
title: "flagd"
description: "Backends download their flags as flagd JSON and decide them in-process, with OpenFeature's flagd provider. On by default."
---

**What it does.** A backend downloads its flags as [flagd](https://flagd.dev) JSON, with the full rules, and decides
each flag itself with OpenFeature's flagd provider: no request per evaluation. The JSON comes from the one evaluator,
so the answers are the server's.

| Address | What it is |
|---|---|
| `GET /sdk/v1/flagd/<dimension>/<entity>` | The key's service for one entity |
| `GET /sdk/v1/flagd` | The same, for a key scoped to one entity |
| `GET /sdk/v1/flagd/service` | One document for every entity the key may ask about, for a backend shared by many |

**When you need it.** When a backend evaluates many flags per second, or should keep answering while the server is
away. Most backends start with [OFREP](/integrations/ofrep).

## Turn it on

It is on by default. To turn it off:

```bash
FF_INTEGRATIONS_OFF=flagd
```

In a config file that lists integrations, it is `flagd()`.

## What it needs

- **A backend service's key.** It is secret: flagd JSON has the rules, so an app's key is refused.
- **flagd as a sidecar, or the in-process provider,** polling the address above. Expose `/sdk/` to your backends
  only ([Configuration → What to expose](/reference/configuration#what-to-expose)).
- **No CDN.** The answers are `private`, never for a CDN.

## More

- [Local evaluation in backends](/reading/local-backends): the provider, the sidecar, and how soon a change arrives.
- [HTTP API → flagd JSON](/reference/http-api#flagd-json).
