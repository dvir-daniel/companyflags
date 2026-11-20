---
title: "Reading flags"
description: "Four ways to read flags: an app or a backend, and the server or your code deciding."
---

Apps and backends read flags with [OpenFeature](https://openfeature.dev), the open standard API for feature flags.
CompanyFlags has no SDK of its own: you use OpenFeature's providers. There are four ways to read, from two questions:
**where does your code run**, and **who decides the flag**?

| | **The server decides** (remote evaluation) | **Your code decides** (local evaluation) |
|---|---|---|
| **App** (web, mobile) | [OFREP providers for web, React, Android and iOS](/reading/remote-apps) | [The CDN file](/reading/local-apps): flagd JSON for the app's entity, with only the checks the device knows. Safe to share, cached by a CDN |
| **Backend** | [OFREP providers for Node.js, Go, Java, Python, .NET](/reading/remote-backends) | [flagd JSON](/reading/local-backends): flagd JSON for the backend's entity, with its full rules. Secret, never cached by a CDN |

Both local ways read the same format, [flagd](https://flagd.dev) JSON, with OpenFeature's flagd evaluator. What the
server puts in it differs: for a **backend** it keeps the rules that depend on the request, behind the backend's
secret key. For an **app** it settles everything it can ahead of time and leaves in only what the device must check
itself (its app version, its platform, which % group it's in), so a CDN can share it and nobody learns your rules
from it.

## Which to pick

- **Start with remote.** It's one provider and one key: no files to read and no sidecar to run. Every answer comes
  from the server's evaluator, with its reasons and % group names.
- **Move an app to local** (the CDN file) for very large fleets of devices, or apps that must start offline: a CDN
  answers instead of your server.
- **Move a backend to local** (flagd) when it evaluates many flags per second: no request per evaluation.

All four give the same answers: the server's tests compare each one with the server's own evaluator.

## What each gets

- **An app** gets values only, never the rules or a list of your entities. Its key is public: it goes in the app.
- **A backend** gets the rules too, for local evaluation. Its key is secret: a request with a backend's key from a
  browser is refused.

See [Evaluation context](/reading/context) for what every way sends: who is asking, and what the device or request
knows about itself.
