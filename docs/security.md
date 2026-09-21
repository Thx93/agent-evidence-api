# Security model

This service fetches arbitrary URLs supplied by untrusted callers. That makes the
fetcher the single most security-sensitive component in the system, and it is
treated that way: every URL is hostile input until it has been validated,
resolved, and re-validated at connect time.

Two distinct security problems are solved here, and it is important not to
conflate them:

1. **SSRF** — stopping a caller from making the service reach a destination it
   should not reach (internal networks, cloud metadata, the loopback interface).
   Owned by `@aee/fetcher`.
2. **Origin protection** — stopping a caller from reaching the backend directly
   and skipping payment. Owned by the Worker→backend boundary.

SPEC §18 defines the first; SPEC §15 defines the second.

> **Status.** The SSRF control set is implemented in `packages/fetcher`
> (`ip.ts` for address and hostname classification, `fetch.ts` for the transport
> controls). The backend that consumes it is implemented too, including
> fail-closed startup on a missing shared secret and constant-time credential
> comparison. Section [§8](#8-what-is-enforced-where) is the summary matrix and
> [§10](#10-known-gaps-summarised) lists what is still missing.
>
> `pnpm typecheck` passes across the workspace, and the SSRF and limit suites
> (`tests/security/`, 46 cases) exist. They have **not been run here**, and no
> independent security review has been performed. Treat the controls as
> implemented, un-audited, and unexercised in this session.

---

## 1. Threat model

| Adversary | Goal | Primary defence |
|---|---|---|
| A paying or non-paying API caller | Use the fetcher as a proxy into the private network (`http://169.254.169.254/…`, `http://10.0.0.5/…`, `http://localhost:8080/…`). | SSRF controls in `@aee/fetcher` |
| A caller controlling a hostile web page | Redirect the fetch to an internal address, or rebind DNS between validation and connection. | Per-hop redirect validation and connect-time IP revalidation |
| A caller controlling a hostile response | Exhaust memory or CPU with an enormous or deeply compressed body. | Byte caps, decompression limits, timeouts, concurrency bounds |
| A caller who has not paid | Skip the Worker and call the backend origin directly. | Origin protection + shared-secret verification |
| A caller probing for detail | Harvest internal architecture, versions, stack traces, or secrets from errors and logs. | Canonical error envelope, log sanitisation, minimal health response |
| Anyone reading the repository | Recover a private key, origin secret, or wallet address from source. | Secret handling rules (§5) |

Explicitly **out of scope**, by product decision (SPEC §19, §36): bypassing
authentication, defeating bot protections, CAPTCHA solving, login automation,
paywall circumvention, and collection of private or personal data. The service
targets publicly accessible resources only.

---

## 2. SSRF defences required by SPEC §18

Each row states the required behaviour, the layer that must enforce it, and the
current state.

| # | Control | Enforcing layer | Status |
|---|---|---|---|
| 1 | Scheme allowlist (`http`, `https` only) | `@aee/fetcher` | Implemented |
| 2 | Reject localhost and localhost aliases | `@aee/fetcher` | Implemented |
| 3 | Reject loopback addresses | `@aee/fetcher` | Implemented |
| 4 | Reject RFC1918 / private IPv4 | `@aee/fetcher` | Implemented |
| 5 | Reject link-local | `@aee/fetcher` | Implemented |
| 6 | Reject multicast | `@aee/fetcher` | Implemented |
| 7 | Reject unspecified addresses | `@aee/fetcher` | Implemented |
| 8 | Reject IPv6 loopback | `@aee/fetcher` | Implemented |
| 9 | Reject IPv6 link-local | `@aee/fetcher` | Implemented |
| 10 | Reject private IPv6 ranges | `@aee/fetcher` | Implemented |
| 11 | Block cloud metadata addresses | `@aee/fetcher` | Implemented |
| 12 | Validate hostname resolution | `@aee/fetcher` | Implemented |
| 13 | Validate resolved IPs | `@aee/fetcher` | Implemented |
| 14 | Validate **every** redirect hop | `@aee/fetcher` | Implemented |
| 15 | Detect DNS rebinding | `@aee/fetcher` | Implemented |
| 16 | Restrict ports | `@aee/fetcher` | Implemented (allowlist of 80/443/8080/8443) |
| 17 | Enforce connection timeout | `@aee/fetcher` | Implemented |
| 18 | Enforce total request timeout | `@aee/fetcher` | Implemented |
| 19 | Enforce maximum redirects | `@aee/fetcher` | Implemented |
| 20 | Enforce maximum response bytes | `@aee/fetcher` | Implemented |
| 21 | Reject unnecessary content types | `@aee/fetcher` | Implemented |
| 22 | Prevent decompression bombs | `@aee/fetcher` | Implemented |
| 23 | Enforce concurrency limits | `@aee/core`, `@aee/fetcher` | Implemented |
| 24 | No shell execution of URLs | All layers | Implemented (no `child_process` in the fetch path) |
| 25 | Sanitise logs | `@aee/core` logger, Worker, backend | Implemented |
| 26 | Never log payment or origin secrets | `@aee/core` logger | Implemented |

### 2.1 Scheme allowlist

Accept `http` and `https` only. Everything else is `INVALID_URL` — including
`file:`, `ftp:`, `gopher:`, `data:`, `blob:`, `javascript:`, and any
scheme-less or protocol-relative input. `file://` is called out by name in
SPEC §4 and must never be fetched, because it would turn the fetcher into a local
file read primitive.

Do not validate with a string prefix check (`url.startsWith("http")` accepts
`httpfoo://`). Parse with the WHATWG `URL` parser and compare
`url.protocol`.

**Implemented** in `validateUrl()` (`packages/fetcher/src/fetch.ts`): the URL is
parsed with `new URL(...)` — a parse failure is `INVALID_URL` — and the lowercase
protocol must be exactly `http:` or `https:`, otherwise `INVALID_URL` with a
reason naming the offending scheme. URLs containing credentials
(`https://user:pass@host/`) are rejected with `BLOCKED_URL`, so an embedded
credential cannot end up in a log line or a cache key.

### 2.2 localhost and localhost aliases

Reject the literal hostnames `localhost`, `localhost.localdomain`, and the
conventional `*.localhost` family, and reject any case or trailing-dot variant
(`LOCALHOST`, `localhost.`). Aliases must not be defeated by DNS: a hostname that
*resolves* to a loopback address is caught by the resolved-IP check in §2.11, not
by name matching.

Name matching alone is never sufficient. It exists to fail fast with a clearer
code, not as the defence.

**Implemented** in `classifyHostname()` (`packages/fetcher/src/ip.ts`): the
hostname is lower-cased and a trailing dot stripped, then checked against an
exact set (`localhost`, `ip6-localhost`, `ip6-loopback`,
`localhost.localdomain`) and a suffix list (`.localhost`, `.local`, `.internal`,
`.home.arpa`). A bare numeric host in any inet_aton form is parsed and classified
as an IP, so `http://2130706433/` is caught here as well.

### 2.3 Loopback

- IPv4: `127.0.0.0/8` — the entire range, not just `127.0.0.1`.
- IPv6: `::1`.

### 2.4 Private IPv4 (RFC1918)

- `10.0.0.0/8`
- `172.16.0.0/12` (i.e. `172.16.0.0`–`172.31.255.255`)
- `192.168.0.0/16`

Also reject the other non-public IPv4 blocks, because "private" in the SSRF sense
means "not routable as a public destination": `0.0.0.0/8`, `100.64.0.0/10`
(CGNAT), `192.0.0.0/24`, `192.0.2.0/24`, `198.18.0.0/15` (benchmarking),
`198.51.100.0/24`, `203.0.113.0/24`, `240.0.0.0/4` (reserved), and
`255.255.255.255` (broadcast).

### 2.5 Link-local

- IPv4: `169.254.0.0/16`.
- IPv6: `fe80::/10`.

The IPv4 link-local block is also where cloud metadata lives, which is why §2.8
overlaps with it.

### 2.6 Multicast

- IPv4: `224.0.0.0/4`.
- IPv6: `ff00::/8`.

### 2.7 Unspecified addresses

- IPv4: `0.0.0.0`.
- IPv6: `::`.

An unspecified address means "this host" to the kernel and is a classic way to
reach the local machine.

**Implemented** — §2.3 to §2.7 are one table-driven check. `classifyIpv4()` walks
`DISALLOWED_V4` in `packages/fetcher/src/ip.ts`, which covers every range named
above plus `192.0.0.0/24`, `192.0.2.0/24`, `198.18.0.0/15`, `198.51.100.0/24`,
and `203.0.113.0/24`. The posture is documented in the module as **deny by
default: anything not provably public is rejected.** IPv6 equivalents live in
`classifyIpv6()`: `::1`, `::`, `fe80::/10`, `fc00::/7` (unique-local, which is
the "private IPv6" range SPEC §18 asks for), and `ff00::/8`.

### 2.8 Cloud metadata

Cloud metadata services are the highest-value SSRF target on a VPS, because they
can hand out instance credentials. Block at minimum:

- `169.254.169.254` — the link-local metadata address used by AWS, Azure, GCP,
  DigitalOcean, and others.
- `169.254.170.2` and `169.254.170.23` — ECS task metadata.
- `fd00:ec2::254` — AWS IMDS over IPv6.
- Hostnames: `metadata.google.internal`, `metadata.goog`.

Because `169.254.0.0/16` is already link-local-blocked (§2.5), the address-level
defence is covered by the range check. The hostname entries must be blocked
separately, and any resolution of those names must also be rejected by the
resolved-IP check.

Any HTTP client setting that follows proxy environment variables
(`HTTP_PROXY`, `ALL_PROXY`, …) must be disabled, because an environment-supplied
proxy could redirect traffic anywhere.

**Implemented, with one honest caveat.** `169.254.0.0/16` is in the
`DISALLOWED_V4` table with the reason string
`link-local / cloud metadata (169.254.0.0/16)`, so `169.254.169.254`,
`169.254.170.2`, and `169.254.170.23` are all rejected as addresses.
`metadata.google.internal` is covered by the `.internal` hostname suffix, which is
broader than the specific name. `metadata.goog` is **not** separately listed —
it would have to resolve to an address that the resolved-IP check rejects to be
blocked, which is not guaranteed. Treat that as a small gap, not as covered.

`fd00:ec2::254` falls inside `fc00::/7` (`fd00::/8` is a subset), so it is
rejected by the unique-local check.

The fetcher builds its requests with `node:http`/`node:https` directly and sets
no proxy agent, so proxy environment variables are not consulted.

### 2.9 DNS resolution and resolved-IP validation

Validating the *hostname* is not enough. The fetcher must:

1. Resolve the hostname itself (via `dns.lookup` or equivalent) rather than
   handing the name to the HTTP stack and hoping.
2. Validate **every** address returned — a hostname may legitimately resolve to
   several addresses, and a single blocked address in the set must reject the
   request, not be silently ignored.
3. Reject the request if resolution fails, if it returns no addresses, or if any
   address is not a public unicast address.

**Implemented.** `resolveAll()` calls `dnsLookup(hostname, { all: true,
verbatim: true })` and returns every A/AAAA record; `validateUrl()` then loops
over the whole set and rejects the request if **any** address fails
`classifyIp()`, with the failure reported as `BLOCKED_URL` and a reason naming
the offending range. A resolution failure or an empty answer set is
`INVALID_URL` with `"hostname did not resolve"`. A literal IP host skips DNS
entirely and is classified directly.

### 2.10 Per-hop redirect validation

Validate **every** hop, not just the original URL. A redirect from an allowed
public host to `http://127.0.0.1:8080/` or `http://169.254.169.254/` must be
rejected at the hop, and the rejection must be reported as `BLOCKED_URL`.

Consequences for the implementation:

- Do not use an HTTP client mode that follows redirects internally. Follow them
  manually, one hop at a time, applying the full validation suite to each
  `Location` before requesting it.
- Resolve a relative `Location` against the current URL before validating it.
- Count hops and stop at `MAX_REDIRECTS` with `REDIRECT_LIMIT`.
- Record the chain, because it is part of the response contract: `Source`
  carries `redirect_chain: string[]`, first URL first.

The fixture server already exposes routes for exactly this
(`/redirect-once`, `/redirect-chain`, `/redirect-loop`,
`/redirect-to-private`, `/redirect-to-metadata`), which is what the redirect
tests are meant to run against.

**Implemented.** `fetchSource()` drives the loop itself — one `requestOnce()`
call per hop — so no HTTP client ever follows a redirect internally. On a
`3xx` with a `Location`, the target is resolved with
`new URL(location, currentUrl)`, then validated with a full `validateUrl()` call
*before* the next request, and a failure throws
`FetchError(hopCheck.code, "redirect blocked: …")`, so a redirect into a private
address surfaces as `BLOCKED_URL`. Each accepted hop is appended to
`redirectChain`, which becomes `Source.redirect_chain`. The loop runs
`hop <= limits.maxRedirects`, and exceeding it throws `REDIRECT_LIMIT`. A
`Location` that will not parse is `UPSTREAM_HTTP_FAILURE`.

### 2.11 DNS rebinding defence

Validating a hostname, then letting a separate resolution happen at connect
time, leaves a TOCTOU window: the attacker's DNS returns a public address for the
validation lookup and a private one for the connection lookup.

The defence is **connect-time revalidation**: establish the connection to an
address that has already been validated, and verify that the address actually
connected to is the one that was validated. Concretely, resolve once, validate
the resulting IP, then pin the connection to that IP (for example via a custom
`lookup` that returns only the validated address, or by connecting to the IP
directly with an explicit `Host` header). Never re-resolve after validation
without re-validating.

**Implemented** with the custom-`lookup` approach. `makeGuardedLookup()` is
passed to `http(s).request`'s `lookup` option, which Node calls immediately
before opening the socket. It resolves the hostname again and re-classifies
**every** returned address; any disallowed address rejects the connection with
`FetchError("SSRF_ATTEMPT", …)`, which propagates out of `req.on("error")`. So a
record that rebinds between validation and connection is caught at connect time,
and the error code distinguishes a rebinding-style attack (`SSRF_ATTEMPT`) from a
statically blocked destination (`BLOCKED_URL`).

### 2.12 Port restrictions

Restrict to an allowlist. `80` and `443` are always required. Any additional port
must be an explicit, deliberate decision. Reject:

- Anything outside the allowlist, with `BLOCKED_URL`.
- Port `0`.
- Ports that address internal services — `22`, `23`, `25`, `445`, `3306`,
  `5432`, `6379`, `9200`, `11211`, `27017`, and the metadata/management ports —
  so a caller cannot use an allowed public host as an internal service scanner.

The hostname may resolve to a public IP and the port may still be dangerous, so
the port check is independent of the address check. Remember that the default
port depends on the scheme (`http` → 80, `https` → 443) and that an explicit
`:80` on an `https` URL is not the default.

**Implemented** as an allowlist rather than a denylist:
`ALLOWED_PORTS = {80, 443, 8080, 8443}`. The default port is derived from the
scheme when `url.port` is empty. A non-integer, `0`, or out-of-range port is
rejected; any port outside the set is `BLOCKED_URL` with
`port <n> is not allowed`. Note that this is an allowlist, so none of the
internal-service ports above can be reached even though they are not individually
enumerated.

Two things to know about this control:

- **`8080` and `8443` are deliberately allowed.** They are common for the
  project's own tooling and for legitimate public services, but they are also
  frequently used by internal admin interfaces. If your deployment does not need
  them, removing them from `ALLOWED_PORTS` narrows the surface at no cost.
- **The port check is skipped for loopback under the test escape** (see
  §3 "test escape" below), because the fixture server binds an ephemeral port.
  With the escape disabled — i.e. in any non-test environment — the allowlist
  applies unconditionally.

### 2.13 Timeouts

Two separate limits, both environment-driven:

- `CONNECT_TIMEOUT_MS` (default `5000`) — connection establishment.
- `REQUEST_TIMEOUT_MS` (default `10000`) — the whole request, headers and body.

A single timeout is not enough: a server that accepts the TCP connection and then
never responds would pass a connect-only limit, and a slow-drip server that sends
one byte per second forever would pass a total-only limit without a body read
deadline. The total timeout must be enforced with an abort signal that actually
destroys the socket, and exceedances map to `TIMEOUT` (HTTP 504).

The fixture server's `/slow` route never responds, precisely so this can be
tested.

**Implemented** with both deadlines. `requestOnce()` sets Node's `timeout` option
to `limits.connectTimeoutMs` and handles `req.on("timeout")`, and separately
starts a `setTimeout(..., limits.requestTimeoutMs)` that destroys the request.
It also accepts an `AbortSignal` (`AbortSignal.any([callerSignal, internal])`) and
aborts on it. All three paths reject with `FetchError("TIMEOUT", …)`, which the
engine maps to HTTP 504. `req.destroy()` is called in every case, so the socket
is actually torn down rather than merely abandoned.

### 2.14 Maximum redirects

`MAX_REDIRECTS` (default `5`). Exceeding it is `REDIRECT_LIMIT`. A redirect loop
must terminate on the hop count, not on a visited-set check alone, because an
attacker can generate unlimited unique URLs.

**Implemented** as a hop counter in the `fetchSource()` loop
(`for (let hop = 0; hop <= limits.maxRedirects; hop++)`), so the fixture's
`/redirect-loop` self-redirect terminates on the count with `REDIRECT_LIMIT`
regardless of how many distinct URLs it could have produced.

### 2.15 Maximum response bytes

`MAX_RESPONSE_BYTES` (default `2097152`, i.e. 2 MiB). Exceeding it is
`RESPONSE_TOO_LARGE`.

Enforce it **while streaming**, not by checking `Content-Length` after the fact:

- Abort the body read as soon as the running byte count exceeds the cap, and
  destroy the socket. Do not buffer first and measure afterwards.
- `Content-Length` is attacker-controlled and may be absent, wrong, or a lie.
- Include headers in the accounting, not just the body.

The fixture server's `/huge` route streams 8 MiB, which is the oversized-response
case.

**Implemented** with both a pre-check and a streaming check.
`Content-Length` is used only as an early rejection when it is *present and*
already over the cap; the authoritative control is the `data` handler, which
counts bytes as they arrive, calls `req.destroy()`, and rejects with
`FetchError("RESPONSE_TOO_LARGE", …)` the moment the running total exceeds
`maxResponseBytes`. A missing, absent, or false `Content-Length` therefore cannot
slip past it.

Two honest notes on the accounting:

- The counter is a **decompressed** byte count, which is the right choice for the
  bomb defence (§2.18) but means the dechunked/normalised size is what is capped,
  not the wire size. Response headers are not included in the count.
- `FetchResult.contentLength` is set to the number of bytes actually read, not
  the header value. Do not read that field as the upstream's declared length.

### 2.16 No shell execution of URLs

**Never pass a raw URL into a shell command.** This is an absolute rule from
SPEC §18 and AGENTS.md §5, and it has no exceptions.

In practice: no `child_process.exec`/`execSync`/`spawn` with a shell anywhere in
the fetch path, no `curl`/`wget`/`openssl` subprocesses driven by caller input,
and no string interpolation of a URL into a command line. The fetcher uses an
in-process HTTP client, so this rule is satisfied by architecture rather than by
escaping. If a subprocess is ever genuinely required, the URL must be passed as
a discrete `argv` element with `shell: false`, never interpolated.

The same principle applies to filesystem paths: do not follow arbitrary local
file references, and do not let a URL influence a path that is read or written.

**Implemented by architecture, and verified.** `packages/fetcher/src/index.ts`
states that nothing in the package executes a shell command or touches the
filesystem, and `fetch.ts` imports only `node:http`, `node:https`, `node:dns`,
`node:zlib`, and a stream type — no `node:child_process`. URLs are never
interpolated into a command line because no command line is ever built. The only
filesystem access in the whole system is the SQLite cache opening its configured
`CACHE_DB_PATH`, which is operator configuration and is never influenced by a
request URL.

### 2.17 Concurrency limits and log sanitisation

**Concurrency.** `MAX_CONCURRENT_FETCHES` (default `4`) bounds simultaneous
outbound fetches process-wide, so one caller cannot consume the VPS. This is
implemented in `EvidenceService` as a counting semaphore: each source acquisition
acquires a slot and releases it in a `finally` block, so a thrown error cannot
leak a slot. The fetcher opens exactly one connection per hop and does not pool
it, so it cannot add unbounded parallelism of its own; it also sends
`connection: close` on every request.

**Log sanitisation.** Never log payment secrets or origin secrets, and never log
complete payment signatures unless specifically required for secure debugging
(SPEC §24). The implemented defence is a redacting structured logger:

- Every line is a single JSON object.
- Any key matching
  `/(secret|token|password|passwd|authorization|cookie|api[_-]?key|private[_-]?key|signature)/i`
  is replaced with `[redacted]` before serialisation, at any depth up to 6.
- Arrays are truncated to 100 entries and objects are depth-bounded, so a
  pathological payload cannot blow up a log line.
- `error` lines go to stderr; everything else to stdout.

The Worker holds the same rule by construction: it logs that a variable is
missing but never its value, and it never logs the secret it attaches to the
outgoing request. The backend adds two practices worth copying: it logs
`req.url.split("?")[0]` so a query string never reaches a log line, and on a
rejected request it logs only that authentication failed — never whether the
header was absent, malformed, or wrong, because that distinction is a hint to an
attacker.

Two things log sanitisation does **not** cover, and must be handled by care:

- Full URLs contain query strings that may carry tokens. The fetcher's
  `safeUrlForMessage()` strips the query string before a URL is embedded in a
  `FetchError` message, which is the pattern to follow. Prefer logging the
  hostname or the cache key over the raw URL anywhere else.
- An error `message` from an upstream library can embed a URL. Review what is
  logged at `warn`/`error` level in the fetch path.

### 2.18 Content-type and decompression

**Content types.** Reject content types the service does not process, with
`UNSUPPORTED_CONTENT` (HTTP 415). SPEC §18 phrases this as *"reject suspicious
content types when unnecessary"*; the working rule is an allowlist of what the
pipeline can actually handle, plus explicit rejection of anything that looks like
a local-execution or archive type. The fixture server's `/binary` route
(`application/octet-stream`) is the test case.

**Decompression bombs.** A compressed response can expand to many gigabytes.
Defences:

- Cap the **decompressed** bytes, not just the bytes on the wire, and count them
  as they are produced rather than after inflation.
- Cap the compression ratio, and reject a response whose declared or observed
  expansion exceeds it.
- Cap nesting depth if multiple encodings are chained.
- Disable transparent decompression in the HTTP client if it cannot be bounded,
  then decompress manually under a streaming byte counter.

The byte cap in §2.15 is not sufficient on its own: a 2 MiB gzip payload can
inflate to several gigabytes.

**Implemented, with an important behavioural difference from the description
above.**

Content types are handled by an **allowlist**: `TEXTUAL` is `text/html`,
`text/plain`, `application/xhtml+xml`, `application/json`,
`application/ld+json`, `text/xml`, `application/xml`, and anything whose MIME type
starts with `text/`. When the content type is not on that list, the fetcher omits
the body (`body: null`) and pushes an `UNSUPPORTED_CONTENT_TYPE` warning; the
`EvidenceService` then fails that source with the public code:

```json
{
  "code": "UNSUPPORTED_CONTENT",
  "message": "The source returned application/octet-stream, which this service does not process."
}
```

An unsupported content type is therefore a **source-level failure**, not a
request failure: the other sources still return, and the failed source keeps its
real upstream status and content type on the record. This is a deliberate-looking design choice — the
source is still recorded with its real status and content type — but it differs
from the plain reading of SPEC §4/§18, so it is called out rather than smoothed
over.

Decompression is handled manually rather than by the client. `accept-encoding:
gzip, deflate, br` is sent, and the response stream is piped through
`createGunzip()`, `createInflate()`, or `createBrotliDecompress()` as
appropriate. The streaming byte counter in §2.15 then counts **post-inflation**
bytes, so a compression bomb is caught by the same cap as an uncompressed
oversized body. That is the essential defence and it is present.

What is **not** implemented from the list above:

- No explicit **compression-ratio** cap. A payload that inflates to just under
  `MAX_RESPONSE_BYTES` is accepted. With a 2 MiB cap the absolute exposure is
  bounded, so this is a resource-efficiency gap rather than a critical one.
- No **nesting-depth** cap. A single `content-encoding` token is matched; a
  chained value such as `gzip, br` does not match any branch and would be passed
  through undecompressed rather than decoded twice.

### 2.19 Encoded and alternate IP representations

Every check in §2.3–§2.8 operates on parsed addresses, never on the caller's
string. Attackers use alternative encodings precisely to slip past string
matching:

- Decimal/`.dword` form: `2130706433` is `127.0.0.1`.
- Octal: `0177.0.0.1`, `017700000001`.
- Hexadecimal: `0x7f.0.0.1`, `0x7f000001`.
- Short forms: `127.1`, `127.0.1`.
- Mixed-radix: `0x7f.1`.
- IPv4-mapped and IPv4-compatible IPv6: `::ffff:127.0.0.1`, `::127.0.0.1`.
- IPv6 with embedded zone or bracket tricks: `[::1]`, `[0:0:0:0:0:0:0:1]`,
  `[::ffff:7f00:1]`.
- Trailing dots and percent-encoding in the hostname: `localhost.`,
  `%6cocalhost`.

The defence is to normalise through a real IP parser and range-check the numeric
result, then apply the same range checks to IPv6 and to IPv4-mapped IPv6
addresses. Recognising a *deliberate* evasion (for example an octal or dword
literal, or a percent-encoded hostname) is what justifies the
`SSRF_ATTEMPT` code rather than the plainer `BLOCKED_URL`.

SPEC §26 requires tests for exactly these classes: encoded bypass attempts and
decimal/octal/hex IP tricks.

**Implemented.** `parseIpv4()` in `packages/fetcher/src/ip.ts` reimplements
inet_aton semantics deliberately: it accepts 1–4 dot-separated parts, detects
`0x…` as hexadecimal and a leading `0` as **octal** (not decimal), and applies
the inet_aton rule that the final part absorbs all remaining bytes — which is what
makes `127.1` and `2130706433` resolve to the same address. The numeric result is
then range-checked, so every alternate spelling of a blocked address lands in the
same check.

IPv6 is expanded by `expandIpv6()`, which handles `::` compression, zone
identifiers (`%eth0`), and a trailing embedded IPv4 (`::ffff:127.0.0.1`) before
classification. IPv4-mapped addresses (`::ffff:0:0/96`) are **unwrapped and
re-checked as IPv4**, so `::ffff:127.0.0.1` is blocked for the same reason
`127.0.0.1` is — the reason string even reads `IPv4-mapped loopback
(127.0.0.0/8)`.

`classifyHostname()` strips a trailing dot before comparison, so `localhost.`
and `LOCALHOST` are caught. Note that percent-encoding (`%6cocalhost`) is
decoded by the WHATWG `URL` parser before `url.hostname` is read, so the
comparison sees `localhost`; there is no separate percent-decoding step because
the parser has already done it.

The `SSRF_ATTEMPT` code is reserved for connect-time revalidation failures
(§2.11). Static rejections at validation time — including alternate-form IP
literals and embedded credentials — are reported as `BLOCKED_URL`. Both are
HTTP 400, so the distinction is informational, not behavioural.

---

## 3. Origin protection

The threat: a caller with a wallet, or without one, skips the Worker and calls
the backend directly, avoiding payment entirely. SPEC §15 requires the design to
prevent that, and warns that obscurity is not security.

### Topology

```text
Internet
   │
   ▼
Cloudflare Worker          ← payment gate, the only public surface
   │
   ▼
protected origin           ← reachable only via the Worker
   │
   ▼
VPS backend (Fastify)      ← POST /internal/v1/evidence, ANY /mcp
```

### The backend is never anonymous

Two independent layers:

1. **Network reachability.** The backend should not be reachable from the public
   internet at all. Preferred: a **Cloudflare Tunnel**, so the origin has no
   inbound public listener and no public DNS record. Acceptable alternative: an
   authenticated origin behind a firewall restricted to Cloudflare's egress
   ranges, with HTTPS and no exposed administrative ports.
2. **Request authentication.** Every internal request must carry a valid
   server-to-server credential. This layer holds even if the network layer is
   misconfigured.

The backend binds `BACKEND_HOST=127.0.0.1` by default in
`packages/core/src/config.ts`, which is loopback-only — the correct default for a
service fronted by a tunnel or a local reverse proxy. Changing it to a public
interface is a deliberate act that must be paired with firewall rules. The Docker
image sets `BACKEND_HOST=0.0.0.0` because a published port reaches the container
IP rather than its loopback, and compensates by publishing the port on host
loopback only (`127.0.0.1:${BACKEND_PORT}:8080` in `docker/docker-compose.yml`).

**Implemented.** The backend enforces request authentication in a Fastify
`onRequest` hook in `apps/backend/src/app.ts`, applied to every path except the
`PUBLIC_PATHS` allowlist — which contains exactly one entry, `/health`
(`apps/backend/src/auth.ts`). Everything else, including all three MCP verbs,
requires the credential. A failure logs only that authentication failed and
replies `401` with the canonical `UNAUTHORIZED` envelope, deliberately giving no
hint about whether the header was absent, malformed, or wrong.

`extractCredential()` accepts the credential from either `x-backend-auth` or a
standard `Authorization: Bearer …` header, so the Worker is not the only
transport that can authenticate.

### Internal endpoint shape

```text
POST /internal/v1/evidence
ANY  /mcp
```

The `/internal/` prefix is a naming convention, not a security control. The
control is the credential check on every one of those routes.

### Fail closed

`BACKEND_AUTH_SECRET` is deliberately **not** defaulted in the configuration
loader:

```ts
// Deliberately NOT defaulted to a value: an empty secret is what makes the
// backend refuse to start (fail closed) rather than run unauthenticated.
backendAuthSecret: str("BACKEND_AUTH_SECRET", ""),
```

`MIN_SECRET_LENGTH` is 16 and `isSecretUsable(secret)` returns false below that.
The backend refuses to start when the secret is absent or too short —
`apps/backend/src/server.ts` checks this **before** binding a socket and calls
`process.exit(1)`, logging the reason and the `openssl rand -hex 32` hint but
never a secret value. An unauthenticated backend is therefore not a reachable
state. At the edge, a missing `BACKEND_ORIGIN_URL` or `BACKEND_AUTH_SECRET`
produces `NOT_CONFIGURED` (HTTP 503), not an unauthenticated forward.

### Response hygiene at the origin

The Worker allow-lists which backend response headers reach the client:
`content-type`, `cache-control: no-store`, `x-request-id`, `payment-response`,
`mcp-session-id`. It does not copy headers wholesale, so an internal header added
by the backend or by an intermediary is not automatically exposed.

### Test escape: the one deliberate relaxation

`packages/fetcher` contains a single escape hatch, and it is worth knowing about
because it is the only place the SSRF posture can be relaxed:

```ts
/** Test-only escape hatch allowing LOOPBACK addresses (127.0.0.0/8, ::1). */
allowLoopbackForTests?: boolean;
```

It exists because the security suite must drive a real fixture server on
`127.0.0.1` with an ephemeral port, which is otherwise blocked by design. Its
guardrails:

- Honoured **only** when `NODE_ENV === "test"`. In any other environment the flag
  is ignored entirely, even if a caller passes it.
- Relaxes **loopback alone** — `127.0.0.0/8`, `::1`, and `::ffff:127.x.x.x`. It
  never relaxes RFC1918, link-local, multicast, or metadata ranges.
- Relaxes the **port** allowlist for a loopback host, because the fixture binds an
  arbitrary port. The port allowlist has its own dedicated coverage in
  `tests/security/ssrf.test.ts` with the escape disabled.
- Is never set by application code.

The risk to watch: this flag must never be reachable from a request. Today it is
a fetch option passed by tests, not by `EvidenceService`, and the `NODE_ENV`
check is an independent second gate. Any future code that threads a
caller-influenced value into it would defeat both.

---

## 4. Shared-secret scheme

SPEC §14 permits a shared secret or HMAC request signing. The chosen mechanism is
a bearer-style shared secret in a custom header.

```http
x-backend-auth: <BACKEND_AUTH_SECRET>
x-request-id: req_3f9c1a7b2e4d4a6f8b0c1d2e
accept: application/json
```

| Property | Value |
|---|---|
| Secret generation | `openssl rand -hex 32` (32 bytes of entropy, 64 hex characters) |
| Minimum length accepted | `MIN_SECRET_LENGTH` = 16 characters |
| Storage | Worker secret binding, set with `wrangler secret put BACKEND_AUTH_SECRET`; backend environment variable |
| Comparison | Constant-time, via SHA-256 digests — implemented (`secretMatches`) |
| Exposure | Never returned to a client, never logged, never committed |
| Scope | Authenticates the Worker to the backend. Not a customer credential. |
| Rotation | Change both sides together; there is no dual-accept window in v0.1.0 |
| Also accepted | `Authorization: Bearer <secret>` as an alternative transport |

The comparison is implemented in `apps/backend/src/auth.ts` as
`timingSafeEqual(digest(provided), digest(expected))`, where `digest` is a SHA-256
of the UTF-8 value. Hashing both sides first is deliberate and the source says
why: `timingSafeEqual` throws when the two buffers differ in length, and a plain
length check before it would leak the secret's length. Comparing fixed-width
digests avoids both problems. An empty or missing credential returns `false`
immediately.

HMAC request signing (signing the method, path, body hash, timestamp, and a nonce
with the shared secret) is a strictly stronger option because it also provides
integrity and replay protection. It is not implemented, and nothing above the
boundary needs to change if it is adopted later. Note that the current scheme is
a bearer token: it authenticates the caller but does not bind the credential to a
specific request body.

### Why this is not an API key

SPEC §11 forbids API keys for paid access, and SPEC §38 forbids accounts. Both
still hold: `BACKEND_AUTH_SECRET` is a single infrastructure secret held by the
service operator, shared between two of their own processes. It is never issued
to a customer, and a customer can never obtain one. Customers authenticate by
paying, per request, with no credential to manage.

---

## 5. Secret handling rules

Non-negotiable, from AGENTS.md §6 and SPEC §11/§14/§24/§32:

1. **Never commit** a private key, seed phrase, wallet secret, origin secret, or
   API token in any form.
2. **Never log** any of the above, nor complete payment signatures.
3. **Never return** a secret to a caller, in a body, a header, or an error
   message.
4. **Never request or store a customer's wallet private key.** The service does
   not need it and must never ask for it.
5. **The recipient wallet needs only its public address.** `X402_RECIPIENT` is
   public by nature — it appears in the x402 payment requirements returned to
   clients. No private key is needed to receive, because the service never signs.
6. **`X402_TEST_PRIVATE_KEY` is Base Sepolia only.** Disposable, local, blank in
   `.env.example`, never funded with mainnet assets, never committed, never used
   with production configuration.
7. **Testnet and production wallet configuration must be clearly separate and
   never mixed.** Different Worker environments, different variables.
8. **No production private key in automated tests.**
9. **Gitignored and never committed:** `.env`, `.env.*` (except
   `.env.example`), `.dev.vars`, `.dev.vars.*` (except `.dev.vars.example`),
   `*.sqlite` and its sidecar files, `data/`, `.wrangler/`.
10. **Templates carry placeholders only.** `.env.example`,
    `docker/env.production.example`, `docker/env.development.example`, and
    `apps/worker/.dev.vars.example` all exist and comply.
11. **Do not fabricate credentials, wallet addresses, or domains.** Use
    `PUBLIC_API_DOMAIN`, `BACKEND_ORIGIN_URL`, `MCP_PUBLIC_URL` and
    `*.example.invalid` placeholders.

### Known secret-hygiene defects in the current tree

One is outstanding and must be fixed before any deployment or publication:

- **`apps/worker/wrangler.jsonc` contains literal test-recipient addresses** in
  its `env.dev` and `env.test` blocks, and the same literal in both. SPEC §33 says
  not to invent a wallet address, and AGENTS.md §6 forbids committing wallet
  configuration. Replace them with placeholders or a documented local-only value.
  (No address is reproduced here — the point is that the file, not this document,
  is where the fix is needed.)

`.dev.vars.example` now exists at `apps/worker/.dev.vars.example` and contains
placeholders only, satisfying SPEC §32.

The fail-closed secret enforcement described in §3 is now implemented and called:
`apps/backend/src/server.ts` checks `isSecretUsable(config.backendAuthSecret)`
before binding and exits non-zero when it fails.

---

## 6. Robots and access behaviour (SPEC §19)

The service retrieves public web evidence. It is not a scraper, and it does not
attempt to defeat any protection.

| Rule | Status |
|---|---|
| Do not bypass access controls | Policy; enforced by not implementing them |
| Do not defeat bot protections | Policy |
| Do not automate login | Policy; no credential handling exists |
| Do not circumvent paywalls | Policy |
| Do not solve CAPTCHAs | Policy; no CAPTCHA technology is present |
| Use a clearly identifiable User-Agent | Configured and sent: `FETCH_USER_AGENT`, default `AgentEvidenceAPI/0.1.0 (+https://example.invalid/bot)`, set as the `user-agent` request header |
| Configurable robots-policy behaviour | Configuration exists and is validated (`ROBOTS_POLICY`); **enforcement is not implemented** |
| Document that users should only submit URLs they may access | Documented here and in the README |
| Keep the MVP on publicly accessible resources | `BACKEND_HOST` loopback by default; the fetcher rejects every non-public address range |

### `ROBOTS_POLICY`

Read in `packages/core/src/config.ts` and validated at load time — an invalid
value makes startup fail with
`ROBOTS_POLICY must be ignore|warn|enforce`. Three intended behaviours:

| Value | Intended behaviour |
|---|---|
| `ignore` | Do not consult `robots.txt`. |
| `warn` | **Default.** Consult `robots.txt`; allow the fetch but attach a warning to the source when the path is disallowed. |
| `enforce` | Refuse to fetch a path disallowed by `robots.txt`. |

**Only the configuration exists.** `config.fetch.robotsPolicy` is parsed and
stored, but nothing reads it: `EvidenceService` passes only `limits` and
`userAgent` into `fetchSource(...)`, and `packages/fetcher` has no `robots.txt`
logic and never requests `/robots.txt`. So the effective behaviour today is
`ignore`, regardless of which value is set — a real gap against SPEC §19's
*"implement a configurable robots-policy behavior where practical"*.

This is worth stating plainly because the default looks like `warn` in every
config file: setting `ROBOTS_POLICY=enforce` currently changes nothing.

The **User-Agent** half of SPEC §19 *is* implemented: `FETCH_USER_AGENT` is sent
as the `user-agent` header on every request, and the fetcher deliberately sends
no cookies and no `referer`.

### About `robots.txt` as a security control

`robots.txt` is an access convention, not an access control. Honouring it is
about courtesy and legitimacy, not about defence. It must never be the thing
standing between a caller and an internal address — that is what §2 is for.

### User-Agent and contactability

`FETCH_USER_AGENT` should identify the service and point at a real page of your
deployment once you have one. `example.invalid` keeps the default obviously fake
until then; do not leave it in production.

---

## 7. Data minimisation and retention (SPEC §20)

Security-adjacent, and worth stating where the controls are described:

- **The cache never stores raw pages.** Only the derived representation —
  extracted document, evidence candidates, response metadata — is retained. This
  bounds both disk growth and the amount of third-party content held.
- **Excerpts are short by design.** `MAX_EXCERPT_CHARS` defaults to `600`, capped
  at `4000` by the schema. The service returns cited evidence, not a content
  dump, which also keeps it from reproducing whole copyrighted documents.
- **Retention is bounded and configurable.** `CACHE_TTL_SECONDS` (default
  `86400`) bounds how long a record lives; `CACHE_MAX_ENTRIES` (default `5000`)
  bounds how many exist; `CACHE_ENABLED` turns the cache off entirely. Expired
  rows are invisible to reads and deleted by `cleanup`, and every write enforces
  the entry cap with deterministic oldest-first eviction.
- **Retrieval time is always truthful.** `retrieved_at` reports the actual
  retrieval time even on a cache hit, and cache hits are flagged with
  `from_cache: true` and a `SERVED_FROM_CACHE` warning. Stale evidence can never
  be presented as fresh.
- **No personal-data functionality.** No profiles, passwords, private messages,
  or restricted data. Public and business information only.
- **SQL is parameterised.** The SQLite adapter prepares every statement and binds
  values as parameters, so no caller-influenced string reaches SQL as syntax.
- **Credentials never reach cache keys or logs.** `cacheKey` drops URL userinfo
  and campaign/tracking parameters, so an embedded credential cannot leak into a
  cache key or a log line.

---

## 8. What is enforced where

| Control | Worker | `@aee/core` | `@aee/extraction` | `@aee/cache` | `@aee/fetcher` | `@aee/backend` |
|---|---|---|---|---|---|---|
| Payment gating (x402) | **yes** | — | — | — | — | — |
| Shallow request shape check | **yes** | yes (authoritative) | — | — | — | — |
| `MAX_URLS_PER_REQUEST` | — | **yes** | — | — | — | — |
| URL de-duplication | — | **yes** | — | — | — | — |
| `MAX_CONCURRENT_FETCHES` semaphore | — | **yes** | — | — | — | — |
| Scheme allowlist, credential-in-URL rejection | — | — | — | — | **yes** | — |
| Hostname / IP range classification (v4 + v6) | — | — | — | — | **yes** | — |
| Resolved-IP validation (all records) | — | — | — | — | **yes** | — |
| Per-hop redirect validation | — | — | — | — | **yes** | — |
| Connect-time revalidation (rebinding) | — | — | — | — | **yes** | — |
| Port allowlist | — | — | — | — | **yes** | — |
| Connect + total timeouts | — | passes config in | — | — | **yes** | — |
| Byte cap while streaming, decompression | — | passes config in | — | — | **yes** | — |
| `ROBOTS_POLICY` enforcement | — | validates config only | — | — | **not implemented** | — |
| Boilerplate removal, bounded links | — | — | **yes** | — | — | — |
| http/https-only link resolution | — | — | **yes** | — | — | — |
| Bounded JSON-LD recursion (depth 8) | — | — | **yes** | — | — | — |
| Date sanity window (1800–2200) | — | — | **yes** | — | — | — |
| Lexical assessment, no invented values | — | **yes** | **yes** | — | — | — |
| Query strings stripped from error messages | — | — | — | — | **yes** | **yes** (log paths) |
| Cache TTL and entry bound | — | **yes** | — | **yes** | — | — |
| Parameterised SQL | — | — | — | **yes** | — | — |
| Log secret redaction | by construction | **yes** | — | — | — | — |
| Error envelope, no stack traces | **yes** | **yes** | — | — | — | **yes** |
| Backend timeout (30 s) | **yes** | — | — | — | — | — |
| Response header allow-list | **yes** | — | — | — | — | — |
| MCP body cap (64 KiB) | **yes** | — | — | — | — | — |
| Request body cap (256 KiB) | — | — | — | — | — | **yes** |
| Shared-secret issuance | **yes** | — | — | — | — | — |
| Shared-secret verification (constant-time) | — | — | — | — | — | **yes** |
| Fail-closed on missing secret | — | helper + constant | — | — | — | **yes** (exit at startup) |
| Unauthenticated-origin refusal | — | — | — | — | — | **yes** (`/health` only is public) |

"not implemented" means the code is absent. "—" means the layer is not
responsible.

No shell execution of URLs is an architectural property, not a per-layer control:
there is no `child_process` import anywhere in `packages/` or `apps/`, and there
must never be one.

---

## 9. Test requirements and current coverage

SPEC §18 requires *"security tests for every one of these classes"*, and SPEC §26
enumerates the cases. The tests run against the deterministic local fixture server
(`tests/fixtures/server.ts`) rather than live websites, and that fixture server
exists with the adversarial routes the SSRF suite needs.

Required test classes:

| Area | Cases |
|---|---|
| URL validation | valid http, valid https, malformed URL, localhost, private IP, IPv6 loopback, metadata endpoint, dangerous port, unsupported scheme, encoded bypass attempts, decimal/octal/hex IP tricks, redirect to private address, DNS rebinding-sensitive cases |
| HTTP | 200, 3xx redirect, redirect chain, 4xx, 5xx, timeout, oversized response, wrong content type, malformed HTML |
| Evidence | relevant source, irrelevant source, conflicting sources, insufficient evidence, multiple sources agreeing |
| Cache | miss, hit, expiration, invalidation, bounded retention |
| x402 | request without payment → 402; valid testnet payment → success |
| MCP | startup, tool listing, tool schema, invocation, paid invocation, payment-required response, successful payment flow, malformed arguments, server error handling |

**Current coverage.** Six test files exist, about 147 cases in total:

| File | Cases | Area |
|---|---|---|
| `tests/security/ssrf.test.ts` | 30 | URL validation and the SSRF classes (§2.1–§2.12, §2.19) |
| `tests/security/limits.test.ts` | 16 | Timeouts, redirect limits, response-size limits (§2.13–§2.15) |
| `tests/e2e/evidence-flow.test.ts` | 18 | Origin protection (401 without/with a wrong secret, `/health` leaks nothing), request validation, and the full evidence pipeline |
| `packages/mcp/src/mcp.test.ts` | 15 | Tool listing, schemas, invocation, malformed arguments, error mapping, log hygiene |
| `packages/extraction/src/extraction.test.ts` | 46 | Metadata, main content, normalisation, hashing, lexical ranking |
| `packages/cache/src/cache.test.ts` | 22 | Cache miss/hit/expiry/invalidation/bounded retention |

That covers the SPEC §26 classes for URL validation, HTTP behaviour, evidence,
cache, and MCP. Still **not** covered:

- **x402** — neither the "request without payment → 402" case nor a valid
  testnet-payment case exists.
- **DNS rebinding** — the connect-time revalidation path has no dedicated test
  that simulates a record changing between validation and connection.
- **Decompression-bomb behaviour** — no test drives a highly compressed payload.

**These files have not been executed in this environment**, so their results are
unknown. Run `pnpm test:security` and `pnpm test` and report the actual output
rather than assuming a pass. `scripts/run-tests.mjs` deliberately exits non-zero
when no test file matches a filter, so a missing suite fails loudly instead of
passing silently.

---

## 10. Known gaps, summarised

Ordered by risk:

1. **No on-chain x402 settlement test.** The 402 gate is covered by an automated
   smoke test, but settlement needs a funded Base Sepolia wallet, which is an
   external credential. Automation proves the gate, not the settlement path.
2. **No DNS-rebinding-specific test.** Connect-time revalidation is implemented
   and runs on every fetch, but a true rebinding test needs control of an
   authoritative DNS server, which is not available in-process. Covered by
   review rather than by a test.
3. **`apps/worker/wrangler.jsonc` carries a throwaway Base Sepolia testnet
   recipient** in `env.dev`/`env.test`. Documented as testnet-only, and
   production keeps a zero placeholder — but a real deployment must set its own.
4. **No rate limiting at the edge.** Limiting is enforced in the backend, keyed
   on `CF-Connecting-IP`; a Worker-level limiter would need Durable Objects,
   which SPEC §13 excludes from the first release.
5. **The port allowlist includes `8080` and `8443`**, which are also common
   internal-interface ports. Narrow it if your deployment does not need them.
6. **No independent security review** has been performed.
10. **No rate limiting implementation exists.** `RATE_LIMIT` (HTTP 429) is defined
    as an error code but nothing produces it; the concurrency semaphore bounds
    resource use but does not rate-limit a caller.
11. **The test-only loopback escape is a live code path.** It requires both
    `NODE_ENV === "test"` and an explicit `allowLoopbackForTests` flag that only
    configuration can set, but any change that threads a caller-influenced value
    into it would defeat two gates at once. Review it in every diff touching the
    fetcher or the config.
12. **The development payment bypass is a live code path.** It is guarded by the
    mainnet check, but any change to that guard weakens the payment boundary.
    Review it in every diff that touches the Worker.
13. **No independent security review has been performed.** The controls are
    implemented and unit-tested in source; nobody has audited them adversarially.

Report these rather than working around them. SPEC §43 and AGENTS.md §2 item 8
are explicit: do not claim success until the flow actually works, and do not
fabricate a passing state.
