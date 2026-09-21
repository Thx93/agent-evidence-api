#!/usr/bin/env node
/**
 * Deterministic fixture server for tests.
 *
 * SPEC section 27 requires a local fixture server rather than depending on live
 * websites. Every route below is stable, offline, and fast. Adversarial routes
 * (redirect-to-private, slow, oversized) exist so the SSRF and limit controls
 * can be tested against a real socket rather than a mock.
 *
 * Run standalone:   node --import tsx tests/fixtures/server.ts
 * Import in tests:  const fx = await startFixtureServer();
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { brotliCompressSync, gzipSync } from "node:zlib";

const COMPANY_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Rotamech Industries — Products</title>
  <meta name="description" content="Rotamech Industries manufactures centrifugal pumps for industrial use.">
  <link rel="canonical" href="/products">
  <meta property="og:title" content="Rotamech Industries">
  <meta property="og:description" content="Industrial centrifugal pump manufacturer.">
  <meta property="og:site_name" content="Rotamech Industries">
  <meta property="article:published_time" content="2024-03-01T09:00:00Z">
  <script type="application/ld+json">
  {"@context":"https://schema.org","@type":"Organization","name":"Rotamech Industries",
   "datePublished":"2024-03-01T09:00:00Z","url":"https://rotamech.example/products"}
  </script>
</head>
<body>
  <nav><a href="/">Home</a><a href="/about">About</a></nav>
  <header><h1>Rotamech Industries</h1></header>
  <main>
    <h2>Products</h2>
    <p>Rotamech Industries is a manufacturer of centrifugal pumps. The company designs and
       produces centrifugal pumps for water treatment, chemical processing and mining.</p>
    <p>Our centrifugal pumps are manufactured in our own facility and shipped worldwide.</p>
    <h2>History</h2>
    <p>Founded in 1978, the company has supplied centrifugal pumps to more than forty countries.</p>
  </main>
  <footer><p>Copyright 2024 Rotamech Industries.</p></footer>
</body>
</html>`;

const NEGATING_HTML = `<!doctype html>
<html lang="en">
<head>
  <title>Registry record for Rotamech</title>
  <meta name="description" content="Registry entry.">
</head>
<body>
  <main>
    <h2>Registry findings</h2>
    <p>Rotamech Industries is not a manufacturer of centrifugal pumps. The registry records the
       company as a distributor and reseller of pumps produced by third parties.</p>
    <p>The company does not operate a manufacturing facility of its own.</p>
  </main>
</body>
</html>`;

const IRRELEVANT_HTML = `<!doctype html>
<html lang="en">
<head><title>Weather forecast</title></head>
<body><main><h2>Forecast</h2>
<p>Light rain is expected across the northern region with moderate winds from the west.</p>
<p>Tomorrow will be cloudy with occasional sunny intervals and a high of eighteen degrees.</p>
</main></body>
</html>`;

const MALFORMED_HTML = `<html><head><title>Unclosed
<body><main><p>Paragraph one<p>Paragraph two<h2>Heading without close
<div><span>Nested without closing`;

/**
 * Content-encoding fixtures (issues: chained encoding, decompression ratio,
 * unknown encoding, content-length semantics).
 *
 * Exported so tests can assert exact wire sizes and the expected decoded text
 * without duplicating the payloads.
 */
