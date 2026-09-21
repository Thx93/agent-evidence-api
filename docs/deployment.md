# Deployment

The system has two deployable pieces plus a datastore:

```text
Cloudflare Worker   (public edge, Free plan)   — apps/worker
        │
        ▼
protected origin    (Cloudflare Tunnel, or authenticated origin + firewall)
        │
        ▼
Docker container    (Dockerfile, docker-compose.yml)
        │
        ▼
Node.js backend     (Fastify, apps/backend)
        │
        ▼
SQLite              (persistent volume: /app/data)
```

No Kubernetes, no Terraform, no Redis, no PostgreSQL, no full observability
stack. SPEC §31 and §36 forbid all of them.

> **Status.** The deployment artifacts exist: `docker/Dockerfile`,
> `docker/docker-compose.yml`, `docker/env.production.example`,
> `docker/env.development.example`, `apps/worker/.dev.vars.example`, and a root
> `.dockerignore`. All packages and both apps are implemented, and
> `pnpm typecheck` passes across the workspace, so `docker build` is expected to
> succeed.
>
> **Nothing has been deployed from this repository**, and this document has not
> been exercised end to end. Two configuration defects must be fixed before a real
> deployment:
>
> - `apps/worker/wrangler.jsonc` contains literal test-recipient addresses in
>   `env.dev` and `env.test`.
> - `server.json` points at a placeholder remote URL; the GitHub namespace is
>   confirmed (`io.github.Thx93/`). The repository it references does not exist
>   namespace.
>
> `scripts/smoke.sh` runs a live socket test against the built backend (health,
> origin-auth refusal, a real evidence request, cache reuse, and SQLite file
> creation). It has not been run in this session.

---

## 1. Domain placeholders

Never invent a real domain. Use the placeholders SPEC §33 defines and substitute
your own values only in your local, uncommitted environment:

| Placeholder | Used by | Meaning |
|---|---|---|
| `PUBLIC_API_DOMAIN` | Worker route, client config | The public hostname serving `/v1/evidence`, `/health`, `/`, `/mcp`. |
| `BACKEND_ORIGIN_URL` | Worker variable | The origin the Worker forwards to (tunnel hostname or origin URL). |
| `MCP_PUBLIC_URL` | MCP client config, registry metadata | The full public MCP endpoint, e.g. `https://${PUBLIC_API_DOMAIN}/mcp`. |

`*.example.invalid` is the reserved placeholder form used throughout these docs
and `.env.example`. RFC 2606 reserves `.invalid`, which is deliberate: a missed
substitution fails loudly instead of pointing at a real third-party host.

---

## 2. Local development

### Prerequisites

- Node.js **≥ 22.6** (declared in `package.json` `engines`). Required because the
  cache uses the built-in `node:sqlite` module instead of a native dependency.
- `pnpm`.
- Optional: Docker, for testing the container build.
- Optional: `wrangler` for the edge, installed as a workspace devDependency of
  `apps/worker`.

### Steps

```bash
# 1. Install workspace dependencies
pnpm install

# 2. Create your local environment file from the template
cp .env.example .env      # placeholders only; fill in locally, never commit

# 3. Generate the server-to-server secret
openssl rand -hex 32      # put the result in BACKEND_AUTH_SECRET

# 4. Typecheck and test
pnpm typecheck
pnpm test
```

### Root scripts

From `package.json`:

| Script | Purpose |
|---|---|
| `pnpm install` | Install workspace dependencies. |
| `pnpm build` | `pnpm -r build` across the workspace. |
| `pnpm typecheck` | `tsc --noEmit` against the root config, which maps `@aee/*` to sources. |
| `pnpm test` | `node scripts/run-tests.mjs` — all `*.test.ts` files. |
| `pnpm test:unit` | Filtered to `unit`. |
| `pnpm test:security` | Filtered to `security`. |
| `pnpm test:integration` | Filtered to `integration`. |
| `pnpm test:e2e` | Filtered to `e2e`. |
| `pnpm fixtures` | Start the deterministic fixture server. |
| `pnpm dev:backend` | `pnpm --filter @aee/backend dev` → `tsx watch src/server.ts` on port 8080. |
| `pnpm dev:worker` | `pnpm --filter @aee/worker dev` → `wrangler dev`. |
| `pnpm validate` | `pnpm typecheck && pnpm test`. |

