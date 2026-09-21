# syntax=docker/dockerfile:1
# =============================================================================
# Agent Evidence API — backend production image (SPEC section 31)
#
# This image runs ONLY the Fastify backend (apps/backend) plus its SQLite cache.
# The Cloudflare Worker (apps/worker) is a separate deployable and is not part
# of this image.
#
#   Internet -> Cloudflare Worker (x402 gate) -> protected origin -> THIS IMAGE
#
# Build from the repository root (the build context must be the repo root):
#   docker build -f docker/Dockerfile -t agent-evidence-api-backend:0.1.0 .
#
# Run (docker/docker-compose.yml is the supported path):
#   docker run --rm --init -p 127.0.0.1:8080:8080 --env-file docker/.env \
#     -v aee-cache:/app/data agent-evidence-api-backend:0.1.0
#
# No secret is baked into this image. Every credential is read from the
# environment at runtime (SPEC section 31; AGENTS.md section 6).
#
# CONTEXT SIZE: the build context is the repository root, and this repository
# does not ship a .dockerignore. That is safe (every COPY below names an exact
# path, so no host node_modules can leak in) but slow, because Docker still
# transfers the whole tree. Add a repository-root .dockerignore containing
# `node_modules`, `dist`, `data`, `.env`, `.dev.vars`, `.pnpm-store` to speed
# builds up.
# =============================================================================

# `node:sqlite` is bundled into Node itself, so there is no native module to
# compile or ship. Node 24 is the recommended runtime (stable `node:sqlite`,
# matching the project's engines field). Debian slim is used rather than Alpine
# to keep glibc semantics identical to the VPS.
ARG NODE_VERSION=24

# -----------------------------------------------------------------------------
# Stage 1 — build: install the workspace, compile TypeScript, prune to prod
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS build

# Any pnpm that can read pnpm-lock.yaml (lockfileVersion 9.0) works; 12 matches
# the version the lockfile was written with.
ARG PNPM_VERSION=12

ENV CI=true \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

RUN npm install --global "pnpm@${PNPM_VERSION}" \
 && pnpm --version

WORKDIR /repo

# Manifests first, so the dependency layer is only invalidated by a real
# dependency change. Every workspace manifest must be present: the lockfile
# records all importers and `--frozen-lockfile` fails if one is missing.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/cache/package.json packages/cache/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/extraction/package.json packages/extraction/package.json
COPY packages/fetcher/package.json packages/fetcher/package.json
COPY packages/mcp/package.json packages/mcp/package.json
COPY packages/schemas/package.json packages/schemas/package.json

# Install only the backend and what it depends on plus the workspace root (for
# the shared toolchain), so the Worker's wrangler/workerd dev dependencies are
# never downloaded into this image's build stage.
#
# Deliberately no BuildKit cache mount for the pnpm store: `pnpm deploy` below
# copies packages out of the store, so the store must live in this stage's
# filesystem rather than in a mount that only exists for one RUN instruction.
RUN pnpm install --frozen-lockfile \
      --filter agent-evidence-api \
      --filter "@aee/backend..."

# Source files only — never `COPY packages/`, which would drag a developer's
# host node_modules (with symlinks relative to their machine) into the build.
# If a package ever gains a non-TypeScript runtime asset, add it here.
COPY tsconfig.base.json tsconfig.json ./
COPY apps/backend/tsconfig.json apps/backend/tsconfig.json
COPY apps/backend/src apps/backend/src
# The bundled buyer CLI served at /buy.mjs (see scripts/build-buyer.sh).
COPY apps/backend/public apps/backend/public
COPY packages/schemas/tsconfig.json packages/schemas/tsconfig.json
COPY packages/schemas/src packages/schemas/src
COPY packages/cache/tsconfig.json packages/cache/tsconfig.json
COPY packages/cache/src packages/cache/src
COPY packages/core/tsconfig.json packages/core/tsconfig.json
COPY packages/core/src packages/core/src
COPY packages/extraction/tsconfig.json packages/extraction/tsconfig.json
COPY packages/extraction/src packages/extraction/src
COPY packages/fetcher/tsconfig.json packages/fetcher/tsconfig.json
COPY packages/fetcher/src packages/fetcher/src
COPY packages/mcp/tsconfig.json packages/mcp/tsconfig.json
COPY packages/mcp/src packages/mcp/src

# Build the backend and everything it depends on (the trailing `...` selects
# dependencies too): @aee/schemas, @aee/cache, @aee/core, @aee/extraction,
# @aee/fetcher.
RUN pnpm --filter "@aee/backend..." build

# Produce a self-contained production-only tree: real files and directories (no
# symlinks escaping the target) with devDependencies excluded. `--no-optional`
# drops optional dependencies; nothing in this tree needs one.
RUN pnpm --filter "@aee/backend" deploy --prod --no-optional /prod/backend

# -----------------------------------------------------------------------------
# Stage 2 — runtime: minimal, non-root, read-only-rootfs friendly
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS runtime

# tini becomes PID 1: it forwards SIGTERM/SIGINT to node (so `docker stop` is a
# clean shutdown) and reaps zombies. ca-certificates gives the container a
# system trust store in addition to the root CAs Node bundles for HTTPS fetches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV SERVICE_NAME=agent-evidence-api
ENV SERVICE_VERSION=0.1.0
# The container must listen on 0.0.0.0: a published port reaches the container's
# IP, not its loopback. What is actually exposed is controlled by the compose
# port binding (127.0.0.1) and the Worker — never by this variable.
ENV BACKEND_HOST=0.0.0.0
ENV BACKEND_PORT=8080
# The SQLite cache lives on the mounted volume so it survives image upgrades.
ENV CACHE_DB_PATH=/app/data/cache.sqlite
ENV NODE_OPTIONS=--enable-source-maps

WORKDIR /app

# Unprivileged runtime account with a fixed UID/GID, so a bind-mounted data
# directory can be chowned predictably on the host.
RUN groupadd --system --gid 10001 aee \
 && useradd --system --uid 10001 --gid aee --no-create-home \
      --home-dir /nonexistent --shell /usr/sbin/nologin aee \
 && mkdir -p /app/data \
 && chown -R aee:aee /app

# Copy only what the runtime needs out of the pruned tree: the compiled dist
# output, production node_modules (Fastify and the @aee workspace packages as
# real directories), and the package.json that marks the tree as ESM. The
# TypeScript sources and pnpm bookkeeping that `pnpm deploy` also emits stay in
# the build stage.
COPY --from=build --chown=aee:aee /prod/backend/package.json ./package.json
COPY --from=build --chown=aee:aee /prod/backend/dist ./dist
COPY --from=build --chown=aee:aee /prod/backend/node_modules ./node_modules
# The zero-install buyer CLI served at /buy.mjs. It is read from
# ../public relative to dist/server.js, so it must sit alongside them.
COPY --from=build --chown=aee:aee /repo/apps/backend/public ./public

USER aee

# The SQLite cache is the only state worth persisting. Compose mounts a named
# volume here.
VOLUME ["/app/data"]

EXPOSE 8080

# Liveness probe against the free health endpoint (SPEC section 4A). `node -e`
# is used so the image needs no curl/wget. Kept identical to the compose health
# check so `docker run` and compose report the same thing.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.BACKEND_PORT||'8080')+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
