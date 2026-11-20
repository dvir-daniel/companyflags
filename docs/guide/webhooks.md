# Webhooks

Webhooks go both ways. **Out**: after each change, CompanyFlags posts what changed to an address: Slack, CI, or the
system you're [moving from](/guide/migration). **In**: another system posts its values, and they're imported.

Admins set both up on the console's **Migration** page. Each one's history (added, changed, deleted, new secret) is in
History, which names only an address's host.

## Out

**+ Webhook out**: a name, the address, and:

- **Sends**: *changes* (what an environment serves: rules, defaults, entities' settings, which flag sets a flag is in) and/or
  *reviews* (a request made, approved, rejected or scheduled).
- **Environments**: every one, or some.
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
- Redirects aren't followed.

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

- `type`: `changes`, `reviews`, or `ping` (the test).
- `changes[]`: each history entry of the save, with its `kind` (as in History's export), in words (`text`), and its
  `before` and `after`.
- `values`: for `changes`, what the flags it changed are set to **now**, per environment, as
  [CompanyFlags values](/guide/migration#companyflags-values). Use it to keep another system the same.
- `url`: the console's page for it, when `BETTER_AUTH_URL` is set.

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

The expression can't read files or the network, and stops after a second.

## In

**+ Webhook in**: a name, the environment it imports into, the format (as for an
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
| `413` | the body is over 1 MB |
| `422` | `{ "error", "problems": [ … ] }`: nothing was imported |

A post goes through the same checks and saves as the console, recorded in History as *Webhook: &lt;its name&gt;*.
Values that are already so change nothing, so a webhook out to the same system, sending a change back, makes no loop.
