---
title: "Webhooks"
description: "Post each change to Slack, CI or another system, and import another system's values as they change."
---

Webhooks go both ways. **Out**: after each change, CompanyFlags posts what changed to an address: Slack, CI, or the
system you're [moving from](/guide/migration). **In**: another system posts its values, and they're imported.

Webhooks are the `webhooks()` plugin. It runs unless your config file lists plugins without it. See
[Plugins](/reference/plugins).

Admins set both up on the console's **Webhooks** page (in the sidebar, under Developers). Each one's history (added, changed, deleted, new secret) is in
History, which names only an address's host.

## Out

**+ Add webhook out** opens **New webhook out**: a name, the address, and:

- **Sends**: *changes* (what an environment serves: rules, defaults, entities' settings, which services a flag is in),
  *reviews* (a request made, approved, rejected or scheduled), and/or *security events* (see
  [Security events](#security-events)).
- **Environments**: every one, or some. Security events are sent whatever the environments.
- **Format**: signed JSON, a Slack message, or your own JSON made with JSONata.
- **Method** (POST, PUT or PATCH) and one **header**, such as the other system's `Authorization`.

The address and the header's value are kept on the server and never shown again; the signing secret is shown once.
**Test** sends a `ping` now.

### Delivery

- **One message per save**, in order: a change set of five flags is one message with five changes.
- **Every change once.** Each webhook keeps its own place in the history. Several servers on one database send each
  message once between them.
- **Retries.** A send that fails (no answer in 10 seconds, or anything but 2xx) is tried again after 5 s, 30 s,
  2 min, 10 min, 30 min, 1 h and 2 h. Later messages wait behind it, so the order holds. After the last try that
  message is passed over, and the console shows why.
- **Switched off**, a webhook sends nothing; switched back on, it goes on from then.
- Redirects aren't followed, and what the address answers isn't read: only its status.

### Where they can go

Webhooks out go to **public addresses only**: never this machine, your private network or a cloud's metadata address
(`169.254.169.254`). The address a name resolves to is checked as the connection is made, so a name can't point
somewhere else between the check and the send. Every address it can't reach, refused or not, gets the same message:
*It couldn't be reached.* A timeout says so.

For a system on your own network, allow its origin: `FF_WEBHOOK_ALLOWED_ORIGINS=http://ci.internal:8080`
(comma-separated), or `webhooks({ allowedOrigins: [...] })` in the config file. See
[Configuration](/self-hosting/configuration#webhooks).

### The JSON message

```json
{
  "type": "changes",
  "timestamp": "2026-11-19T17:02:11.000Z",
  "data": {
    "by": { "key": "ada@acme.com", "name": "Ada", "type": "user" },
    "changes": [
      {
        "id": 4211, "kind": "layer.update", "text": "Changed settings on max_upload_mb for Acme Corp",
        "environment": "production", "revision": 87, "flag": "max_upload_mb", "entity": "acme",
        "comment": "Bigger uploads for Acme", "request": 52, "before": { … }, "after": { … }
      }
    ],
    "values": { "production": { "flags": { "max_upload_mb": { "value": 100, "on": true, "entities": { "acme": 1000 } } } } },
    "url": "https://flags.example.com/#/history"
  }
}
```

- `type`: `changes`, `reviews`, `security`, or `ping` (the test).
- `changes[]`: each history entry of the save, with its `kind` (as in History's export), in words (`text`), and its
  `before` and `after`.
- `values`: for `changes`, what the flags it changed are set to **now**, per environment, as
  [CompanyFlags values](/guide/migration#companyflags-values). Use it to keep another system the same.
- `url`: the console's page for it, when `BETTER_AUTH_URL` is set.

In a `layer.*` change, `before` and `after` hold the flag's settings. An entity's have an `inherit`, one of three
fixed values whatever your dimensions are called (the names are older than dimensions, and stay):

| `inherit` | The console says |
|---|---|
| `base_rules_then_base_default` | Follow what's above |
| `base_rules_then_customer_default` | Own default last |
| `customer_only` | Skip what's above |

### Security events

For a SIEM (Splunk, Datadog, Elastic, Sentinel…): tick **Security events**, and the webhook gets one message of type
`security` for each of these, as History has it:

| `kind` | What happened |
|---|---|
| `sign_in` | Someone signed in. `after.with`: `password`, `two-factor`, `recovery code`, `sso` (with `connection`) or `provider` |
| `sign_in.failed` | A sign-in didn't go through. `after.why`: the reason, e.g. `INVALID_EMAIL_OR_PASSWORD`, `INVALID_CODE`, `sso_required`, `invite_required` |
| `sign_in.rules` | An admin changed the sign-in rules (break-glass admin, two-factor for admins, join role) |
| `person.add`, `person.role`, `person.invite`, `person.password_reset`, `person.remove` | People and their roles. A role from the identity provider's groups is `by.key` `sso:<connection id>` |
| `token.create`, `token.revoke` | Access tokens |
| `api_key.create`, `api_key.revoke` | API keys |
| `sso.add`, `sso.update`, `sso.remove` | Single sign-on connections (never their secrets) |

```json
{
  "type": "security",
  "timestamp": "2026-11-19T08:14:02.000Z",
  "data": {
    "by": { "key": "ada@acme.com", "name": "Ada", "type": "user" },
    "changes": [{ "id": 5120, "kind": "sign_in", "text": "ada@acme.com signed in with single sign-on (okta)",
      "environment": null, "after": { "person": "ada@acme.com", "with": "sso", "connection": "okta" }, … }]
  }
}
```

A failed sign-in's `by.type` is `system`, and `by.key` is the email that was typed. Most SIEMs take signed JSON at an
HTTP collector; use the header for its token, or JSONata to reshape the message.

### Signatures

Every message is signed the [Standard Webhooks](https://www.standardwebhooks.com) way, with the headers
`webhook-id`, `webhook-timestamp` and `webhook-signature`. A retry has the same `webhook-id`, so the receiving end
can drop one it has seen. Check them with a Standard Webhooks library, or:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(secret: string, headers: Headers, body: string) {
  const id = headers.get('webhook-id')!, ts = headers.get('webhook-timestamp')!;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;   // older than 5 minutes
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const want = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
  return headers.get('webhook-signature')!.split(' ').some((s) => {
    const got = s.replace(/^v1,/, '');
    return got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
  });
}
```

**New secret** (in the webhook's drawer) replaces it at once.

### Slack and Discord

Format **Slack message**, with a channel's [incoming webhook](https://api.slack.com/messaging/webhooks) address:

> **Ada** in **Production**
> • Changed settings on max_upload_mb for Acme Corp
> > Bigger uploads for Acme

Discord takes the same message at its webhook address with `/slack` on the end.

### Your own shape, with JSONata

Format **JSON made with JSONata**: your expression gets the JSON message and makes the body. When it makes nothing,
that message isn't sent, so an expression can also choose which messages go. To set each changed flag in an old
system that takes `PUT { "settings": [{ "name", "value" }] }`:

```
type = "changes" ? {
  "settings": [$each(data.values.production.flags, function($v, $k) { { "name": $k, "value": $v.value } })]
}
```

The expression can't read files or the network. It runs apart from the server, with a second, a memory limit and
4 MB of JSON in and out. One that runs over a limit switches its webhook off, with the reason in the console: fix the
expression, then switch it on.

## In

**+ Add webhook in** opens **New webhook in**: a name, the environment it imports into, the format (as for an
[import](/guide/migration#import)), and whether it creates missing flags. Its address is shown once:

```
https://flags.example.com/hooks/v1/ffh_3_k2…
```

The address is the password: keep it secret. **New address** replaces it at once.

The other system posts its JSON there:

```sh
curl -X POST https://flags.example.com/hooks/v1/ffh_3_k2… \
  -H 'content-type: application/json' \
  -d '{ "max_upload_mb": 1000 }'
```

| Answer | |
|---|---|
| `200` | `{ "applied": true, "revision": 88, "created": 0, "changed": 1, "warnings": [] }`; `changed: 0` when everything was already so |
| `202` | the environment needs approval: `{ "applied": false, "request": 53, … }`, a request for review |
| `400` | the body isn't JSON |
| `401` | no webhook at this address (or its address was replaced) |
| `409` | the webhook is switched off |
| `413` | the body is over 1 MB: refused as it arrives, before the address is checked, also when it's sent in chunks |
| `422` | `{ "error", "problems": [ … ] }`: nothing was imported |

A post goes through the same checks and saves as the console, recorded in History as *Webhook: &lt;its name&gt;*.
Values that are already so change nothing, so a webhook out to the same system, sending a change back, makes no loop.
