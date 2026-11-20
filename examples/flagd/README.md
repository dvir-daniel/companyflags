# flagd example

Docker Compose with CompanyFlags and [flagd](https://flagd.dev). flagd syncs Acme's flags in the `api` service as
flagd JSON, from `/sdk/v1/flagd/company/acme`, with the `api` service's key. It asks again every 30 seconds with the
last ETag, and usually gets a `304`. Your backends then evaluate in memory, with no request to CompanyFlags each time.

## Run it

1. Start CompanyFlags:

   ```bash
   cd examples/flagd
   echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)" > .env
   docker compose up -d companyflags
   docker compose logs companyflags     # the setup link
   ```

2. Open the setup link, make the admin account and an access token, and run the seed from the repo's root. See
   [the examples' README](../README.md):

   ```bash
   FLAGS_URL=http://localhost:8787 FLAGS_TOKEN=cfp_… node examples/seed.ts
   ```

3. Add the `api` service's key to `.env`, beside the secret, and start flagd:

   ```bash
   echo "FLAGS_API_KEY=ff_dev_api_…" >> .env
   docker compose up -d flagd
   ```

4. Ask flagd. It speaks OFREP too, on port 8016:

   ```bash
   curl -X POST http://localhost:8016/ofrep/v1/evaluate/flags/max_upload_mb \
     -H 'Content-Type: application/json' -d '{"context": {"targetingKey": "user-1"}}'
   ```

   ```json
   { "key": "max_upload_mb", "value": 1000, "reason": "STATIC", "variant": "large",
     "metadata": { "environment": "dev", "flagSetId": "dev/api/acme" } }
   ```

   The flags are Acme's already: the source's address names the company, so the context needn't.

## Read it from a backend

Use OpenFeature's flagd provider. In Node.js, with `@openfeature/server-sdk` and `@openfeature/flagd-provider`:

```ts
await OpenFeature.setProviderAndWait(new FlagdProvider({ resolverType: 'in-process', host: 'localhost', port: 8015 }));
const limit = await OpenFeature.getClient().getNumberValue('max_upload_mb', 100);
```

Port 8015 is flagd's sync stream (the provider evaluates in-process), 8013 its gRPC evaluation.

The flagd version is pinned (`v0.18.2`): flagd has changed its `%` hash before, so check an upgrade against
[Backends](https://dvir-daniel.github.io/companyflags/guide/backends) first. `docker compose down -v` removes it all.
