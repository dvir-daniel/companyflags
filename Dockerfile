# syntax=docker/dockerfile:1
# CompanyFeatures: the server, the console and the app files in one image.
#   docker build -t companyfeatures .
#   docker run -p 8787:8787 -e BETTER_AUTH_SECRET=… -e BETTER_AUTH_URL=http://localhost:8787 -v companyfeatures:/data companyfeatures

ARG NODE_VERSION=24

# ---- build: the console (web/dist) ----------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/ui/package.json packages/ui/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# ---- production dependencies of the server only ---------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/ui/package.json packages/ui/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile --prod --filter companyfeatures

# ---- runtime --------------------------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine
WORKDIR /app
# Without DATABASE_URL the data is in embedded Postgres under /data (the volume); its lock file sits beside /data/db.
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    FF_DATA_DIR=/data/db
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY --from=build /app/web/dist ./web/dist
# the companyfeatures command (server/cli.ts): docker compose exec companyfeatures companyfeatures migrate --check.
# A config file goes at /app/companyfeatures.config.ts (or set FF_CONFIG); without one, the environment decides.
RUN ln -s /app/server/cli.ts /usr/local/bin/companyfeatures && chmod +x /app/server/cli.ts \
  && mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz >/dev/null || exit 1
CMD ["node", "server/index.ts"]
