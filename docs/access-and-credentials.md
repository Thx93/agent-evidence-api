# Workspace access: what is authenticated, what is not, and how to fix it

Recorded 2026-09-21 after an audit. Every claim here was verified live, not inferred.
The pattern behind most of these: **the sandbox allows writes only under
`/root/Agents Projects`, so tool state lives there, and each tool has to be told where
to look.** A tool that "reports unauthenticated" usually has a perfectly good
credential one environment variable away.

---

## GitHub — works, and nothing was ever lost

| | |
|---|---|
| Credential | `/root/Agents Projects/.config/gh/hosts.yml` (0600) |
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
`GH_CONFIG_DIR=/root/Agents Projects/.config/gh` and execs the real binary. Same class
of fix as `bin/mcp-publisher` (HOME) and `bin/wrangler` (XDG_CONFIG_HOME). Put
`/root/Agents Projects/bin` on `PATH` per AGENTS.md §9 and a bare `gh` just works.

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
| Config | `/root/Agents Projects/.npmrc` (0600), correctly used as `userconfig` |
| Account | **thx93** (verified — it appears as `owner` of the `@thx93` scope) |
| Token | `npm_…`, 40 chars — **rejected**: `/-/whoami` and `/-/npm/v1/user` both 401 |
| Published packages | **published 2026-10-19**: `@thx93/x402-evidence@0.1.0` (this repo) and `@thx93/mcp-weather-server@1.1.0` — both resolve on the registry |

The token **worked at 07:12 UTC and started returning 401 at 17:22 UTC the same day**
(recovered from the npm cache's stored `/-/whoami` success and the log timestamps),
with `.npmrc` unchanged. So it was revoked or expired server-side, not
misconfigured. It cannot be recovered from this host.

**To fix (operator action, ~1 minute):**

1. Sign in at <https://www.npmjs.com> as **thx93**.
2. Access Tokens → Generate New Token →
   *Granular Access Token* (Read + Write to publish; choose an expiry) or
   *Automation* (no expiry, for CI).
3. Replace the single line in `/root/Agents Projects/.npmrc`:
   `//registry.npmjs.org/:_authToken=<NEW_TOKEN>` and keep it `0600`.
4. Verify with `npm whoami` → `thx93`.

That would let the buyer CLI be published as `@thx93/x402-evidence`, which is a real
distribution surface (npm search and `npx`) rather than another directory listing.

---

## AgentMail — the key is real but holds almost nothing

| | |
|---|---|
| Credential | `/root/Agents Projects/.agentmail-key` (76 bytes, prefix `am_`) |
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
   `/root/Agents Projects/.agentmail-key` (`0600`).

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
taken first: `/root/Agents Projects/.x-archive/leq6ah-posts.json` (JSON) and
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

`scripts/supervise.sh` was the fix at the time, and it was the wrong shape: a
detached shell loop is still a session process, and it was killed like the rest.
It is now superseded by the **watchdog container**, which has the same
`--restart unless-stopped` policy that kept the backend alive through both
outages — see `docs/deployment.md` §7 ("Keeping the origin reachable"). The
container restarts a dead tunnel, repoints the Worker when the hostname changes,
and backs off so a broken backend cannot become a deploy storm.

`scripts/supervise.sh` now only reports status and runs a single safe cycle; it no
longer starts a loop, because doing so would race the container's deploys. Note
also that `.origin-url` is deliberately **untracked** (gitignored): it is
machine-local state that changes on every tunnel restart, and committing it would
ship a hostname that has already died.

---

## npm publishing: the exact blocker, as of 2026-10-19

Three different failures were hit before the real one was understood, so this is
written down.

| attempt | result | meaning |
| --- | --- | --- |
| `npm publish` with the account token | **E403** "Two-factor authentication or granular access token with bypass 2fa enabled is required" | the token has `bypass_2fa: false`; direct publish is closed unless a token with bypass is issued |
| `npm trust github @thx93/…` (first try) | **E403** | misleading - it was the wrong scope, resolved below |
| `npm trust github @thx93/…` (after the org was corrected) | **EOTP** "This operation requires a one-time password" | configuring trust is an *account change*: it needs one interactive 2FA approval, once |

Scopes: the npm org is **`thx93agents`**, not `thx93`. The packages are
`@thx93/mcp-weather-server` and `@thx93/x402-evidence`, which is the **username
scope** - valid, and npm accepted it as far as the OTP step (EOTP, not 404/403). So
no rename is needed.

Trusted publishing then removes tokens from publishing entirely: afterwards the
GitHub workflows publish via OIDC with a signed provenance attestation and no secret
at all. The CI plumbing is already proven - the workflow reaches npm and npm signs
the provenance statement before rejecting the PUT for want of a trust relationship.

**Corrected 2026-10-19:** an earlier revision of this file said the step could only
be done from a real terminal, because npm masks the auth URL in non-TTY output
(`https://www.npmjs.com/auth/cli/***`, and `authId=***`, including in the debug logs
under `.npm-cache/_logs`). That is true about the URL - it cannot be recovered
headlessly - but it is not the only way in. **npm accepts the code directly**, which
removes the browser step entirely:

```bash
npm trust github "@thx93/mcp-weather-server" --file publish.yml \
  --repo Thx93/mcp-weather-server --allow-publish --otp=<6-digit code>

npm trust github "@thx93/x402-evidence" --file publish.yml \
  --repo Thx93/agent-evidence-api --allow-publish --otp=<6-digit code>
```

Verified by feeding a deliberately wrong code: npm answered
"requires a one-time password from your authenticator" rather than "unknown
positional argument", so the flag is parsed and only the value was rejected. The
`npm_config_otp` environment variable works identically. A genuine code from the
account's authenticator completes the operation in one shot, from anywhere.

`--allow-publish` is not optional: configurations created after 2026-09-03 default
to `npm stage publish` only, which stages a release for a maintainer to approve, and
that approval needs 2FA and cannot be automated.

Once trust exists, publishing needs no code at all - the GitHub workflow exchanges an
OIDC token and npm signs a provenance attestation, which the CI logs already show
happening before the trust relationship is what stops the PUT.

For completeness, the same relationship can be POSTed to the registry directly. The
body shape, discovered by probing, is:

```json
[{"type":"github","permissions":["createPackage"],
  "claims":{"repository":"<owner>/<repo>","workflow_ref":{"file":"publish.yml"}}}]
```

`POST /-/package/<url-encoded name>/trust` with that body answers `Unauthorized` for
a normal token, so the CLI path above is the one that works.

After each command prints a URL, open it and approve. Then Actions → "Publish to
npm" → Run workflow in each repository.

### How it was finally unblocked (2026-10-19)

Three token attempts failed before the right one: a granular token with
`bypass_2fa: false` (E403 on publish), the same token for the *trust* call (E403,
wrong scope), and finally a granular token with **bypass two-factor authentication
enabled** and **"Read and write (publish and stage)"** — not "stage only", which
stages a release that a maintainer must then promote with 2FA.

With that token `npm publish --access public` succeeded for both packages and the
registry answered **202 Accepted**; the packages resolved a few minutes later. The
202 is why they appeared to 404 at first — nothing was wrong, it is asynchronous.

Trusted publishing is still the better end state and still needs one authenticator
code: a bypass-2FA token is explicitly refused for it —

```
E403 Granular access tokens that bypass two-factor authentication may not perform this action.
```

So the token route publishes, and only the code route retires the token. Any token
issued for this should be revoked once it has done its job.
