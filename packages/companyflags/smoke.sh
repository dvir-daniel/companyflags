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
version="$(node -p "require('$here/package.json').version")"
[[ "$(npx companyflags --version)" == "companyflags $version" ]] || { echo 'companyflags --version' >&2; exit 1; }
# hono comes as a peer: a plugin's own import of it is the server's copy
[[ -f "$work/app/node_modules/hono/package.json" && ! -e "$work/app/node_modules/companyflags/node_modules/hono" ]] || { echo 'hono is not installed beside the package, once' >&2; exit 1; }
[[ "$(npx companyflags secret | wc -c)" -ge 40 ]]
if npx companyflags migrate --check; then echo 'migrate --check: a new database should have pending migrations' >&2; exit 1; fi
npx companyflags migrate
npx companyflags migrate --check
npx companyflags backup "$work/backup" | grep -q 'backed up the embedded database'
[[ -f "$work/backup/PG_VERSION" ]] || { echo 'no backup folder' >&2; exit 1; }

cat > companyflags.config.ts <<'EOF'
import { defineConfig, type Config } from 'companyflags/config';
import { cdnFiles, flagd, ofrep } from 'companyflags/plugins';

const config: Config = defineConfig({ plugins: [ofrep(), flagd(), cdnFiles()] });
export default config;
EOF

port="$(node -e "const s = require('node:net').createServer().listen(0, '127.0.0.1', () => { console.log(s.address().port); s.close(); })")"
PORT="$port" HOST=127.0.0.1 FF_METRICS=on npx companyflags start > "$work/start.log" 2>&1 &
pid=$!
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$port/readyz" >/dev/null; then break; fi
  sleep 0.5
done
curl -sf "http://127.0.0.1:$port/readyz"; echo
curl -sf "http://127.0.0.1:$port/healthz" | grep -q "\"version\":\"$version\"" || { echo 'no version in /healthz' >&2; exit 1; }
grep -q 'integrations: OFREP, flagd, CDN files$' "$work/start.log" || { cat "$work/start.log" >&2; echo 'the config file was not loaded' >&2; exit 1; }
# the file lists plugins, so FF_METRICS turns nothing on, and the start says so
grep -q 'FF_METRICS is ignored' "$work/start.log" || { cat "$work/start.log" >&2; echo 'no word that FF_METRICS is ignored' >&2; exit 1; }
# the CDN files' address is the plugin's (no environment yet: its own 404), not an unknown endpoint
curl -s "http://127.0.0.1:$port/cdn/v1/flags/dev/web" | grep -q 'environment \\"dev\\" not found' || { echo 'no CDN files at /cdn/v1/flags' >&2; exit 1; }
curl -sf "http://127.0.0.1:$port/" | grep -q '<title>CompanyFlags</title>' || { echo 'no console page' >&2; exit 1; }
echo "ok: the package installs and runs ($(basename "$tarball"))"