export const ENCODED_FIXTURE_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Encoded fixture</title></head>
<body><main><h1>Encoded fixture body</h1>
<p>This body is served with a content-encoding header and must be decoded.</p>
</main></body>
</html>`;

/** gzip(HTML) — the wire payload for the single-encoding route. */
export const GZIP_FIXTURE_BODY = gzipSync(Buffer.from(ENCODED_FIXTURE_HTML, "utf8"));

/** gzip(HTML) then brotli — the wire payload for the chained `gzip, br` route. */
export const GZIP_BR_FIXTURE_BODY = brotliCompressSync(GZIP_FIXTURE_BODY);

/**
 * A small compressed body that expands enormously ("gzip bomb").
 *
 * 8 MiB of a repeated byte compresses to a few kilobytes. It is exactly the
 * scenario the decompression-ratio guard exists for: an absolute
 * `maxResponseBytes` cap of 8 MiB would never be crossed, yet the ratio is
 * roughly 1000:1.
 */
export const DECOMPRESSED_BOMB_BYTES = 8 * 1024 * 1024;
export const GZIP_BOMB_BODY = gzipSync(Buffer.alloc(DECOMPRESSED_BOMB_BYTES, 0x41));

/** A body whose declared encoding this build does not implement. */
export const UNKNOWN_ENCODING_BODY = "Served with an unsupported content-encoding.";

/** Routes are matched by exact pathname. */
function bodyFor(pathname: string): { status: number; type: string; body: string | null } | null {
  switch (pathname) {
    case "/company":
      return { status: 200, type: "text/html; charset=utf-8", body: COMPANY_HTML };
    case "/negating":
      return { status: 200, type: "text/html; charset=utf-8", body: NEGATING_HTML };
    case "/irrelevant":
      return { status: 200, type: "text/html; charset=utf-8", body: IRRELEVANT_HTML };
    case "/malformed":
      return { status: 200, type: "text/html", body: MALFORMED_HTML };
    case "/plain":
      return { status: 200, type: "text/plain; charset=utf-8", body: "Plain text fixture body." };
    case "/json":
      return { status: 200, type: "application/json", body: '{"fixture":true}' };
    case "/binary":
      return { status: 200, type: "application/octet-stream", body: "BINARYDATA" };
    case "/blocked-by-robots":
      return { status: 200, type: "text/html; charset=utf-8", body: COMPANY_HTML };
    case "/empty":
      return { status: 200, type: "text/html", body: "" };
    default:
      return null;
  }
}

export interface FixtureServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startFixtureServer(port = 0): Promise<FixtureServer> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

    // --- redirect fixtures -------------------------------------------------
    if (pathname === "/redirect-once") {
      res.writeHead(302, { location: "/company" });
      return res.end();
    }
    if (pathname === "/redirect-chain") {
      res.writeHead(301, { location: "/redirect-once" });
      return res.end();
    }
    if (pathname === "/redirect-loop") {
      res.writeHead(302, { location: "/redirect-loop" });
      return res.end();
    }
    // Redirects to a private address: the fetcher must reject this hop.
    // Deliberately RFC1918 rather than loopback, because the test-only loopback
    // escape must not make this case pass vacuously.
    if (pathname === "/redirect-to-private") {
      res.writeHead(302, { location: "http://192.168.1.1/company" });
      return res.end();
    }
    if (pathname === "/redirect-to-metadata") {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      return res.end();
    }

    // --- limit fixtures ----------------------------------------------------
    if (pathname === "/slow") {
      // Never responds; the client must time out.
      const timer = setTimeout(() => {
        try {
          res.writeHead(200, { "content-type": "text/html" });
          res.end("<html><body>too late</body></html>");
        } catch {
          /* socket already destroyed */
        }
      }, 60_000);
      // unref so this pending timer cannot keep the test process alive once the
      // client has given up and closed the socket.
      timer.unref();
      res.on("close", () => clearTimeout(timer));
      return;
    }
    if (pathname === "/huge") {
      res.writeHead(200, { "content-type": "text/html" });
      // Stream well past any sane response cap.
      const chunk = "x".repeat(64 * 1024);
      let sent = 0;
      const pump = () => {
        while (sent < 8 * 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) {
            res.once("drain", pump);
            return;
          }
        }
        res.end();
      };
      pump();
      return;
    }

    // --- robots.txt fixtures (SPEC section 19) -----------------------------
    if (pathname === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("User-agent: *\nDisallow: /blocked-by-robots\n");
    }

    // --- status fixtures ---------------------------------------------------
    if (pathname === "/404") {
      res.writeHead(404, { "content-type": "text/html" });
      return res.end("<html><body><h1>Not found</h1></body></html>");
    }
    if (pathname === "/500") {
      res.writeHead(500, { "content-type": "text/html" });
      return res.end("<html><body><h1>Server error</h1></body></html>");
    }

    // --- content-encoding fixtures -----------------------------------------
    if (pathname === "/gzip") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-encoding": "gzip",
        "content-length": String(GZIP_FIXTURE_BODY.length),
      });
      return res.end(GZIP_FIXTURE_BODY);
    }
    if (pathname === "/gzip-br") {
      // Chained: the server applied gzip first, then brotli. The fetcher must
      // undo them in reverse order (br, then gunzip).
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-encoding": "gzip, br",
        "content-length": String(GZIP_BR_FIXTURE_BODY.length),
      });
      return res.end(GZIP_BR_FIXTURE_BODY);
    }
    if (pathname === "/gzip-bomb") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-encoding": "gzip",
        "content-length": String(GZIP_BOMB_BODY.length),
      });
      return res.end(GZIP_BOMB_BODY);
    }
    if (pathname === "/unknown-encoding") {
      // Deliberately sent UNENCODED with a bogus header: the fetcher must not
      // guess, must leave the bytes alone, and must warn.
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-encoding": "x-made-up",
        "content-length": String(Buffer.byteLength(UNKNOWN_ENCODING_BODY)),
      });
      return res.end(UNKNOWN_ENCODING_BODY);
    }
    if (pathname === "/chunked") {
      // No content-length header: Node falls back to chunked transfer, so the
      // response length is genuinely unknown and must be reported as null.
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.write("chunked ");
      res.end("body");
      return;
    }

    const hit = bodyFor(pathname);
    if (hit) {
      res.writeHead(hit.status, { "content-type": hit.type });
      return res.end(hit.body ?? "");
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "no such fixture", path: pathname }));
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Force-close keep-alive and in-flight sockets (e.g. the abandoned /slow
        // request) so the test process exits promptly instead of hanging.
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** Allow `node --import tsx tests/fixtures/server.ts` to run it directly. */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "");

if (invokedDirectly) {
  const fx = await startFixtureServer(Number(process.env.FIXTURE_PORT ?? 0));
  console.log(`[fixtures] listening on ${fx.url}`);
  console.log("[fixtures] routes: /company /negating /irrelevant /malformed /plain /json /binary");
  console.log("[fixtures] adversarial: /redirect-once /redirect-chain /redirect-loop");
  console.log("[fixtures]             /redirect-to-private /redirect-to-metadata /slow /huge");
  console.log("[fixtures] encoding:    /gzip /gzip-br /gzip-bomb /unknown-encoding");
  console.log("[fixtures] status:      /404 /500");
}
