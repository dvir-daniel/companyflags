# Flags in the age of AI

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
