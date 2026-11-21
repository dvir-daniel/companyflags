---
title: "Testing"
description: "Test code that reads flags: OpenFeature's in-memory provider in unit tests, a local server in integration tests, and flagd JSON offline."
---

Your code reads flags through OpenFeature, not through a library of ours. So you test it the way OpenFeature code is
tested: swap the provider. Nothing in your code changes between a test and production.

| Test | Provider | Needs a server |
|---|---|---|
| Unit test | OpenFeature's in-memory provider, with the values the test needs | No |
| Integration test | The provider you use in production, against a local CompanyFlags | Yes |
| Offline, or a backend's tests with real rules | flagd JSON in a file, read by OpenFeature's flagd provider | No |

## Unit tests: the in-memory provider

Every OpenFeature SDK has an in-memory provider: Node.js and the web, Go, Java, Python and .NET. Give it the flags
the test needs, with their variants. A `contextEvaluator` picks a variant from the context, for code that depends on
who is asking.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryProvider, OpenFeature } from '@openfeature/server-sdk';
import { uploadLimit } from './upload.ts';

test('Acme gets the larger upload limit', async () => {
  await OpenFeature.setProviderAndWait(new InMemoryProvider({
    max_upload_mb: {
      variants: { small: 100, large: 1000 },
      defaultVariant: 'small',
      contextEvaluator: (ctx) => (ctx.company === 'acme' ? 'large' : 'small'),
      disabled: false,
    },
  }));
  assert.equal(await uploadLimit(OpenFeature.getClient(), 'acme'), 1000);
  assert.equal(await uploadLimit(OpenFeature.getClient(), 'globex'), 100);
});
```

- **Pass the client in.** Code that takes an OpenFeature client as an argument tests with any provider. Code that
  sets a network provider when its module loads needs a server, or a mock, in every test.
- **Test the default too.** A flag the provider doesn't have returns the default in your code, as CompanyFlags does
  for a flag that isn't in the service. Leave the flag out to test that path.
- **One provider per test file,** or use a domain per test (`OpenFeature.setProvider('checkout-test', provider)`,
  then `OpenFeature.getClient('checkout-test')`) so tests that run at once don't share flags.

In React, OpenFeature's React SDK has a test provider that takes the values directly:

```tsx
import { OpenFeatureTestProvider } from '@openfeature/react-sdk';

render(
  <OpenFeatureTestProvider flagValueMap={{ new_checkout: true }}>
    <Checkout />
  </OpenFeatureTestProvider>,
);
```

## Integration tests: a local CompanyFlags

To test the real path, from your code through the provider to the server's rules, run CompanyFlags next to the
tests. The [Docker image](/deploy/docker-compose) with its embedded Postgres needs nothing else.

1. **Set it up once.** Start it, make the admin account with the setup link, and make an access token with the role
   **Admin** (see the [Quickstart](/guide/quickstart)). Keep the data volume and the `.env` with its secret, so the
   next run starts from there.
2. **Make what the tests read.** [`examples/seed.ts`](https://github.com/dvir-daniel/companyflags/blob/main/examples/seed.ts)
   makes an environment, a dimension with two entities, two services, three flags and a key for each service. Copy
   it and change it to your flags. Or keep your flags in a file and push it with
   [flags as code](/guide/flags-as-code) (`companyflags flags push --url … --token …`).
3. **Point the tests at it.** Use the provider you use in production, with the `dev` key the seed printed.

The seed uses the console's API, which may still change before 1.0. Pin the image to the version you test with.

## The same % group every time

A % of devices is not random. A device's group comes from a hash of the rule's salt (the flag key, unless set) and
the device's ID: `device.id`, or OpenFeature's `targetingKey` when there's none. So:

- The same ID always lands in the same group, on every request, over OFREP, in flagd JSON and in the CDN file.
- A test that needs "in the 10%" or "outside it" uses a fixed ID that lands there. Find one with the flag's
  **Debug** tab (**Test a device**): it shows the bucket an ID falls in, and the group.
- A context with no ID is never inside a %, unless the rule has a backup ID (`session.id`). Test that path too.

See [A % of devices](/guide/flags-and-rules#a--of-devices) for the hash, and [the Debug tab](/guide/flags-and-rules#the-debug-tab).

## Offline: flagd JSON in a file

`companyflags flags export --flagd` writes the flagd JSON a backend would download for one entity, to a file. Check
the file in next to your tests, or make it in CI. Then the tests read real rules, with no server and no network:

```ts
import { OpenFeature } from '@openfeature/server-sdk';
import { FlagdProvider } from '@openfeature/flagd-provider';

await OpenFeature.setProviderAndWait(new FlagdProvider({
  resolverType: 'in-process',
  offlineFlagSourcePath: './test/flags.flagd.json',
}));
```

Or run flagd itself with the file as its source (`flagd start --uri file:./test/flags.flagd.json`). The answers are
the server's: the same file is what [local evaluation in backends](/reading/local-backends) reads. See the
[CLI](/reference/cli) for the command's options.
