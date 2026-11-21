# flagd example

Docker Compose with CompanyFlags and [flagd](https://flagd.dev). flagd syncs Acme's flags in the `api` service as
flagd JSON, from `/sdk/v1/flagd/company/acme`, with the `api` service's key. It asks again every 30 seconds with the
last ETag, and usually gets a `304`. Your backends then evaluate in memory, with no request to CompanyFlags each time.

## Run it

1. Free port 8787. If the quickstart's CompanyFlags still runs, stop it: `docker rm -f companyflags` (from
   `docker run`), or `docker compose down` in its folder. Stop `pnpm dev` or `pnpm serve` too.

2. Start CompanyFlags, from the repo's root:

   ```bash
   cd examples/flagd
   echo "FF_SECRET=$(openssl rand -base64 32)" > .env
   docker compose up -d companyflags
   docker compose logs companyflags     # the setup link
   ```

3. Open the setup link and make the admin account. Make the environment `dev`, the dimension `company` and the
   services `web` and `api`, then an access token with the role **Editor**: steps 3 and 4 of
   [the examples' README](../README.md#set-up-a-server-for-them).

4. Run the seed. It is in `examples/`, so go back to the repo's root first:

   ```bash
   cd ../..
   FLAGS_URL=http://localhost:8787 FLAGS_TOKEN=cfp_… node examples/seed.ts
   cd examples/flagd
   ```

   It adds Acme, Globex and the flags. Then make the `api` service's key for `dev` in the console:
   **API Keys → + New key**.

5. Add the `api` service's key to `.env`, beside the secret, and start flagd:

   ```bash
   echo "FLAGS_API_KEY=ff_dev_api_…" >> .env
   docker compose up -d flagd
   ```

6. Ask flagd. It speaks OFREP too, on port 8016:

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
[Local evaluation in backends](https://dvir-daniel.github.io/companyflags/reading/local-backends) first. `docker compose down -v` removes it all.
