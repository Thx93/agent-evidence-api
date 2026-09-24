# Workspace access: what is authenticated, what is not, and how to fix it

Recorded 2026-09-21 after an audit. Every claim here was verified live, not inferred.
The pattern behind most of these: **the sandbox allows writes only under
`/root/dsh-workspace`, so tool state lives there, and each tool has to be told where
to look.** A tool that "reports unauthenticated" usually has a perfectly good
credential one environment variable away.

---

## GitHub — works, and nothing was ever lost

| | |
|---|---|
| Credential | `/root/dsh-workspace/.config/gh/hosts.yml` (0600) |
| Account | **Thx93** (GitHub user id 290134016) |
| Token | classic OAuth `gho_…`, 40 chars, no expiry |
| Scopes | `admin:repo_hook`, `gist`, `read:org`, `repo`, `workflow` |
| Verified | `GET https://api.github.com/user` → 200 |

**Why it looked broken.** `gh` resolves its config as
`$GH_CONFIG_DIR` → `$XDG_CONFIG_HOME/gh` → `$HOME/.config/gh`. In this workspace
neither env var is set, `HOME` is `/root`, and `/root/.config/gh` does not exist — so
`gh` never saw the workspace config and printed "You are not logged into any GitHub
hosts".

**The fix is now permanent:** `bin/gh` is a wrapper that exports
`GH_CONFIG_DIR=/root/dsh-workspace/.config/gh` and execs the real binary. Same class
of fix as `bin/mcp-publisher` (HOME) and `bin/wrangler` (XDG_CONFIG_HOME). Put
`/root/dsh-workspace/bin` on `PATH` per AGENTS.md §9 and a bare `gh` just works.

For `git push`/`pull` over https, run `gh auth setup-git` once.

### Repository state

`origin` is `https://github.com/Thx93/agent-evidence-api.git`, and the repo exists —
**private**, created 2026-09-21, with a real description. `origin/main` is at
`ae4f2e6` while local `main` is **70 commits ahead and unpushed**.

> AGENTS.md / SPEC §35 says *do not push automatically*. Nothing has been pushed.
> Pushing is a one-line action once the operator says so.

Making the repo **public** is a separate decision with real consequences: the MCP
Registry namespace `io.github.Thx93/…` is verified against a public repo, and
glama.ai's GitHub claim method requires one. It also publishes the whole codebase and
its git history. Operator's call.

---

## npm — dead token, account known

| | |
|---|---|
| Config | `/root/dsh-workspace/.npmrc` (0600), correctly used as `userconfig` |
| Account | **thx93** (verified — it appears as `owner` of the `@thx93` scope) |
| Token | `npm_…`, 40 chars — **rejected**: `/-/whoami` and `/-/npm/v1/user` both 401 |
| Published packages | none. `@thx93/x402-evidence` and `x402-evidence` both 404 |