### Fixture server

`tests/fixtures/server.ts` is a deterministic local HTTP server for tests and
manual poking — no dependency on live websites (SPEC §27).

```bash
pnpm fixtures
# or, on a fixed port:
FIXTURE_PORT=9090 node --import tsx tests/fixtures/server.ts
```

Routes:

| Category | Routes |
|---|---|
| Content | `/company`, `/negating`, `/irrelevant`, `/malformed`, `/plain`, `/json`, `/binary`, `/empty` |
| Redirects | `/redirect-once`, `/redirect-chain`, `/redirect-loop`, `/redirect-to-private`, `/redirect-to-metadata` |
| Limits | `/slow` (never responds), `/huge` (streams 8 MiB) |
| Status | `/404`, `/500` |

### Running the edge locally

```bash
# Payment bypassed, Base Sepolia, backend expected on 127.0.0.1:8080
pnpm --filter @aee/worker dev -- --env dev

# Testnet payments REQUIRED (no bypass) — this is the environment the x402 tests target
pnpm --filter @aee/worker dev -- --env test
```

`wrangler dev --env dev` activates `DEV_BYPASS_PAYMENT=true`, which is doubly
guarded: it requires a non-mainnet `X402_NETWORK` as well. See
[`x402.md` §6](./x402.md#6-the-development-payment-bypass).

### Local sandbox note

AGENTS.md §9 records that this development environment permits writes only under
`/root/dsh-workspace`, and that the project is exposed at the SPEC-required path
`/srv/agent-evidence-api` by a symlink. Tooling is expected on `PATH` via:

```bash
export PATH="/root/dsh-workspace/bin:$PATH"   # node, npm, pnpm, wrangler, cloudflared
```

This is a constraint of the development sandbox, not of the product. On a normal
VPS, install Node.js ≥ 22.6 and pnpm directly.

### What works locally today

`pnpm typecheck` passes across the whole workspace. `pnpm dev:backend` starts the
Fastify backend on `:8080`, and `pnpm dev:worker` starts the Worker on `:8787`.
`pnpm fixtures` brings up the deterministic fixture server.

Two things to know when driving the full path locally:

- The backend refuses to start without a `BACKEND_AUTH_SECRET` of at least 16
  characters, so set one first.
- A local request through the Worker needs either a settled x402 payment or
  `DEV_BYPASS_PAYMENT=true` with a non-mainnet `X402_NETWORK` (which is what
  `wrangler dev --env dev` configures).
- `scripts/smoke.sh` starts the fixture server and the built backend and checks
  health, origin-auth refusal, a real evidence request, cache reuse, and SQLite
  creation. It sets `ALLOW_LOOPBACK_FOR_TESTS=true` and `NODE_ENV=test`, which is
  how the SSRF-hardened fetcher is permitted to reach a loopback fixture server.

---

## 3. Docker deployment on the VPS

SPEC §31 requires a `Dockerfile`, a `docker-compose.yml`, a production env
template, a development env template, a health check, a restart policy, and a
persistent volume for SQLite. All of these exist under `docker/`.

| File | Purpose |
|---|---|
| [`docker/Dockerfile`](../docker/Dockerfile) | Multi-stage build → a minimal, non-root runtime image. |
| [`docker/docker-compose.yml`](../docker/docker-compose.yml) | The single-service deployment: one backend container plus the cache volume. |
| [`docker/env.production.example`](../docker/env.production.example) | Production template — **Base mainnet** (`eip155:8453`). |
| [`docker/env.development.example`](../docker/env.development.example) | Development template — **Base Sepolia** (`eip155:84532`). |

### The image

`docker/Dockerfile` is a two-stage build. What it actually does:

- **Stage 1 (`build`)** uses `node:24-slim` (overridable via the `NODE_VERSION`
  build arg), installs pnpm 12, and copies only the workspace **manifests** first
  so the dependency layer is invalidated only by a real dependency change. It then
  installs with `--frozen-lockfile --filter agent-evidence-api --filter
  "@aee/backend..."`, so the Worker's `wrangler`/`workerd` dev dependencies are
  never downloaded into this image. Sources are copied with **exact paths** (never
  `COPY packages/`, which would drag a developer's host `node_modules` in), then
  `pnpm --filter "@aee/backend..." build` compiles the backend and its
  dependencies, and `pnpm --filter "@aee/backend" deploy --prod --no-optional
  /prod/backend` produces a self-contained production tree with real directories
  instead of symlinks.
- **Stage 2 (`runtime`)** installs `tini` and `ca-certificates`, creates an
  unprivileged `aee` user with fixed UID/GID 10001 (so a bind-mounted data
  directory can be chowned predictably), copies only the pruned production tree,
  and sets `ENTRYPOINT ["/usr/bin/tini", "--"]` with
  `CMD ["node", "dist/server.js"]`. `tini` as PID 1 forwards `SIGTERM`/`SIGINT`
  and reaps zombies, which is what makes `docker stop` a clean shutdown for the
  backend's own signal handlers.

Key environment decisions baked into the image:

- `BACKEND_HOST=0.0.0.0` — **because a published port reaches the container's
  IP, not its loopback.** This does not make the origin public; what is exposed is
  controlled by the compose port binding and the Worker. For a bare-metal run,
  set it back to `127.0.0.1`.
- `CACHE_DB_PATH=/app/data/cache.sqlite` — the cache lives on the mounted volume
  so it survives image upgrades.
- `NODE_ENV=production`, so `node:sqlite` needs no build toolchain: it is built
  into Node, and the runtime image contains no compiler.

The image contains **no secret**. Every credential is read from the environment
at runtime.

`pnpm typecheck` passes across the workspace, so the build step has no known
compile-time blocker. The build has not been executed here.

### The compose file

`docker/docker-compose.yml` defines exactly **one** service (plus one named
volume). There is no Redis, no PostgreSQL, and no observability stack.

Design decisions worth understanding, because each one is a deliberate choice:

- **`restart: unless-stopped`** — survives host reboot and crash loops, but
  respects a deliberate `docker compose stop`. That is the right policy for a
  cache-backed service: there is no state to lose and no leader election.
- **The port is published on host loopback only**:
  `127.0.0.1:${BACKEND_PORT:-8080}:8080`, with an in-file warning not to change it
  to `8080:8080`. A client that could reach the origin directly could skip the
  Worker's x402 gate entirely, so this binding is a security control, not a
  convenience. Remove the `ports` entry entirely if a tunnel runs as a sidecar on
  the same Docker network.
- **`BACKEND_AUTH_SECRET` and `X402_RECIPIENT` are declared with
  `${VAR:?message}`**, so Compose **fails fast** at `up` when either is missing,
  instead of starting a container that crashes or, worse, runs insecurely.
- **`X402_NETWORK` defaults to `eip155:8453`** in this file, because it is the
  production template. Mainnet is the default here on purpose: this file is what
  a production operator runs, and testnet values belong in
  `docker/env.development.example`.
- **Credentials come from `env_file: .env`**, not from `environment:` literals,
  so no secret is committed in the compose file. Copy
  `docker/env.production.example` to `docker/.env` first.
- **The cache volume is `aee-cache` mounted at `/app/data`** — a directory, not a
  file. SQLite in WAL mode writes `cache.sqlite`, `cache.sqlite-wal`, and
  `cache.sqlite-shm` side by side; mounting a single file path would leave the
  sidecars outside the volume. A named volume is used rather than a bind mount so
  Docker initialises it with the image's `aee` ownership and the unprivileged user
  can write without a host-side `chown`.
- **`read_only: true`** with a 64 MB `tmpfs` at `/tmp`
  (`noexec,nosuid,nodev`). This works precisely because the only writable state is
  `/app/data` and `/tmp`.
- **`security_opt: no-new-privileges:true` and `cap_drop: [ALL]`** — the process
  binds an unprivileged port and needs no capability at all.
- **`stop_grace_period: 15s`** — gives `tini` time to forward `SIGTERM` so Fastify,
  the MCP server, and SQLite close cleanly before `SIGKILL`. The backend installs
  its own `SIGTERM`/`SIGINT` handlers and closes all three in order.
- **Bounded `json-file` logs** (`max-size: 10m`, `max-file: 3`). Unbounded
  container logs are one of the easiest ways to fill a 60 GB disk.

### Commands

Compose is invoked with an explicit file path and the repository root as the
working directory, because the build context is `..` relative to `docker/`:

```bash
# 1. Create the environment file from the production template, then edit it
cp docker/env.production.example docker/.env

# 2. Generate the shared secret and set it in docker/.env
openssl rand -hex 32

# 3. Build and start
docker compose -f docker/docker-compose.yml up -d --build

# 4. Inspect
docker compose -f docker/docker-compose.yml ps
docker compose -f docker/docker-compose.yml logs -f
docker compose -f docker/docker-compose.yml restart backend

# 5. Stop
docker compose -f docker/docker-compose.yml down      # keeps the volume
docker compose -f docker/docker-compose.yml down -v   # DESTROYS the cache volume
```

The `Dockerfile` notes that the build context is the repository root. A root
`.dockerignore` now excludes `node_modules`, `**/dist`, `data`, `.env`,
`.dev.vars`, `.pnpm-store`, `.wrangler`, `docs`, and `tests`, which avoids
transferring hundreds of megabytes of host build artefacts into the context. Every
`COPY` names an exact path regardless, so the ignore file is defence in depth plus
a large speed-up.

### Persistent volume for SQLite

| Concern | Answer |
|---|---|
| Path in container | `CACHE_DB_PATH=/app/data/cache.sqlite` |
| Mount point | `/app/data` (a directory, not a file) |
| Volume | Named volume **`aee-cache`** (declared with an explicit `name:` so it is not project-prefixed) |
| Ownership | The image creates `/app/data` owned by `aee:aee` (UID/GID 10001); a named volume inherits that, a bind mount does not — `chown 10001:10001` if you bind-mount |
| Backups | Stop the container (or use SQLite's online backup) before copying; `-wal`/`-shm` must be consistent with the main file |
| Loss impact | The cache is a performance optimisation, never a source of truth. Losing it costs re-fetches, not correctness. |
| Bounds | `CACHE_MAX_ENTRIES` (default 5000) and `CACHE_TTL_SECONDS` (default 86400) cap growth |

`createSqliteCache` creates the parent directory if it is missing, so a fresh
volume on first boot works without extra setup. Even so, the backend treats the
cache as optional: if `createSqliteCache` throws at startup, the server logs a
warning and continues **without** a cache rather than refusing to serve.

---

## 4. Cloudflare Worker deployment

### Configure

`apps/worker/wrangler.jsonc` reads:

| Variable | Source | Notes |
|---|---|---|
| `X402_NETWORK` | `vars` | `eip155:8453` for production, `eip155:84532` for test. |
| `X402_RECIPIENT` | `vars` | Your **public** receiving address. |
| `X402_FACILITATOR_URL` | `vars` | Confirm against current official x402 documentation. |
| `X402_PRICE_USD` | `vars` | Verify after changing; an unparseable value silently falls back to `$0.03`. |
| `BACKEND_ORIGIN_URL` | `vars` | Your protected origin. |
| `BACKEND_AUTH_SECRET` | **secret** | Never in `wrangler.jsonc`. See below. |
| `DEV_BYPASS_PAYMENT` | `vars` (dev only) | Never set in production. |

`wrangler.jsonc` warns in a comment that **wrangler does not inherit top-level
`vars` into a named environment** — every variable the Worker reads is repeated
in each `env` block. A missing variable arrives as `undefined` with only a
warning, which surfaces at runtime as `NOT_CONFIGURED` (HTTP 503).

> **Fix before deploying.** The `env.dev` and `env.test` blocks currently contain
> literal test-recipient addresses, and the same literal in both. SPEC §33 says
> not to invent a wallet address and AGENTS.md §6 forbids committing wallet
> configuration. Replace them before this file is published or deployed. The
> production block uses a zero-address placeholder, which fails loudly but is
> still not a real recipient.

### Set the secret

`BACKEND_AUTH_SECRET` is deliberately absent from `wrangler.jsonc` so it can
never be committed. Set it as a Worker secret:

```bash
wrangler secret put BACKEND_AUTH_SECRET
# paste the value produced by: openssl rand -hex 32
```

This is **the required step** SPEC §32 refers to. Two things to get right:

- The secret must match the value the backend reads from its own
  `BACKEND_AUTH_SECRET` environment variable. Change both sides together.
- Run the command in the Worker directory (`apps/worker`) or with the right
  `--config`, and target the intended environment. The top-level `vars` block is
  the production environment, so a plain `wrangler secret put` targets it. A
  named environment needs `--env <name>`.

Verify the binding exists without revealing it:

```bash
wrangler secret list
```

To rotate: set the new secret on both sides, then redeploy the Worker. There is
no dual-accept window in v0.1.0, so there is a brief window where the Worker and
backend disagree.

### Deploy

```bash
cd apps/worker

# Validate the bundle without shipping it
wrangler deploy --dry-run --outdir=dist

# Ship the production environment (top-level vars)
wrangler deploy
```

Or via the workspace script:

```bash
pnpm --filter @aee/worker deploy
```

### Attach the public hostname

`wrangler.jsonc` currently contains **no `routes` key**, so a deployment is
reachable at its `*.workers.dev` URL until you add a custom domain route or
configure one in the Cloudflare dashboard. Add the route only once you own the
domain — do not invent one:

```jsonc
// Add to wrangler.jsonc once ${PUBLIC_API_DOMAIN} is genuinely yours
"routes": [
  { "pattern": "api.example.invalid/*", "custom_domain": true }
]
```

### Environment summary

| Environment | Activation | Network | Payment | Backend origin |
|---|---|---|---|---|
| production | `wrangler deploy` | `eip155:8453` (Base) | required | protected origin |
| dev | `wrangler dev --env dev` | `eip155:84532` (Base Sepolia) | bypassed | `http://127.0.0.1:8080` |
| test | `wrangler dev --env test` | `eip155:84532` (Base Sepolia) | required | `http://127.0.0.1:8080` |

---

## 5. Environment variables

Reference template: [`.env.example`](../.env.example) in the repository root.
That file contains **placeholders only** and is the source of truth for the
variable list. Copy it to `.env` (gitignored) for local use.

### Service identity

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | Set `production` in the container. |
| `SERVICE_NAME` | `agent-evidence-api` | Reported by `/health`. |
| `SERVICE_VERSION` | `0.1.0` | Reported by `/health` and `/`. |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |

### Backend server

| Variable | Default | Notes |
|---|---|---|
| `BACKEND_HOST` | `127.0.0.1` | Loopback-only default. Set `0.0.0.0` **inside Docker** and restrict at the network layer. |
| `BACKEND_PORT` | `8080` | |
| `BACKEND_ORIGIN_URL` | `https://backend.example.invalid` | The origin the Worker forwards to. |

### Worker-to-backend authentication

| Variable | Default | Notes |
|---|---|---|
| `BACKEND_AUTH_SECRET` | *(empty)* | **No default on purpose — the backend must fail closed.** Minimum 16 characters. Generate with `openssl rand -hex 32`. Set on the Worker with `wrangler secret put`. |

### Payment

| Variable | Default | Notes |
|---|---|---|
| `X402_NETWORK` | `eip155:84532` | Safe testnet default in `packages/core`; production sets `eip155:8453`. |
| `X402_RECIPIENT` | *(empty)* | Public address only. |
| `X402_FACILITATOR_URL` | `https://x402.org/facilitator` | |
| `X402_PRICE_USD` | `0.03` | `$` prefix optional; rendered to 2 decimals. |
| `X402_TEST_PRIVATE_KEY` | *(empty)* | Base Sepolia only. Disposable. Never funded with mainnet assets. Never committed. |

### Resource limits

| Variable | Default |
|---|---|
| `MAX_CONCURRENT_FETCHES` | `4` |
| `MAX_URLS_PER_REQUEST` | `5` |
| `MAX_RESPONSE_BYTES` | `2097152` |
| `MAX_REDIRECTS` | `5` |
| `REQUEST_TIMEOUT_MS` | `10000` |
| `CONNECT_TIMEOUT_MS` | `5000` |
| `MAX_EVIDENCE_ITEMS` | `5` |
| `MAX_EXCERPT_CHARS` | `600` |

### Cache

| Variable | Default |
|---|---|
| `CACHE_ENABLED` | `true` |
| `CACHE_DB_PATH` | `./data/cache.sqlite` (`/app/data/cache.sqlite` in Docker) |
| `CACHE_TTL_SECONDS` | `86400` |
| `CACHE_MAX_ENTRIES` | `5000` |

### Fetching behaviour

| Variable | Default | Notes |
|---|---|---|
| `RATE_LIMIT_PER_MINUTE` | `60` | Sustained requests per minute per client. `0` disables the limiter entirely. Returned as 429 + `Retry-After` when exceeded. |
| `RATE_LIMIT_BURST` | `20` | Burst allowance above the sustained rate. |
| `FETCH_USER_AGENT` | `AgentEvidenceAPI/0.1.0 (+https://example.invalid/bot)` | Clearly identifiable User-Agent (SPEC §19). Point the URL at a real page once you have a domain. |
| `ROBOTS_POLICY` | `warn` | `ignore` \| `warn` \| `enforce`. Any other value makes startup fail. Enforced by `EvidenceService`: `ignore` never consults robots.txt, `warn` attaches a `ROBOTS_DISALLOWED` warning and proceeds, `enforce` refuses the source. |

### Docker env templates

Two separate templates exist, and mixing them is the mistake to avoid:

| Template | Network | Use |
|---|---|---|
| `docker/env.production.example` | `eip155:8453` (Base mainnet) | Production. Real USDC. |
| `docker/env.development.example` | `eip155:84532` (Base Sepolia) | Local development and testnet. |

Both are placeholders-only. Copy the right one to `docker/.env` and fill in
`BACKEND_AUTH_SECRET` and `X402_RECIPIENT`.

### Optional providers

`.env.example` and both Docker templates reserve `SEARCH_PROVIDER`,
`SEARCH_API_KEY`, `REASONING_PROVIDER`, `REASONING_BASE_URL`,
`REASONING_API_KEY`, `REASONING_MODEL`. They are commented out because **no
provider is implemented**; SPEC §37 requires the interfaces only.

### Domain placeholders

| Variable | Placeholder |
|---|---|
| `PUBLIC_API_DOMAIN` | `api.example.invalid` |
| `MCP_PUBLIC_URL` | `https://mcp.example.invalid/mcp` |

### Worker local secrets template

`apps/worker/.dev.vars.example` exists and contains placeholders only. Copy it to
`apps/worker/.dev.vars` for local development; `.dev.vars` and `.dev.vars.*` are
gitignored, with only the `.example` re-included. It carries
`BACKEND_AUTH_SECRET` and nothing else, because non-secret Worker configuration
belongs in `wrangler.jsonc` on purpose.

### Validation behaviour

`loadConfig()` throws at startup for a malformed integer
(`invalid integer for NAME: "..."`) or an invalid `ROBOTS_POLICY`. Everything
else falls back to a safe default. The one deliberate exception is
`BACKEND_AUTH_SECRET`, which has no default — that is the fail-closed mechanism.
The backend returns exit code 1 without binding a socket when the secret is
missing or shorter than 16 characters.

---

## 6. Health checks

| Target | Path | Expected |
|---|---|---|
| Worker (public) | `GET https://${PUBLIC_API_DOMAIN}/health` | `200` with `{"status":"ok","service":"agent-evidence-api","version":"0.1.0"}` |
| Backend (internal) | `GET http://127.0.0.1:8080/health` | Same minimal shape |
| Container | `HEALTHCHECK` in the Dockerfile | `200` from the backend's `/health` |

The health response is intentionally minimal: no secrets, no dependency versions,
no infrastructure detail (SPEC §4A). That means **`/health` is not a readiness
probe for the backend's dependencies.** It reports that the process is up, not
that the fetcher or the cache is usable. A deeper readiness check that exercises
the cache would have to be added deliberately and must not leak internal detail
in its response.

Suggested probe settings: interval 30 s, timeout 5 s, start period 10 s, 3
retries, and a `--retries` budget generous enough to survive a slow first boot
(SQLite WAL creation and directory setup).

---

## 7. Restart policy

`restart: unless-stopped` for the backend container. It restarts on crash and
after a host reboot, but stays down when an operator deliberately stops it,
which is what you want for maintenance.

Do not add a process manager (PM2, systemd unit *and* Docker, etc.) on top of the
container. If the backend runs directly on the host instead of in Docker, a
single systemd unit with `Restart=always` and `RestartSec=5` is the equivalent
and is sufficient.

Cloudflare Workers need no restart policy: the platform manages the lifecycle,
and `wrangler deploy` performs an atomic replacement.

---

## 8. Origin protection

This is the part that makes payment meaningful. SPEC §15 requires that customers
cannot bypass the Worker and call the backend directly to avoid paying, and warns
that obscurity is not security.

```text
Internet
   │
   ▼
Cloudflare Worker          ← payment gate; the only public surface
   │
   ▼
protected origin           ← reachable only via the Worker
   │
   ▼
VPS backend                ← validates X-Backend-Auth on every request
```

### Option A — Cloudflare Tunnel (preferred)

The backend has **no inbound public listener and no public DNS record**. A
`cloudflared` connector makes an outbound connection to Cloudflare, and the
Worker reaches the backend through the tunnel.

Why this is preferred:

- There is nothing public to attack or to misconfigure open.
- No firewall rule to drift.
- No certificate to manage on the origin, and no origin IP to leak.
- The origin IP stays private, so it cannot be targeted directly at all.

Sketch:

```yaml
# Add to docker/docker-compose.yml as a second service.
# Not present in the committed file: add it when you adopt a tunnel.
  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel --no-autoupdate run
    environment:
      TUNNEL_TOKEN: ${CLOUDFLARE_TUNNEL_TOKEN}   # from your env file, never committed
    depends_on:
      - backend
```

With a sidecar, the backend needs **no published port at all** — remove the
`ports:` entry. Route the tunnel's public hostname to `http://backend:8080` and
set the Worker's `BACKEND_ORIGIN_URL` to that hostname.

`cloudflared` is expected on the workspace `PATH` (AGENTS.md §9).

### Option B — public origin + firewall

If the origin must be public, all of the following are required:

1. **HTTPS only.** No plaintext listener; redirect or refuse HTTP.
2. **Firewall restricted to Cloudflare's published egress ranges.** Everything
   else is dropped. Maintain the range list — it changes.
3. **Authenticated Worker-to-origin requests.** `X-Backend-Auth` validated on
   every internal route, with a constant-time comparison.
4. **Origin secret stored only server-side.** In the Worker's secret binding and
   the backend's environment. Never in the repository.
5. **No exposed administrative ports.** No database port, no debug port, no
   metrics port, no Docker socket. `BACKEND_PORT` only.
6. **Do not rely on a non-obvious hostname.** Obscurity is not a control.

### Always, in both options

- Validate the shared secret on **every** internal request. Network restriction
  and request authentication are independent layers; keep both. Both are now
  implemented: the backend's `onRequest` hook rejects anything but `/health`
  without a valid credential.
- Prefer `BACKEND_HOST=127.0.0.1` (the default) unless a container boundary
  requires `0.0.0.0`, and compensate at the network layer.
- The `/internal/` path prefix is a naming convention, not a control.
- A missing `BACKEND_AUTH_SECRET` produces a refusal to serve, not an
  unauthenticated forward. The backend checks this before binding a socket and
  exits non-zero.

---

## 9. Deployment checklist

Ordered. Nothing below has been executed in this repository's recorded history
except where noted.

**Configure and verify locally first**

1. Create `docker/.env` from `docker/env.production.example` (or
   `docker/env.development.example` for testnet); set `BACKEND_AUTH_SECRET` from
   `openssl rand -hex 32`.
2. Set `X402_RECIPIENT` to your own **public** address; keep `X402_NETWORK` on
   `eip155:84532` for test.
3. Fix the literal test addresses in `apps/worker/wrangler.jsonc`.
4. `pnpm validate` — typecheck (known to pass) plus the full test suite.
5. `pnpm test:security` — the SSRF and limit suites.
6. `bash scripts/smoke.sh` — live sockets: health, origin-auth refusal, a real
   evidence request, cache reuse, SQLite creation.
7. Build the container: `docker compose -f docker/docker-compose.yml build`.
8. Start it and verify `GET /health` from the host.
9. Verify `POST /internal/v1/evidence` rejects a request without
   `X-Backend-Auth` (`UNAUTHORIZED`, HTTP 401), and that the port is not reachable
   from outside the host.
10. Verify `initialize` / `tools/list` answer without payment, and that
    `tools/call` on `research_evidence` returns `402`.

**Deploy**

11. Validate the Worker bundle: `wrangler deploy --dry-run --outdir=dist`.
12. `wrangler secret put BACKEND_AUTH_SECRET`.
13. `wrangler deploy`.
14. Attach the public hostname and confirm the tunnel or firewall path.
15. Replace the placeholder `remotes[].url` in `server.json` with your real
    `MCP_PUBLIC_URL` and confirm the namespace is yours; see
    [`registry-publication.md`](./registry-publication.md) for validation.

**Requires credentials and manual configuration you must supply**

| Item | Where | Notes |
|---|---|---|
| `X402_RECIPIENT` | Worker var | Your public Base address. |
| `BACKEND_AUTH_SECRET` | `wrangler secret put` + backend env | Same value on both sides. |
| `BACKEND_ORIGIN_URL` | Worker var | Your protected origin. |
| Cloudflare account and tunnel token | Environment | For the preferred origin-protection option. |
| `PUBLIC_API_DOMAIN` / `MCP_PUBLIC_URL` | DNS + Worker route | Only once you own the domain. |
| Funded testnet wallet | Local only | Base Sepolia, for the payment test. Never commit. Never mix with mainnet. |

Per SPEC §43: do not fake or invent any of these, and do not claim the deployment
works until each step has actually been performed and observed.
