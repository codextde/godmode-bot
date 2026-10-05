# syntax=docker/dockerfile:1.7
#
# Godmode Cloud (apps/cloud): accounts, billing, the admin dashboard and the relay, plus the Godmode dashboard build
# it serves to browsers. The build context is the repository root:
#
#   docker build -f apps/cloud/Dockerfile -t godmode-cloud .
#   cd apps/cloud && docker compose up -d --build        # the whole stack with PostgreSQL (see README.md there)
#
# The image keeps the workspace layout: /repo/node_modules/.pnpm (production dependencies only) and /repo/apps/cloud.
# `next build` reaches external server packages such as pg through relative links
# (`.next/node_modules/pg-<hash> -> ../../../../node_modules/.pnpm/pg@<version>/node_modules/pg`), which resolve only in
# that layout. The runtime stage checks every one of them and fails the build if one dangles.
#
# Nothing secret goes into the image: the database password and the app secret are generated at runtime (compose
# service `init`). Coolify passes all its variables as build args, so never read a secret through ARG here.

ARG NODE_VERSION=24

# ---------------------------------------------------------------------------------------------------------------
# pnpm (the version from package.json "packageManager", through corepack)
# ---------------------------------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=1 \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo
COPY package.json ./
RUN corepack enable && corepack install

# ---------------------------------------------------------------------------------------------------------------
# Build: the dashboard (Vite, served under /ui) and the cloud (next build + the custom server bundle)
# ---------------------------------------------------------------------------------------------------------------
FROM base AS build
COPY . .
# Only the dependencies of these two builds (none of the core's or the website's). The pnpm store is a cache mount,
# so a rebuild downloads nothing it already has.
RUN --mount=type=cache,id=godmode-pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --store-dir /pnpm/store \
      --filter "@godmode/cloud..." --filter "@godmode/desktop..."
# The cloud shows which Godmode version its dashboard build belongs to.
RUN pnpm --filter @godmode/desktop build:cloud \
    && node -p 'JSON.stringify({ version: require("./apps/desktop/package.json").version })' \
       > apps/desktop/dist-cloud/version.json
RUN pnpm --filter @godmode/cloud build \
    && rm -rf apps/cloud/.next/cache apps/cloud/.next/dev

# ---------------------------------------------------------------------------------------------------------------
# Production dependencies of the cloud, installed from the same lockfile, so the .pnpm folder names match the ones
# the build linked to
# ---------------------------------------------------------------------------------------------------------------
FROM base AS prod-deps
COPY . .
RUN --mount=type=cache,id=godmode-pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --prod --frozen-lockfile --store-dir /pnpm/store --filter "@godmode/cloud..."

# ---------------------------------------------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS runtime
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    CLOUD_APP_DIR=/repo/apps/cloud \
    GODMODE_UI_DIR=/repo/apps/cloud/godmode-ui
WORKDIR /repo/apps/cloud

COPY --from=prod-deps /repo/node_modules /repo/node_modules
COPY --from=prod-deps /repo/apps/cloud/node_modules ./node_modules
COPY --from=build /repo/apps/cloud/package.json /repo/apps/cloud/next.config.mjs ./
COPY --from=build /repo/apps/cloud/dist ./dist
COPY --from=build /repo/apps/cloud/drizzle ./drizzle
COPY --from=build /repo/apps/cloud/public ./public
COPY --from=build /repo/apps/desktop/dist-cloud ./godmode-ui
# Next writes its runtime cache (.next/cache) here, so the app user owns this folder.
COPY --from=build --chown=node:node /repo/apps/cloud/.next ./.next

# Prove that every external package link of the server build resolves in this layout (a dangling one turns every page
# that reads the database into a 500 while /api/health still answers).
RUN set -eu; \
    found=0; \
    for link in .next/node_modules/* .next/node_modules/@*/*; do \
      [ -L "$link" ] || continue; \
      found=$((found + 1)); \
      if [ ! -e "$link" ]; then echo "Unresolved package link: $link -> $(readlink "$link")" >&2; exit 1; fi; \
    done; \
    echo "Server package links resolved: $found"; \
    mkdir -p /data; \
    chown node:node /data

USER node
# The setup code (setup-code.txt) and, without APP_SECRET(_FILE), a generated app secret.
VOLUME ["/data"]
EXPOSE 3000

# The custom server answers /api/health itself (no database), also while Next is still starting.
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# tini forwards SIGTERM so the server can close links and flush usage before it exits.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.mjs"]
