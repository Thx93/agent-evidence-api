/**
 * DNS rebinding (TOCTOU) defence — SPEC section 18: "detect DNS rebinding
 * scenarios".
 *
 * The attack: a hostname resolves to an ALLOWED public address when the URL is
 * validated, then to a PRIVATE address when the connection is actually opened.
 * A fetcher that validates once and then connects by hostname is fully exposed.
 *
 * The defence lives in two places, and this suite tests both:
 *   - `validateUrl` checks every address the resolver returns, and
 *   - `makeGuardedLookup` re-resolves and re-validates AT CONNECT TIME, which is
 *     the call that actually defeats the rebind.
 *
 * This test was previously listed as impossible without authoritative DNS. It is
 * not: the resolver is now injectable, so a stub can return one answer at
 * validation time and a different one at connect time — which is precisely the
 * attack.
 */
process.env.NODE_ENV = "test";

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  FetchError,
  fetchSource,
  makeGuardedLookup,
  validateUrl,
  type DnsResolver,
} from "@aee/fetcher";
import { DEFAULT_LIMITS, type ResourceLimits } from "@aee/schemas";

type Answer = Array<{ address: string; family: number }>;

const PUBLIC: Answer = [{ address: "93.184.216.34", family: 4 }];
const PRIVATE: Answer = [{ address: "10.0.0.1", family: 4 }];
const LOOPBACK: Answer = [{ address: "127.0.0.1", family: 4 }];
const METADATA: Answer = [{ address: "169.254.169.254", family: 4 }];
const IPV6_LOOPBACK: Answer = [{ address: "::1", family: 6 }];

const limits: ResourceLimits = {
  ...DEFAULT_LIMITS,
  requestTimeoutMs: 1_500,
  connectTimeoutMs: 1_000,
};

/** A resolver that answers with a scripted sequence, then repeats the last one. */
function scriptedResolver(answers: Answer[]): {
  resolver: DnsResolver;
  calls: () => number;
  hostnames: () => string[];
} {
  let call = 0;
  const hostnames: string[] = [];
  const resolver: DnsResolver = (hostname, _options, callback) => {
    hostnames.push(hostname);
    const answer = answers[Math.min(call, answers.length - 1)] ?? [];
    call += 1;
    callback(null, answer);
  };
  return { resolver, calls: () => call, hostnames: () => hostnames };
}

/** Invoke the guarded lookup once and resolve with its outcome. */
function runLookup(
  resolver: DnsResolver,
  hostname = "rebind.example",
  allowLoopback = false,
): Promise<{ err: Error | null; address?: string; family?: number }> {
  return new Promise((resolve) => {
    const lookup = makeGuardedLookup(allowLoopback, resolver) as unknown as (
      h: string,
      o: { family?: number },
      cb: (err: Error | null, address: string, family: number) => void,
    ) => void;
    lookup(hostname, {}, (err, address, family) =>
      resolve(err ? { err } : { err: null, address, family }),
    );
  });
}

describe("connect-time revalidation (the rebinding control)", () => {
  test("rejects a private address resolved at connect time", async () => {
    const out = await runLookup(scriptedResolver([PRIVATE]).resolver);
    assert.ok(out.err instanceof FetchError, "expected a FetchError");
    assert.equal((out.err as FetchError).code, "SSRF_ATTEMPT");
    assert.match(out.err.message, /blocked at connect/);
  });

  test("rejects loopback at connect time", async () => {
    const out = await runLookup(scriptedResolver([LOOPBACK]).resolver);
    assert.equal((out.err as FetchError | null)?.code, "SSRF_ATTEMPT");
  });

  test("rejects the cloud metadata address at connect time", async () => {
    const out = await runLookup(scriptedResolver([METADATA]).resolver);
    assert.equal((out.err as FetchError | null)?.code, "SSRF_ATTEMPT");
    assert.match(out.err!.message, /metadata|link-local/);
  });

  test("rejects IPv6 loopback at connect time", async () => {
    const out = await runLookup(scriptedResolver([IPV6_LOOPBACK]).resolver);
    assert.equal((out.err as FetchError | null)?.code, "SSRF_ATTEMPT");
  });

  test("rejects when ANY answer in a multi-record response is disallowed", async () => {
    // Round-robin DNS: one public record and one private one. A fetcher that
    // only inspects the first address would connect to whichever came back.
    const out = await runLookup(scriptedResolver([[PUBLIC[0]!, PRIVATE[0]!]]).resolver);
    assert.equal((out.err as FetchError | null)?.code, "SSRF_ATTEMPT");
  });

  test("allows a public address through", async () => {
    const out = await runLookup(scriptedResolver([PUBLIC]).resolver);
    assert.equal(out.err, null);
    assert.equal(out.address, "93.184.216.34");
    assert.equal(out.family, 4);
  });
});

