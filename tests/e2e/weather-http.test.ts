/**
 * The weather capabilities over plain HTTP.
 *
 * These routes exist because the MCP ones cannot enter the CDP Bazaar - its
 * preflight rejects every MCP input type - so the weather service was absent from
 * the storefront that indexes the Bazaar. Plain HTTP routes pass that preflight:
 * verified live, both answer `valid=true` with zero required failures, and CDP's
 * merchant discovery lists all three resources afterwards.
 *
 * What this suite covers is the part a live check cannot: the input contract, the
 * data mapping, and the rule that a request which could not be served is not
 * charged (an error status cancels settlement, which happens after the handler).
 */
process.env.NODE_ENV = "test";

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EvidenceService, createLogger, loadConfig } from "@aee/core";
import type { EvidenceMcpServer } from "@aee/mcp";
import { buildApp } from "../../apps/backend/src/app.js";
import { ERROR_HTTP_STATUS } from "@aee/schemas";

const SECRET = "test-secret-value-that-is-long-enough";

process.env.BACKEND_AUTH_SECRET = SECRET;
process.env.CACHE_ENABLED = "false";
// The paywall lives in the backend. This suite exercises the weather routes, not
// payment, so it bypasses - which needs BOTH this flag and a non-mainnet network,
// so it cannot make a production deploy free.
process.env.DEV_BYPASS_PAYMENT = "true";
process.env.USAGE_LOG_PATH = `/tmp/aee-weather-usage-${process.pid}.jsonl`;
process.env.LOG_LEVEL = "error";

let app: ReturnType<typeof buildApp>;
const realFetch = globalThis.fetch;

/** The MCP servers are not under test here. */
function stubMcp(): EvidenceMcpServer {
  return {
    handleNodeRequest: async () => undefined,
    listTools: () => [],
    close: async () => undefined,
  };
}
/** Answer the NWS calls the routes make, and nothing else. */
function stubNws(handler: (url: string) => unknown | undefined) {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes("api.weather.gov")) return realFetch(input, init);
    const body = handler(url);
    if (body === undefined) return new Response("upstream down", { status: 503 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/geo+json" },
    });
  }) as typeof fetch;
}

async function post(path: string, body: unknown) {
  return app.inject({
    method: "POST",
    url: path,
    headers: { "x-backend-auth": SECRET },
    payload: body as Record<string, unknown>,
  });
}

before(async () => {
  const config = loadConfig();
  const logger = createLogger("error");
  const service = new EvidenceService({ config, logger });
  // buildApp constructs the weather MCP server itself; only the evidence adapter
  // is supplied, and neither is exercised by these routes.
  app = buildApp({ config, logger, service, mcp: stubMcp() });
  await app.ready();
});

after(async () => {
  globalThis.fetch = realFetch;
  await app.close();
});

beforeEach(() => {
  globalThis.fetch = realFetch;
});

describe("POST /v1/weather/alerts", () => {
  test("returns the NWS alerts for a state", async () => {
    stubNws(() => ({
      features: [
        {
          properties: {
            event: "Flood Advisory",
            areaDesc: "Clay, TX",
            severity: "Minor",
            description: "Minor flooding expected.",
            instruction: "Do not drive through flooded roadways.",
          },
        },
      ],
    }));

    const res = await post("/internal/v1/weather/alerts", { state: "tx" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { alerts: Array<Record<string, unknown>> };
    assert.equal(body.alerts.length, 1);
    assert.equal(body.alerts[0]?.["event"], "Flood Advisory");
    assert.equal(body.alerts[0]?.["severity"], "Minor");
  });

  test("rejects anything that is not a two-letter state code", async () => {
    for (const state of ["", "California", "C1", 42, null]) {
      const res = await post("/internal/v1/weather/alerts", { state });
      assert.equal(res.statusCode, ERROR_HTTP_STATUS.INVALID_REQUEST, `state=${String(state)}`);
    }
  });

  test("an unreachable NWS is an error status, so settlement is cancelled", async () => {
    stubNws(() => undefined);
    const res = await post("/internal/v1/weather/alerts", { state: "CA" });
    assert.equal(res.statusCode, ERROR_HTTP_STATUS.UPSTREAM_HTTP_FAILURE);
    const body = res.json() as { error: { code: string } };
    assert.equal(body.error.code, "UPSTREAM_HTTP_FAILURE");
  });
});

describe("POST /v1/weather/forecast", () => {
  test("returns at most five periods for a point", async () => {
    stubNws((url) =>
      url.includes("/points/")
        ? { properties: { forecast: "https://api.weather.gov/gridpoints/MTR/85,105/forecast" } }
        : {
            properties: {
              periods: Array.from({ length: 7 }, (_, i) => ({
                name: `Period ${i + 1}`,
                temperature: 60 + i,
                temperatureUnit: "F",
                windSpeed: "5 to 10 mph",
                windDirection: "W",
                detailedForecast: "Sunny.",
              })),
            },
          },
    );

    const res = await post("/internal/v1/weather/forecast", {
      latitude: 37.7749,
      longitude: -122.4194,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { periods: Array<Record<string, unknown>>; latitude: number };
    assert.equal(body.periods.length, 5, "the forecast is bounded to five periods");
    assert.equal(body.periods[0]?.["name"], "Period 1");
    assert.equal(body.latitude, 37.7749);
  });

  test("rejects missing or out-of-range coordinates", async () => {
    for (const body of [
      {},
      { latitude: 37.7749 },
      { latitude: 91, longitude: 0 },
      { latitude: 0, longitude: 181 },
      { latitude: "37.77", longitude: "-122.4" },
    ]) {
      const res = await post("/internal/v1/weather/forecast", body);
      assert.equal(res.statusCode, ERROR_HTTP_STATUS.INVALID_REQUEST, JSON.stringify(body));
    }
  });

  test("a location the NWS does not cover is an error status, not a guess", async () => {
    stubNws(() => undefined);
    const res = await post("/internal/v1/weather/forecast", { latitude: 51.5, longitude: -0.12 });
    assert.equal(res.statusCode, ERROR_HTTP_STATUS.UPSTREAM_HTTP_FAILURE);
  });
});
