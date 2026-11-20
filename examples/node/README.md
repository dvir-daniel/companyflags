# Node example

A small Node HTTP server (`node:http`) that reads its flags with OpenFeature's server SDK and OFREP provider, with
the `api` service's key.

`GET /upload-limit?company=acme` evaluates `max_upload_mb` for that company and answers JSON:

```json
{ "company": "acme", "maxUploadMb": 1000, "reason": "TARGETING_MATCH", "variant": "large" }
```

The company goes in the evaluation context by its dimension (`{ company: 'acme' }`), as the flag's rules name it.
Without `?company=` it gets everyone's value. A company the server doesn't know answers the code's default, with
`"error": "INVALID_CONTEXT"`.

## Run it

1. Set up a server and get the `api` service's key: see [the examples' README](../README.md).
2. Copy `.env.example` to `.env` and fill it in:

   ```bash
   FLAGS_URL=http://localhost:8787
   FLAGS_API_KEY=ff_dev_api_…
   PORT=3000
   ```

   A backend's key is secret: keep it on the server.

3. From the repo's root: `pnpm install`, then

   ```bash
   pnpm --filter @companyflags/example-node dev
   curl 'http://localhost:3000/upload-limit?company=acme'
   curl 'http://localhost:3000/upload-limit?company=globex'
   ```

Node 22.18 or later runs the TypeScript as is. `pnpm --filter @companyflags/example-node build` checks the types (and
the seed script's).

Each evaluation is one request to CompanyFlags. For many per second, use flagd: see [the flagd example](../flagd).