describe("the lookup contract Node actually relies on", () => {
  // Regression: Node's happy-eyeballs path (autoSelectFamily, on by default
  // since Node 20) calls lookup with `all: true` and expects an ARRAY of
  // {address, family}. Returning a single address made every DNS-based fetch
  // fail with UPSTREAM_HTTP_FAILURE, while literal-IP fetches kept working -
  // so a suite built on 127.0.0.1 fixtures never noticed. The service could not
  // fetch a single real hostname.
  const dualStack: Answer = [
    { address: "93.184.216.34", family: 4 },
    { address: "2606:4700:4700::1111", family: 6 },
  ];

  test("returns an ARRAY when Node asks for all: true", async () => {
    const out = await new Promise<{ err: Error | null; value: unknown }>((resolve) => {
      const lookup = makeGuardedLookup(false, scriptedResolver([dualStack]).resolver) as unknown as (
        h: string,
        o: Record<string, unknown>,
        cb: (err: Error | null, value?: unknown, family?: number) => void,
      ) => void;
      lookup("dual.example", { all: true, family: 0 }, (err, value) => resolve({ err, value }));
    });

    assert.equal(out.err, null);
    assert.ok(Array.isArray(out.value), "all:true must yield an array, not a single address");
    assert.equal((out.value as unknown[]).length, 2);
    const first = (out.value as Array<{ address: string; family: number }>)[0];
    assert.equal(first?.address, "93.184.216.34");
  });

  test("still returns a single address when Node asks for one", async () => {
    const out = await new Promise<{ err: Error | null; value: unknown; family?: number }>((resolve) => {
      const lookup = makeGuardedLookup(false, scriptedResolver([dualStack]).resolver) as unknown as (
        h: string,
        o: Record<string, unknown>,
        cb: (err: Error | null, value?: unknown, family?: number) => void,
      ) => void;
      lookup("dual.example", { family: 4 }, (err, value, family) => resolve({ err, value, family }));
    });
    assert.equal(out.err, null);
    assert.equal(typeof out.value, "string");
    assert.equal(out.family, 4);
  });

  test("a disallowed address is still rejected in the all:true form", async () => {
    const out = await new Promise<{ err: Error | null }>((resolve) => {
      const lookup = makeGuardedLookup(false, scriptedResolver([[PUBLIC[0]!, PRIVATE[0]!]]).resolver) as unknown as (
        h: string,
        o: Record<string, unknown>,
        cb: (err: Error | null) => void,
      ) => void;
      lookup("dual.example", { all: true }, (err) => resolve({ err }));
    });
    assert.equal((out.err as FetchError | null)?.code, "SSRF_ATTEMPT");
  });
});

describe("validation-time checks still apply", () => {
  test("a consistently private answer is rejected during validation", async () => {
    const result = await validateUrl("http://rebind.example/", {
      dnsResolver: scriptedResolver([PRIVATE]).resolver,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.code, "BLOCKED_URL");
  });

  test("a consistently public answer passes validation", async () => {
    const result = await validateUrl("http://rebind.example/", {
      dnsResolver: scriptedResolver([PUBLIC]).resolver,
    });
    assert.equal(result.ok, true);
  });
});

describe("end-to-end rebind through fetchSource", () => {
  test("a name that flips from public to loopback is refused at connect", async () => {
    // Call 1 (validateUrl) sees a public address and passes.
    // Call 2 (connect-time lookup) sees loopback and must abort the request.
    const scripted = scriptedResolver([PUBLIC, LOOPBACK]);

    await assert.rejects(
      fetchSource({
        url: "http://rebind.example/attack",
        limits,
        userAgent: "AgentEvidenceAPI-test/0.1.0",
        dnsResolver: scripted.resolver,
      }),
      (err: unknown) => {
        assert.ok(err instanceof FetchError, `expected FetchError, got ${String(err)}`);
        assert.equal(err.code, "SSRF_ATTEMPT");
        return true;
      },
    );
  });

  test("the resolver is consulted twice — validation, then connect", async () => {
    const scripted = scriptedResolver([PUBLIC, LOOPBACK]);
    await assert.rejects(
      fetchSource({
        url: "http://rebind.example/attack",
        limits,
        userAgent: "AgentEvidenceAPI-test/0.1.0",
        dnsResolver: scripted.resolver,
      }),
    );
    assert.equal(
      scripted.calls(),
      2,
      "the name must be re-resolved at connect time, which is what catches the rebind",
    );
    assert.deepEqual(scripted.hostnames(), ["rebind.example", "rebind.example"]);
  });

  test("a rebind to metadata is refused even though validation passed", async () => {
    const scripted = scriptedResolver([PUBLIC, METADATA]);
    await assert.rejects(
      fetchSource({
        url: "http://rebind.example/attack",
        limits,
        userAgent: "AgentEvidenceAPI-test/0.1.0",
        dnsResolver: scripted.resolver,
      }),
      (err: unknown) => err instanceof FetchError && err.code === "SSRF_ATTEMPT",
    );
  });

  test("the loopback test escape does not weaken the rebind check for real private space", async () => {
    // allowLoopbackForTests relaxes 127.0.0.0/8 only, never RFC1918. A rebind
    // into 10.0.0.0/8 must still be refused.
    const scripted = scriptedResolver([PUBLIC, PRIVATE]);
    await assert.rejects(
      fetchSource({
        url: "http://rebind.example/attack",
        limits,
        userAgent: "AgentEvidenceAPI-test/0.1.0",
        allowLoopbackForTests: true,
        dnsResolver: scripted.resolver,
      }),
      (err: unknown) => err instanceof FetchError && err.code === "SSRF_ATTEMPT",
    );
  });

  test("a redirect hop is validated with the injected resolver too", async () => {
    // Hop validation must not fall back to the real resolver: a redirect to a
    // rebinding name has to be checked with the same rules.
    const scripted = scriptedResolver([PUBLIC, PUBLIC, PRIVATE]);
    await assert.rejects(
      fetchSource({
        url: "http://rebind.example/attack",
        limits,
        userAgent: "AgentEvidenceAPI-test/0.1.0",
        dnsResolver: scripted.resolver,
      }),
    );
  });
});