The token **worked at 07:12 UTC and started returning 401 at 17:22 UTC the same day**
(recovered from the npm cache's stored `/-/whoami` success and the log timestamps),
with `.npmrc` unchanged. So it was revoked or expired server-side, not
misconfigured. It cannot be recovered from this host.

**To fix (operator action, ~1 minute):**

1. Sign in at <https://www.npmjs.com> as **thx93**.
2. Access Tokens → Generate New Token →
   *Granular Access Token* (Read + Write to publish; choose an expiry) or
   *Automation* (no expiry, for CI).
3. Replace the single line in `/root/dsh-workspace/.npmrc`:
   `//registry.npmjs.org/:_authToken=<NEW_TOKEN>` and keep it `0600`.
4. Verify with `npm whoami` → `thx93`.

That would let the buyer CLI be published as `@thx93/x402-evidence`, which is a real
distribution surface (npm search and `npx`) rather than another directory listing.

---

## AgentMail — the key is real but holds almost nothing

| | |
|---|---|
| Credential | `/root/dsh-workspace/.agentmail-key` (76 bytes, prefix `am_`) |
| Works | `GET /v0/threads` → 200 |
| Blocked | `/v0/inboxes` (`inbox_read`), `POST /v0/inboxes` (`inbox_create`), `/v0/pods` (`pod_read`), `/v0/domains` (`domain_read`), `/v0/api-keys` (`api_key_read`) |

Per [AgentMail's permission model](https://www.agentmail.to/docs/permissions),
permissions are a **whitelist** — an API key with no `permissions` object has full
access *within its scope*, and one with the object has only what is set `true`.
Scope is set by the route that created the key: org (`POST /v0/api-keys`), pod, or
inbox. A restricted key **cannot mint a more privileged child**, which is why this one
is a dead end: it holds at most `message_read`, cannot see or create an inbox, and
therefore cannot send or read replies.

**To fix (operator action):**

1. Sign in at <https://console.agentmail.to> — a key cannot log in, this needs the
   owner session.
2. **API Keys → Create New API Key**, name it e.g. `outreach-agent`.
3. Scope: **Organization** (required to create an inbox).
4. Enable exactly these four, nothing else:
   - `inbox_read` — see and confirm the inbox
   - `inbox_create` — create one (omit if reusing an existing inbox)
   - `message_read` — read replies
   - `message_send` — send
5. Copy the key once (it is shown only once) and replace
   `/root/dsh-workspace/.agentmail-key` (`0600`).

If the console offers no permission toggles, the key will be unrestricted
org-scoped. It can then be narrowed with
`PATCH /v0/api-keys/{id}` or used once to mint a restricted child via
`POST /v0/api-keys` with an explicit `permissions` object.

**Deliberately not requested:** `message_delete` (also destroys whole threads),
`inbox_update`/`inbox_delete`, all `draft_*`, all `domain_*` (DNS-level sending
control), all `api_key_*` (privilege-escalation surface), all `pod_*`, and
`provider_connect`. `message_send` is the one with real blast radius — it can mail
arbitrary recipients — so it should be granted with that understood, not by default.

Free tier is 3 inboxes / 3,000 emails a month, which is far more than this needs.

---

## X — session works, account now holds only the x402 posts

| | |
|---|---|
| Credential | `/root/.agent-reach/config.yaml` → `twitter_auth_token`, `twitter_ct0` |
| Account | **@leq6ah** — 0 followers |
| State | **7 posts**: the x402 market post plus its 6 replies |

The 171 Arabic deals posts were deleted on the operator's instruction (171 of 171,
**0 failures**, paced to X's ~50-deletes-per-15-minutes limit). A full archive was
taken first: `/root/dsh-workspace/.x-archive/leq6ah-posts.json` (JSON) and
`leq6ah-posts.md` (readable), plus `delete-results.tsv` as the per-post record.

`twitter search` returns HTTP 404 (known upstream breakage). `user-posts`,
`following`, `tweet` and `post` all work, so targets are found by walking accounts
and reading reply threads rather than by searching.

---

## Rotation log

### `BACKEND_AUTH_SECRET` — rotated 2026-09-24, before publication

`.prod-secret` was committed in `d4471c2` and its value was byte-identical to the
secret the live Worker and backend shared. Before this repository was made public,
the secret was rotated and the file untracked and gitignored. The old value is still
in the history — the repository was pushed after the rotation, so what is public is
the **inert** value. Verified: the live secret appears **0** times in the pushed
history.

A full pass over the tree and all history found no other live credential. No private
key, no CDP key, no Cloudflare token, no AgentMail key, and the seller wallet's
private key appears zero times — the 26 matches for that file were the **public**
recipient address, which is meant to be published.

Both sides were redeployed together: the backend container first, then the Worker
secret via `scripts/deploy-live.sh`. All nine readiness checks passed afterwards.

**Note for any future rotation:** updating one side first breaks every paid route
until the other catches up. With no customers that is harmless; with customers it is
an outage, so rotate during a quiet window or add a dual-accept period.

### The tunnel died silently — 2026-09-22 to 2026-09-24

The `cloudflared` quick tunnel received a `SIGTERM` on 2026-09-22 and exited
gracefully. Nothing restarted it, and nothing alerted: the Worker kept serving, the
manifest kept serving, and only `health?deep=1` revealed `"backend":"unreachable"`.
The service was effectively down for two days and the failure was invisible from the
outside.

Restored by starting a new tunnel, writing the new URL to `.origin-url`, and
redeploying the Worker (a quick tunnel's hostname changes on every restart, which is
why `deploy-live.sh` reads that file and passes `BACKEND_ORIGIN_URL` as a var).

`scripts/supervise.sh` is now running again (300 s interval), so an unhealthy tunnel
or backend is restarted automatically and the Worker is redeployed with the new
origin. It lives outside cron and systemd because both are outside the
sandbox-writable area; it dies on reboot, so after a reboot run
`bash scripts/supervise.sh 300` once.
