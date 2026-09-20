/**
 * SSRF and URL-validation security suite (SPEC sections 18 and 26).
 *
 * These tests are network-free by construction: every case is rejected either
 * syntactically or against a literal IP, so nothing here depends on DNS or on
 * reaching a remote host. Network-dependent controls (redirects, timeouts, size
 * limits) are covered in tests/security/limits.test.ts against the local
 * fixture server.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifyHostname, classifyIp, classifyPort, parseIpv4, expandIpv6 } from "@aee/fetcher";
import { validateUrl } from "@aee/fetcher";

/** Assert a URL is refused, and (optionally) with a specific error code. */
async function assertBlocked(url: string, code?: string): Promise<string> {
  const result = await validateUrl(url);
  assert.equal(result.ok, false, `expected ${url} to be blocked`);
  if (!result.ok) {
    if (code) assert.equal(result.code, code, `${url}: expected ${code}, got ${result.code}`);
    return result.reason;
  }
  return "";
}

describe("scheme allowlist", () => {
  test("accepts https", async () => {
    const r = await validateUrl("https://93.184.216.34/");
    assert.equal(r.ok, true);
  });

  test("accepts http", async () => {
    const r = await validateUrl("http://93.184.216.34/");
    assert.equal(r.ok, true);
  });

  for (const bad of [
    "file:///etc/passwd",
    "ftp://example.com/x",
    "gopher://example.com/",
    "data:text/html,<h1>x</h1>",
    "javascript:alert(1)",
    "ws://example.com/",
  ]) {
    test(`rejects ${bad.split(":")[0]}:`, async () => {
      await assertBlocked(bad, "INVALID_URL");
    });
  }
});

describe("malformed input", () => {
  for (const bad of ["", "not a url", "http://", "://example.com", "https:///path"]) {
    test(`rejects ${JSON.stringify(bad)}`, async () => {
      await assertBlocked(bad);
    });
  }
});

describe("credentials in URL", () => {
  test("rejects user:pass@host", async () => {
    await assertBlocked("https://user:secret@93.184.216.34/", "BLOCKED_URL");
  });

  test("rejects user@host", async () => {
    await assertBlocked("https://user@93.184.216.34/", "BLOCKED_URL");
  });
});

describe("loopback and localhost", () => {
  for (const bad of [
    "http://localhost/",
    "http://localhost:8080/",
    "http://LOCALHOST/",
    "http://sub.localhost/",
    "http://ip6-localhost/",
    "http://127.0.0.1/",
    "http://127.1.2.3/",
    "http://127.0.0.1:443/",
    "https://[::1]/",
  ]) {
    test(`rejects ${bad}`, async () => {
      await assertBlocked(bad, "BLOCKED_URL");
    });
  }
});

describe("private and reserved IPv4", () => {
  for (const bad of [
    "http://10.0.0.1/",
    "http://10.255.255.254/",
    "http://172.16.0.1/",
    "http://172.31.255.1/",
    "http://192.168.1.1/",
    "http://192.168.0.1/",
    "http://0.0.0.0/",
    "http://100.64.0.1/",
    "http://198.18.0.1/",
    "http://224.0.0.1/",
    "http://240.0.0.1/",
    "http://255.255.255.255/",
  ]) {
    test(`rejects ${bad}`, async () => {
      await assertBlocked(bad, "BLOCKED_URL");
    });
  }
});

describe("cloud metadata endpoints", () => {
  for (const bad of [
    "http://169.254.169.254/latest/meta-data/",
    "http://169.254.169.254/computeMetadata/v1/",
    "http://169.254.0.1/",
  ]) {
    test(`rejects ${bad}`, async () => {
      const reason = await assertBlocked(bad, "BLOCKED_URL");
      assert.match(reason, /link-local|metadata/i);
    });
  }
});

describe("IPv6", () => {
  for (const bad of [
    "http://[::1]/",
    "http://[::]/",
    "http://[fe80::1]/",
    "http://[fc00::1]/",
    "http://[fd00::1]/",
    "http://[ff02::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:10.0.0.1]/",
    "http://[::ffff:169.254.169.254]/",
  ]) {
    test(`rejects ${bad}`, async () => {
      await assertBlocked(bad, "BLOCKED_URL");
    });
  }

  test("accepts a public IPv6 literal", async () => {
    const r = await validateUrl("http://[2606:4700:4700::1111]/");
    assert.equal(r.ok, true);
  });
});

