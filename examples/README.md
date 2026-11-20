# Examples

Small apps that read CompanyFlags with OpenFeature's own SDKs and providers. There is no SDK of ours to install.

| Example | What it shows |
|---|---|
| [react](react) | A Vite + React page: OpenFeature's React SDK with the OFREP web provider and the `web` service's key |
| [node](node) | A Node HTTP server: OpenFeature's server SDK with the OFREP provider and the `api` service's key |
| [flagd](flagd) | Docker Compose: CompanyFlags, and flagd syncing Acme's flags as flagd JSON |

## Set up a server for them

1. **Run CompanyFlags.** From this repo: `pnpm install`, then `pnpm serve` (it serves the console and the API on
   http://localhost:8787). Or with Docker:

   ```bash
   docker run -d --name companyflags -p 8787:8787 -v companyflags:/data \
     -e BETTER_AUTH_SECRET="$(openssl rand -base64 32)" -e BETTER_AUTH_URL=http://localhost:8787 \
     ghcr.io/dvir-daniel/companyflags
   ```

2. **Make the admin account** with the setup link the server prints (`docker logs companyflags`):
   `http://localhost:8787/api/setup/<secret>`.

3. **Make an access token:** your name at the foot of the sidebar → **Access tokens** → **+ New token**, with the
   role **Admin**.

4. **Run the seed:**

   ```bash
   FLAGS_URL=http://localhost:8787 FLAGS_TOKEN=cfp_… node examples/seed.ts
   ```

   It makes the environment `dev`, the dimension `company` with `acme` and `globex`, the services `web` (an app) and
   `api` (a backend), three flags, and a key for each service. It prints the keys, and where each one goes. Each
   key is shown once.

### Or by hand, in the console

1. **Settings → Environments:** add Development, key `dev`.
2. **Settings → Dimensions:** add `company`. Then add the companies `acme` (Acme Corp) and `globex` (Globex).
3. **Settings → Services:** add `web`, kind **App**, and `api`, kind **Backend**.
4. **Flags → + New flag:**
   - `new_checkout`: **On / off**, default `on`, in `web` and `api`.
   - `welcome_message`: **Text**, in `web`. A rule for Acme can say "Welcome back, Acme Corp."
   - `max_upload_mb`: **Number**, 100, in `api`. A rule for Acme can give 1000.
5. **API keys → + New key:** one for `dev` and `web`, one for `dev` and `api`. Copy each: it is shown once.

Then follow each example's README.
