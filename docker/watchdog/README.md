# Watchdog container (`aee-watchdog`)

Keeps <https://agent-evidence-api.thx93.workers.dev> reachable without human
intervention.

It exists because of a specific, twice-repeated failure: the Worker reaches its
origin through the plain-text var `BACKEND_ORIGIN_URL`, which holds a **cloudflared
quick-tunnel** URL. A quick tunnel gets a **new random hostname every restart**, so
whenever the tunnel process died and came back, the Worker kept proxying to a dead
hostname and the service silently answered
`502 / {"status":"degraded","backend":"unreachable"}` — down ~2 days from
2026-09-22, then ~3 weeks from 2026-09-24 (Glama's hourly check emailed
"HTTP 502 – Error connecting to MCP" the whole time).

The decisive observation from those outages: the **Docker-managed** container
`aee-live` was `Up 3 weeks`, while the session processes (a `setsid/nohup`
`cloudflared` and the shell supervisor around it) were killed. So the watchdog is
itself a Docker container with `--restart unless-stopped`; it is not a cron job
and not a shell loop, and it never depends on a DSH shell session.

- Loop script: [`scripts/watchdog.sh`](../../scripts/watchdog.sh)
- Image definition: [`Dockerfile`](./Dockerfile)

---

## What it does, once per cycle (default 60 s)

1. If the `aee-tunnel` container is missing or not running, (re)start it with the
   same arguments the live service uses:

   ```bash
   docker run -d --name aee-tunnel --restart unless-stopped --network host \
     cloudflare/cloudflared:latest tunnel --url http://127.0.0.1:8080 --no-autoupdate
   ```

2. Read the tunnel's **current** public URL from `docker logs aee-tunnel`
   (last match of `https://[a-z0-9-]+\.trycloudflare\.com`).
3. If that URL differs from `.origin-url`, write the new URL and run
   `bash scripts/deploy-live.sh`, then confirm the live service is healthy.
   `deploy-live.sh` is the *only* path used, on purpose: it re-applies the
   `secret_text` binding `BACKEND_AUTH_SECRET` (which is unrecoverable if
   dropped) and verifies the deployed Worker from the outside. The Cloudflare
   API token here cannot manage tunnels or KV, so Worker settings are never
   patched over the raw API.
4. Independently of (3), probe `GET /health?deep=1` and treat it as healthy
   **only** if the body contains `"backend":"ok"`. The shallow `/health` is
   answered by the Worker itself and stays `200` while the backend is dead —
   that is precisely how both outages stayed invisible. Two consecutive
   unhealthy cycles while the tunnel URL already matches `.origin-url` (tunnel
   fine, Worker stale) earn **one** rate-limited redeploy. If instead the local
   backend is not answering on `http://127.0.0.1:8080`, no redeploy is queued:
   it cannot help, and the log says so explicitly.
5. Rate-limit itself: **never more than one Worker deploy per 5 minutes**, and
   while deploys keep failing it backs off `10 → 20 → 30` minutes (cap), so a
   broken backend cannot cause a deploy storm. Tunnel restarts have their own
   5-minute floor.
6. Append **exactly one timestamped line per cycle** to
   [`data/watchdog.log`](../../data/watchdog.log) (with the tunnel URL, whether
   it changed, the live health result, and the action taken), trimmed to the
   last 2000 lines. Full deploy output goes to `data/watchdog-deploy.log`
   instead, so the cycle log stays one line per cycle.

No `jq` is needed: only `docker`, `curl` and core shell tools are used.

A sample line:

```
[2026-10-18T17:20:11Z] action=deployed(origin-changed) url=https://recording-depot-inserted-prints.trycloudflare.com url_changed=yes origin_file=stale live=ok unhealthy_streak=0 backend_local=ok next_deploy_in=300s
```

A cycle that does two things reports both, joined by `+` — recreating a dead
tunnel *and* repointing the Worker at its new hostname is one such cycle:

