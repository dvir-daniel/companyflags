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
   echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)" > .env   # keep it: it signs sign-in sessions
   docker run -d --name companyflags -p 8787:8787 -v companyflags:/data --env-file .env \
     -e BETTER_AUTH_URL=http://localhost:8787 ghcr.io/dvir-daniel/companyflags:0.9
   ```

2. **Make the admin account** with the setup link the server prints (`docker logs companyflags`):
   `http://localhost:8787/api/setup/<secret>`.

3. **Make the settings, in the console.** A token can't change settings, so you make these signed in, as the admin:
   - **Settings → Environments:** add Development, key `dev`.
   - **Settings → Dimensions:** add `company`.
   - **Services:** add `web`, kind **App**, and `api`, kind **Backend**.

4. **Make an access token:** your name at the foot of the sidebar → **Account** → **+ New token**, with the role
   **Editor**. Copy it: it is shown once.

5. **Run the seed:**

   ```bash
   FLAGS_URL=http://localhost:8787 FLAGS_TOKEN=cfp_… node examples/seed.ts
   ```

   It checks step 3 is done, and says what is missing if not. Then it adds the companies `acme` (Acme Corp) and
   `globex` (Globex), and three flags. Run it again and it changes nothing.

6. **Make the API keys, in the console:** **API Keys → + New key**, one for `dev` and `web`, one for `dev` and `api`.
   The seed's last lines say where each one goes. Copy each: it is shown once.

### Or the flags by hand too

Do steps 1 to 3, then instead of the seed:

1. **Companies** (under Audience): add `acme` (Acme Corp) and `globex` (Globex).
2. **Flags → + New flag:**
   - `new_checkout`: **On / off**, default `on`, in `web` and `api`.
   - `welcome_message`: **Text**, in `web`. A rule for Acme can say "Welcome back, Acme Corp."
   - `max_upload_mb`: **Number**, 100, in `api`. A rule for Acme can give 1000.

Then make the API keys (step 6).

Then follow each example's README.
