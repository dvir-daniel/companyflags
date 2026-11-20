---
title: "Flags in the age of AI"
description: "Ship AI-written code behind a flag, and roll models and prompts out and back as JSON flags."
---

AI writes code faster than people can read it, and AI features change behavior with a new model or a new prompt. Both
make the same thing more important: deciding **who gets what, at runtime**, and being able to take it back in seconds.
That is what feature flags are for.

## AI-written code ships behind a flag

When an assistant or an agent writes a change, nobody has read every line. Put the change behind a flag before it
merges:

- **Off in production by default.** A new flag starts switched off where changes need approval, so deploying the
  code changes nothing until someone turns it on.
- **A small group first.** Give early access to one company or team, then 1% → 5% → 25% of devices
  ([Releases](/guide/releases)). If something is wrong, few people see it.
- **A kill switch.** A flag with the *Kill switch* purpose turns the code path off at once, everywhere, without a
  revert or a deploy. On call can do it in production without waiting for a review (break-glass).
- **A second pair of eyes.** In production every change is a request someone else approves, and History says who
  did what. That holds for changes an agent proposes too.
- **A way out of the code.** Releases and experiments need a *Remove by* date, and the console shows when a release
  is ready to be cleaned up, so AI-made flags don't pile up.

A simple rule: if no one read the code line by line, it gets a flag.

## Models and prompts are config

An AI feature's behavior lives in its model, its prompt and its parameters. Keep them in a flag instead of in the
code, and you can change them without a deploy:

```json
{
  "fast":   { "model": "small-model", "temperature": 0.2, "prompt": "Answer in two sentences." },
  "strong": { "model": "large-model", "temperature": 0.4, "prompt": "Answer step by step." }
}
```

A JSON flag `assistant_config` with these two variants, read with OpenFeature:

```ts
const config = await client.getObjectValue('assistant_config', DEFAULT_CONFIG, { company: 'acme' });
const answer = await llm.generate({ model: config.model, temperature: config.temperature, system: config.prompt, input });
```

- **Roll out a new model step by step.** 10% of devices get `strong`, everyone else `fast`. Watch your own metrics,
  then go on or step back.
- **Per customer.** Acme pays for the large model: its own setting on the flag. Its brands follow it unless they say
  otherwise ([Dimensions](/guide/dimensions)).
- **Compare prompts.** An *Experiment* flag splits devices between variants; group names go to your analytics.
- **Roll back in seconds.** A model that misbehaves is one change away from the last good one, and History keeps every
  version.

The value never leaves the server as a rule: apps get only the value meant for them.

### Start from the AI config template

In **New flag**, pick **Start from: AI config**. It fills in a JSON flag with the *Config* purpose, named as you
typed, with two variants, `fast` and `strong`, and a JSON Schema they match:

- `model`: a string, required
- `temperature`: a number from 0 to 2
- `prompt`: a string
- `tools`: a list of strings, optional

Change any of it before you create the flag. The schema keeps a config whole: a variant or a typed value without a
`model`, or with a `temperature` of 5, is refused when it's saved, with the variant and the field in the error
([A JSON Schema](/guide/flags-and-rules#a-json-schema)).

## An alert turns a kill switch off

When an alert fires, it can turn a kill switch off at once: `POST /api/alerts/kill`, with an **alerts token**.
An *On call* or *Admin* person makes one: your name → **Account** → **+ New token**, and tick **For alerts only**
([Access tokens](/guide/security#access-tokens)).

An alerts token is On call, since turning a flag off without a review is break-glass, but it does nothing else: it
reads, changes and approves nothing, and every other address refuses it (403). So the secret in your alert tool can't
be used to approve a request or read your flags. Don't give an alert tool an ordinary On call token: it could do all
of that.

```bash
curl -X POST https://flags.example.com/api/alerts/kill \
  -H "Authorization: Bearer cfp_…" -H "Content-Type: application/json" \
  -d '{ "flag": "payments_enabled", "environment": "prod", "alert": "Payments error rate" }'
```

- **Only kill switches.** A flag with another purpose is refused (422).
- **At once, without a review.** It is break-glass, as when on call presses *Stop sending now*: only the flag's On/Off
  switch, only off. It doesn't serve the [safe value](/guide/approvals#the-safe-value); on call does that in the
  console. History shows it as break-glass, under the token's person, with the comment
  *Turned off by the alert “Payments error rate”*.
- **Off already?** Nothing changes, and the answer says `"alreadyOff": true`. An alert that fires twice is fine.
- **Not for agents, editors or browsers.** An agent's token is Viewer or Editor, so it is refused (403), and so is
  any token sent from a browser.

Turning it back on is a person's choice, in the console (a reviewed change where the environment needs one).

`flag`, `environment` and `alert` go in the JSON body, or in the address
(`/api/alerts/kill?flag=payments_enabled&environment=prod&alert=Payments%20error%20rate`) when the alert tool
sends a body of its own.

**Grafana.** Add a contact point of type *Webhook*:

- URL: `https://flags.example.com/api/alerts/kill?flag=payments_enabled&environment=prod&alert=Payments%20error%20rate`
- HTTP method: `POST`
- Authorization header: scheme `Bearer`, credentials `cfp_…`

Grafana sends its own JSON body; the address says what to turn off. A resolved alert calls again, which changes
nothing.

**Datadog.** In the Webhooks integration, add a webhook:

- URL: `https://flags.example.com/api/alerts/kill`
- Payload:

  ```json
  { "flag": "payments_enabled", "environment": "prod", "alert": "$EVENT_TITLE" }
  ```

- Custom headers:

  ```json
  { "Authorization": "Bearer cfp_…" }
  ```

Then mention it in the monitor's message, only for the alert (not the recovery):

```text
{{#is_alert}}@webhook-companyflags-kill{{/is_alert}}
```

Make an alerts token for each alert tool (your name → **Account** → **For alerts only**), and keep it in the alert
tool's secrets. It expires like any token (90 days by default, a year at most): make the next one before it does.

## Agents can manage flags too

[Flags as code](/guide/flags-as-code) keeps every flag's details, variants and services in a file next to the code.
An agent that adds a feature adds its flag to `flags.json` in the same pull request; CI runs
`companyflags flags plan` for the reviewer, and `flags push` when it merges. In production a new flag starts off,
putting it in a service there is a request an approver reviews, and turning it on is a reviewed change like any
other.

## What it doesn't do

CompanyFlags decides values; it doesn't watch your metrics. Stepping a rollout forward or back is done by a person (or
by your own automation with the CLI), and it doesn't call models itself: your code does, with the config the flag
gives it.

## For your agents

[AI resources](/guide/ai-resources): the docs as `llms.txt` and Markdown, a skill with these rules, a note for your
`AGENTS.md`, and OpenFeature's MCP server pointed at your flags.
