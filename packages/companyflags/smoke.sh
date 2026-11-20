#!/usr/bin/env bash
# Tries the npm package the way a user would (pnpm pack:npm first): packs it, installs the tarball in an empty
# folder, and runs npx companyflags there: help, secret, migrate on embedded Postgres, a companyflags.config.ts that
# imports companyflags/config and /plugins, then start, /readyz and the console's page.
#   bash packages/companyflags/smoke.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
pid=""
cleanup() { if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi; rm -rf "$work"; }
trap cleanup EXIT

(cd "$here" && npm pack --silent --pack-destination "$work" >/dev/null)
tarball="$(ls "$work"/companyflags-*.tgz)"
mkdir "$work/app"
cd "$work/app"
npm init -y >/dev/null
npm pkg set type=module
npm i --silent --no-audit --no-fund "$tarball"

export FF_DATA_DIR="$work/db"
npx companyflags help | grep -q 'companyflags flags push'
[[ "$(npx companyflags secret | wc -c)" -ge 40 ]]
if npx companyflags migrate --check; then echo 'migrate --check: a new database should have pending migrations' >&2; exit 1; fi
npx companyflags migrate
npx companyflags migrate --check

cat > companyflags.config.ts <<'EOF'
import { defineConfig, type Config } from 'companyflags/config';
import { flagd, ofrep } from 'companyflags/plugins';

const config: Config = defineConfig({ plugins: [ofrep(), flagd()] });
export default config;
EOF

port="$(node -e "const s = require('node:net').createServer().listen(0, '127.0.0.1', () => { console.log(s.address().port); s.close(); })")"
PORT="$port" HOST=127.0.0.1 npx companyflags start > "$work/start.log" 2>&1 &
pid=$!
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$port/readyz" >/dev/null; then break; fi
  sleep 0.5
done
curl -sf "http://127.0.0.1:$port/readyz"; echo
grep -q 'plugins: ofrep, flagd' "$work/start.log" || { cat "$work/start.log" >&2; echo 'the config file was not loaded' >&2; exit 1; }
curl -sf "http://127.0.0.1:$port/" | grep -q '<title>CompanyFlags</title>' || { echo 'no console page' >&2; exit 1; }
echo "ok: the package installs and runs ($(basename "$tarball"))"