```
[2026-10-18T17:24:47Z] action=tunnel-started(missing)+deployed(origin-changed) url=https://brunette-hose-inexpensive-pattern.trycloudflare.com url_changed=yes origin_file=stale live=ok unhealthy_streak=0 backend_local=ok next_deploy_in=300s
```

"Deploy succeeded" is judged by the **outcome**, not only by
`deploy-live.sh`'s exit status. That script verifies the Worker from the outside
immediately after deploying, and its checks are genuinely flaky for a few seconds
after an origin change: Cloudflare propagates a new version gradually, so some of
its probes can still reach the previous (broken) version and fail — observed in
practice as `502` on the paywall and `530` on the manifest while deep health
already answered `"backend":"ok"`. When that happens the watchdog re-probes the
live service itself, and if it is healthy it records the deploy as successful
with `note="deploy-script-verify-flaky-but-live-healthy"` instead of starting a
10-minute back-off over a service that is already healed.

---

## Build

```bash
cd /root/dsh-workspace/agent-evidence-api
export PATH="/root/dsh-workspace/bin:$PATH"
docker build -t aee-watchdog:latest docker/watchdog
```

## Start it (one line)

```bash
docker run -d --name aee-watchdog --restart unless-stopped --network host -v /var/run/docker.sock:/var/run/docker.sock -v /root/dsh-workspace:/root/dsh-workspace aee-watchdog:latest
```

Read that as:

| flag | why it is required |
| --- | --- |
| `--restart unless-stopped` | the whole point: survive reboots and crashes without a session |
| `-v /var/run/docker.sock:/var/run/docker.sock` | `docker inspect/logs/run` against the host's containers |
| `-v /root/dsh-workspace:/root/dsh-workspace` | the repo **at its real absolute path** *and* everything `scripts/deploy-live.sh` needs |
| `--network host` | so `http://127.0.0.1:8080` is the host's backend (the tunnel uses `--network host` for the same reason) |

The workspace mount is not optional cosmetics: `deploy-live.sh` needs all of

- the repo itself, including `.origin-url` and `.prod-secret` (**writable** —
  the watchdog rewrites `.origin-url`, and `pnpm build` writes `dist/`),
- `/root/dsh-workspace/bin` — the `node`, `pnpm`, `wrangler` **wrappers**,
- `/root/dsh-workspace/node` and `/root/dsh-workspace/node_modules` — the
  workspace Node 24 install and installed dependencies,
- `/root/dsh-workspace/.config` — `XDG_CONFIG_HOME`, where the `wrangler`
  wrapper looks for its config (a fallback only; the API token is used),
- `/root/dsh-workspace/.docker` — `DOCKER_CONFIG`, which the `docker` wrapper sets,
- `/root/dsh-workspace/.cloudflare-credentials` — the Cloudflare credentials.

### `PATH` inside the container is mandatory

`wrangler`, `pnpm` and `node` are **workspace wrappers**, not system packages.
Inside the container, `PATH` must lead with the workspace bin directory:

```bash
export PATH="/root/dsh-workspace/bin:$PATH"
```

The image already sets it (`ENV PATH=/root/dsh-workspace/bin:...`), and
`scripts/watchdog.sh` re-exports it, so nothing else has to. It matters for any
manual `docker exec` too — without it you get "wrangler: command not found", and
`deploy-live.sh` cannot heal anything.

### Credentials

The watchdog loads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from
`/root/dsh-workspace/.cloudflare-credentials` (inside the workspace mount) and
exports them into `scripts/deploy-live.sh`'s environment; `wrangler` picks them
up from there. It parses the file line by line rather than sourcing it, and it
never prints the values. If the container already has `CLOUDFLARE_API_TOKEN` in
its environment, the file is not read at all:

```bash
# alternative: pass them straight in instead of relying on the workspace mount
docker run -d --name aee-watchdog --restart unless-stopped --network host \
  --env-file /root/dsh-workspace/.cloudflare-credentials \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /root/dsh-workspace:/root/dsh-workspace \
  aee-watchdog:latest
```

