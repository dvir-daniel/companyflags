# Notes for coding agents

Read [CONTRIBUTING.md](CONTRIBUTING.md) first: it has the layout, the commands and the conventions. The short version:

- **Commands.** `pnpm install`, `pnpm dev` (console :5173, API :8787), `pnpm serve` (the built console and the API on
  :8787), `pnpm check` (types, lint, every test), `pnpm test:pg` (on a real Postgres), `pnpm docs:dev`.
- **Node runs the TypeScript directly** (type stripping): no build step for the server. Use only erasable syntax (no
  enums, no parameter properties, no namespaces) and `.ts` extensions in imports.
- **One evaluator.** `server/evaluator.ts` decides every answer; OFREP (`server/ofrep.ts`), flagd JSON
  (`server/flagd.ts`, for backends and, as CDN files, for apps) and the console's trace all come from it. A change to how
  answers are decided needs a test comparing them.
- **No SDK of our own.** Apps and backends use OpenFeature's providers (OFREP, flagd). Don't add a client library or
  custom headers; fit the feature into those protocols.
- **Core and plugins.** A new way to read flags, or something to do after a publish, is a plugin (`server/plugin.ts`,
  `server/plugins/`), listed in `companyflags.config.ts` (its type is `server/config.ts`, read by `server/configFile.ts`).
  The CLI is `server/cli.ts`.
- **The schema only moves forward.** Add the next file in `server/migrations/`; never edit one (the server checks their
  checksums).
- **No fixed business words.** Installations name their own dimensions; nothing users read may say "customer",
  "company", "brand" or "tenant" on its own (`test/no-domain-words.test.ts`). The generic word in code is "entity".
- **Console files.** A `.tsx` file exports only components (React Fast Refresh); hooks and helpers go in a `.ts` file
  beside it. The look comes from `packages/ui` ([DESIGN.md](packages/ui/DESIGN.md)).
- **Words.** Short, plain sentences in the console and the docs. Fictional example data only (Acme Corp, Globex and its
  brands Lumen and Bolt).
