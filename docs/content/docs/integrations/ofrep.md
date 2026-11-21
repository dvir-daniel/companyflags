---
title: "OFREP"
description: "Apps and backends ask the server for their flags with OpenFeature's Remote Evaluation Protocol. On by default."
---

**What it does.** OFREP is OpenFeature's Remote Evaluation Protocol. Apps and backends send what they know about the
device or the request, and the server answers with each flag's value, from the one evaluator. Answers carry change
events, so a provider hears about a publish at once.

| Address | What it is |
|---|---|
| `POST /ofrep/v1/evaluate/flags` | Every flag in the key's service, at once |
| `POST /ofrep/v1/evaluate/flags/<key>` | One flag |
| `GET /ofrep/v1/events/…` | Change events (server-sent events), at the address an answer gives |

**When you need it.** Almost always. It is how apps on the web, Android and iOS, and backends in Node.js, Go, Java,
Python and .NET, read flags with OpenFeature's own OFREP providers. Start here; move to [flagd](/integrations/flagd)
or [CDN Files](/integrations/cdn-files) only for local evaluation.

## Turn it on

It is on by default. To turn it off, for an install where everything reads flagd JSON:

```bash
FF_INTEGRATIONS_OFF=ofrep
```

In a config file that lists integrations, it is `ofrep()`.

## What it needs

- **An API key** per environment and service (**API Keys**). An app's key is public; a backend's key is secret.
- **No CDN.** OFREP and its streams go straight to the server, never through a CDN
  ([Configuration → Keep OFREP and streams off the CDN](/reference/configuration#keep-ofrep-and-streams-off-the-cdn)).
- **A proxy that doesn't buffer**, with a read timeout above 120 seconds, so the change-event streams flow
  ([Configuration → Timeouts and body sizes](/reference/configuration#timeouts-and-body-sizes)).
- **`FF_TRUSTED_PROXIES`** behind a proxy, so each device's address counts toward its own stream limit
  ([Configuration → Client addresses](/reference/configuration#client-addresses)).

## More

- [Remote evaluation in apps](/reading/remote-apps) and [in backends](/reading/remote-backends): the providers and
  their code.
- [HTTP API](/reference/http-api): the requests and answers in full.