The token can read and deploy the Worker (including `wrangler secret put`) but
**cannot** manage tunnels or KV, which is why the tunnel is restarted with
`docker run` and the origin is changed with `scripts/deploy-live.sh` — never by
patching Worker settings over the raw API, which would drop the
`BACKEND_AUTH_SECRET` binding.

---

## Configure (all optional)

| env var | default | meaning |
| --- | --- | --- |
| `WATCHDOG_INTERVAL` | `60` | seconds between cycles |
| `AEE_PUBLIC_URL` | `https://agent-evidence-api.thx93.workers.dev` | public Worker URL to probe |
| `AEE_TUNNEL_CONTAINER` | `aee-tunnel` | tunnel container name |
| `AEE_BACKEND_CONTAINER` | `aee-live` | backend container name |
| `AEE_BACKEND_ORIGIN` | `http://127.0.0.1:8080` | local origin the tunnel exposes |
| `AEE_CLOUDFLARE_CREDENTIALS` | `/root/dsh-workspace/.cloudflare-credentials` | credentials file |
| `AEE_DEPLOY_MIN_GAP` | `300` | hard floor between deploys (seconds) |
| `AEE_BACKOFF_CAP` | `1800` | back-off ceiling (seconds) |
| `AEE_TUNNEL_RESTART_MIN_GAP` | `300` | floor between tunnel restarts (seconds) |
| `AEE_LOG_MAX_LINES` | `2000` | `data/watchdog.log` retention |
| `AEE_LOG` / `AEE_DEPLOY_LOG` | `data/watchdog.log` / `data/watchdog-deploy.log` | log destinations; only useful for running a second test instance without interleaving. `.origin-url` is deliberately **not** overridable, because `scripts/deploy-live.sh` reads it |

---

## Operate and verify

```bash
docker ps --filter name=aee-watchdog                       # running, with restart policy
tail -n 20 /root/dsh-workspace/agent-evidence-api/data/watchdog.log    # one line per cycle
docker logs --tail 40 aee-watchdog                         # loop stdout + deploy output
tail -n 40 /root/dsh-workspace/agent-evidence-api/data/watchdog-deploy.log

# force a single cycle by hand (exits 0 when the live service is healthy)
docker exec aee-watchdog bash /root/dsh-workspace/agent-evidence-api/scripts/watchdog.sh --once

# is the live service really serving from a live backend?
curl -s "https://agent-evidence-api.thx93.workers.dev/health?deep=1"
# -> {"status":"ok",...,"backend":"ok",...}
```

### Prove the heal path (what was actually tested)

```bash
cd /root/dsh-workspace/agent-evidence-api
cp .origin-url /tmp/origin.bak
printf 'https://invalid.example.invalid\n' > .origin-url     # deliberately stale
curl -s "https://agent-evidence-api.thx93.workers.dev/health?deep=1"
sleep 90
tail -n 2 data/watchdog.log                                  # url_changed=yes ... action=deployed(origin-changed)
cat .origin-url                                              # the real tunnel URL again
curl -s "https://agent-evidence-api.thx93.workers.dev/health?deep=1"   # "backend":"ok"
```

### Notes and limits

- The log has one line per cycle **plus** a single `action=started ...` line when
  the container boots; that line is what makes a restart visible.
- Recovery takes one cycle plus one deploy (~1–3 min: `deploy-live.sh` runs
  `pnpm build` and then verifies the live Worker from the outside).
- The watchdog deliberately does **not** try to repair the backend itself. If
  `aee-live` is down (`docker ps`), the log line says *"backend aee-live is not
  answering … a Worker redeploy cannot fix that"* and no deploy is queued.
- It does not restart `aee-live`; that container already has its own restart
  policy, and `scripts/go-live.sh` owns bringing the backend up.
- Deleting `data/watchdog.log` is safe — it is recreated on the next cycle.
