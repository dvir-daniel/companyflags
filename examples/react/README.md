# React example

A Vite + React page that reads its flags with OpenFeature's React SDK and the OFREP web provider.

- `new_checkout` (on/off) shows the new checkout banner.
- `welcome_message` (text) is the heading. Acme gets its own.
- The context ([src/flags.ts](src/flags.ts)) says what the browser knows: `targetingKey` (a device ID kept in
  `localStorage`), `app.version`, and the signed-in company, `acme`.

The provider asks for every flag in one request, then listens to the server's change stream. Change a flag in the
console and the page updates within a second or two. It keeps the last answers in `localStorage` and shows them
first on the next visit; its cache key includes the company, so another company's values never show first.

## Run it

1. Set up a server and get the `web` service's key: see [the examples' README](../README.md).
2. Copy `.env.example` to `.env.local` and fill it in:

   ```bash
   VITE_FLAGS_URL=http://localhost:8787
   VITE_FLAGS_KEY=ff_dev_web_…
   ```

   The `web` key is public: it goes in the page. Never put a backend's key here.

3. From the repo's root: `pnpm install`, then

   ```bash
   pnpm --filter @companyflags/example-react dev
   ```

   Open http://localhost:5173. `pnpm --filter @companyflags/example-react build` checks the types and builds it.

If you run `pnpm dev` for CompanyFlags itself, its console is on :5173 too: Vite then picks the next port.
