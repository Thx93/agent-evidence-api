/**
 * The buyer CLI's OUTPUT paths.
 *
 * This is the artifact a buyer actually runs, and until now only one of its
 * paths had ever been executed: "you have no money". The success path and the
 * "payment accepted but the service failed" path had never run, because testing
 * them appeared to require a funded wallet.
 *
 * They do not. A local mock speaks x402 - a 402 carrying a synthetic challenge,
 * then a 200 or a 502 - and the real bundled CLI does the rest, signing a real
 * payment payload against a throwaway key. Nothing leaves the machine.
 *
 * The shipped bundle is used unmodified except for one line: its advisory
 * balance gate is disabled in a COPY, so execution can reach the code that runs
 * after payment. Everything else is byte-identical to what buyers download.
 */
process.env.NODE_ENV = "test";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLE = fileURLToPath(new URL("../../apps/backend/public/x402-evidence.mjs", import.meta.url));

/** A challenge shaped like the one the live service issues, so no network is needed. */
const CHALLENGE = Buffer.from(
  JSON.stringify({
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        amount: "30000",
        payTo: "0x9c0e2B44180439294Fa30Ae2B2a94f8655455FD0",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        resource: "http://127.0.0.1:8096/v1/evidence",
        description: "Evidence",
        mimeType: "application/json",
        maxTimeoutSeconds: 60,
        extra: { name: "USD Coin", version: "2" },
      },
    ],
  }),
).toString("base64");

const EVIDENCE_OK = {
  request_id: "req_cli_test",
  version: "1",
  question: "Is Rotamech a manufacturer of centrifugal pumps?",
  assessment: { status: "supported", basis: "One source matched." },
  sources: [
    {
      requested_url: "https://example.com/company",
      final_url: "https://example.com/company",
      status: 200,
      content_type: "text/html",
      title: "Rotamech Industries",
      canonical_url: null,
      description: null,
      publisher: "example.com",
      language: "en",
      published_at: null,
      modified_at: null,
      retrieved_at: new Date().toISOString(),
      word_count: 100,
      content_hash_sha256: "a".repeat(64),
      evidence: [{ relevance: "direct", excerpt: "Rotamech manufactures centrifugal pumps.", char_start: 0, char_end: 39 }],
      structured_data: { json_ld: [] },
      warnings: [],
      from_cache: false,
      redirect_chain: [],
    },
  ],
  limitations: [],
  processing_ms: 9,
};

/** Start a mock x402 resource server. `mode` decides what the paid request gets. */
async function startMock(mode: "ok" | "fail"): Promise<{ url: string; close: () => Promise<void>; paid: () => number }> {
  let paidCount = 0;
  const server: Server = createServer((req, res) => {
    if (!req.headers["payment-signature"]) {
      res.writeHead(402, { "content-type": "application/json", "payment-required": CHALLENGE });
      return res.end("{}");
    }
    paidCount += 1;
    if (mode === "fail") {
      res.writeHead(502, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          error: {
            code: "NO_SOURCES_RETRIEVED",
            message: "None of the 2 requested source(s) could be retrieved, so no evidence was produced and no payment will be taken.",
            request_id: "req_cli_test",
          },
        }),
      );
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(EVIDENCE_OK));
  });

  await new Promise<void>((resolve) => server.listen(8096, "127.0.0.1", resolve));
  return {
    url: "http://127.0.0.1:8096/v1/evidence",
    paid: () => paidCount,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let cliPath = "";
before(async () => {
  cliPath = join(await mkdtemp(join(tmpdir(), "aee-cli-")), "cli.mjs");
  const bundle = await readFile(BUNDLE, "utf8");
  // Disable ONLY the advisory balance gate so the post-payment path is reachable.
  const patched = bundle.replace("mm&&rc<BigInt(Ln.amount)", "false&&mm&&rc<BigInt(Ln.amount)");
  assert.notEqual(patched, bundle, "bundle shape changed; the test patch no longer applies");
  await writeFile(cliPath, patched, "utf8");
});

/** Run the CLI and capture both streams. */
function runCli(url: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, "--url", url, "Is Rotamech a manufacturer?", "https://example.com/company"], {
      env: { ...process.env, X402_PRIVATE_KEY: "0x" + "11".repeat(32) },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (out += String(d)));
    child.on("close", (code) => resolve({ code, out }));
  });
}

describe("buyer CLI output", () => {
  test("a successful purchase renders the evidence and the settlement", async () => {
    const mock = await startMock("ok");
    try {
      const { code, out } = await runCli(mock.url);
      assert.equal(mock.paid(), 1, "the CLI must actually retry with a payment");
      assert.equal(code, 0, `expected success, got exit ${code}: ${out.slice(0, 200)}`);
      assert.match(out, /Paid and delivered in \d+ms/);
      assert.match(out, /Assessment: SUPPORTED/);
      assert.match(out, /Rotamech Industries/, "the source title must be shown");
      assert.match(out, /sha256 [0-9a-f]{24}/, "the provenance hash must be shown");
      assert.match(out, /\[direct\]/, "the evidence excerpt must be shown");
    } finally {
      await mock.close();
    }
  });

  test("a failed purchase states plainly that no money was taken", async () => {
    const mock = await startMock("fail");
    try {
      const { code, out } = await runCli(mock.url);
      assert.equal(mock.paid(), 1);
      assert.notEqual(code, 0, "a failed purchase must exit non-zero");
      // The critical property: a buyer who sees "502" must not be left wondering
      // whether they were charged.
      assert.match(out, /NOT been charged/i);
      assert.match(out, /NO_SOURCES_RETRIEVED/, "the canonical code must be surfaced");
      assert.match(out, /None of the 2 requested source/, "the server's explanation must be surfaced");
      assert.ok(!/"request_id":"req_cli_test"\}/.test(out), "raw JSON must not be dumped at the buyer");
    } finally {
      await mock.close();
    }
  });
});