describe("alternate IP encodings (inet_aton bypasses)", () => {
  test("decimal form of 127.0.0.1", async () => {
    await assertBlocked("http://2130706433/", "BLOCKED_URL");
  });

  test("octal form of 127.0.0.1", async () => {
    await assertBlocked("http://0177.0.0.1/", "BLOCKED_URL");
  });

  test("hex form of 127.0.0.1", async () => {
    await assertBlocked("http://0x7f.0.0.1/", "BLOCKED_URL");
  });

  test("full hex form", async () => {
    await assertBlocked("http://0x7f000001/", "BLOCKED_URL");
  });

  test("short form 127.1", async () => {
    await assertBlocked("http://127.1/", "BLOCKED_URL");
  });

  test("decimal form of 169.254.169.254", async () => {
    await assertBlocked("http://2852039166/", "BLOCKED_URL");
  });

  test("parseIpv4 decodes the legacy forms", () => {
    assert.equal(parseIpv4("127.0.0.1"), 0x7f000001);
    assert.equal(parseIpv4("2130706433"), 0x7f000001);
    assert.equal(parseIpv4("0177.0.0.1"), 0x7f000001);
    assert.equal(parseIpv4("0x7f.0.0.1"), 0x7f000001);
    assert.equal(parseIpv4("0x7f000001"), 0x7f000001);
    assert.equal(parseIpv4("127.1"), 0x7f000001);
    assert.equal(parseIpv4("1.2.3.4.5"), null);
    assert.equal(parseIpv4("999.1.1.1"), null);
  });
});

describe("port restrictions", () => {
  for (const bad of [
    "http://93.184.216.34:22/",
    "http://93.184.216.34:25/",
    "http://93.184.216.34:3306/",
    "http://93.184.216.34:6379/",
    "http://93.184.216.34:9200/",
    "http://93.184.216.34:2375/",
  ]) {
    test(`rejects ${bad}`, async () => {
      await assertBlocked(bad, "BLOCKED_URL");
    });
  }

  test("allows the documented ports", async () => {
    for (const ok of [
      "http://93.184.216.34:80/",
      "https://93.184.216.34:443/",
      "http://93.184.216.34:8080/",
      "https://93.184.216.34:8443/",
    ]) {
      const r = await validateUrl(ok);
      assert.equal(r.ok, true, `expected ${ok} to be allowed`);
    }
    assert.equal(classifyPort(22) !== null, true);
    assert.equal(classifyPort(443), null);
    assert.equal(classifyPort(0) !== null, true);
    assert.equal(classifyPort(70000) !== null, true);
  });
});

describe("internal hostname suffixes", () => {
  for (const bad of [
    "http://db.internal/",
    "http://printer.local/",
    "http://thing.home.arpa/",
    "http://localhost.localdomain/",
  ]) {
    test(`rejects ${bad}`, async () => {
      await assertBlocked(bad, "BLOCKED_URL");
    });
  }

  test("classifyHostname strips a trailing dot before matching", () => {
    assert.notEqual(classifyHostname("localhost."), null);
    assert.notEqual(classifyHostname("db.internal."), null);
    assert.equal(classifyHostname("example.com"), null);
  });
});

describe("address classification primitives", () => {
  test("public IPv4 is allowed", () => {
    assert.equal(classifyIp("93.184.216.34"), null);
    assert.equal(classifyIp("1.1.1.1"), null);
    assert.equal(classifyIp("8.8.8.8"), null);
  });

  test("private ranges are rejected", () => {
    for (const ip of ["10.0.0.1", "172.16.0.1", "192.168.1.1", "127.0.0.1", "169.254.169.254"]) {
      assert.notEqual(classifyIp(ip), null, `${ip} should be rejected`);
    }
  });

  test("expandIpv6 normalises compression", () => {
    assert.deepEqual(expandIpv6("::1"), [0, 0, 0, 0, 0, 0, 0, 1]);
    assert.deepEqual(expandIpv6("2001:db8::1"), [0x2001, 0x0db8, 0, 0, 0, 0, 0, 1]);
    assert.equal(expandIpv6("not:an:ip"), null);
    assert.equal(expandIpv6("1::2::3"), null);
  });

  test("public IPv6 is allowed", () => {
    assert.equal(classifyIp("2606:4700:4700::1111"), null);
  });

  test("non-IP strings are rejected as addresses", () => {
    assert.notEqual(classifyIp("example.com"), null);
    assert.notEqual(classifyIp(""), null);
  });
});

describe("encoded bypass attempts", () => {
  test("percent-encoded host is not silently decoded into an internal name", async () => {
    // The URL parser keeps this as a literal hostname which fails to resolve,
    // and it is never treated as 127.0.0.1.
    const r = await validateUrl("http://%31%32%37.0.0.1/");
    assert.equal(r.ok, false);
  });

  test("uppercase scheme is handled", async () => {
    const r = await validateUrl("HTTP://93.184.216.34/");
    assert.equal(r.ok, true);
  });

  test("hostname case does not defeat the localhost check", async () => {
    await assertBlocked("http://LocalHost/", "BLOCKED_URL");
  });
});
