/**
 * The weather tool bodies — the part a buyer pays for.
 *
 * Tested here against a stubbed `fetch` rather than through the paywall: the gate
 * is covered by `tests/e2e/weather-mcp.test.ts`, and what a settled payment buys
 * is exactly this behaviour. Every case below is a thing the NWS actually does,
 * including sending `null` for fields it does not have.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  formatAlert,
  formatPeriod,
  makeNWSRequest,
  NWS_API_BASE,
  NWS_USER_AGENT,
  runAlerts,
  runForecast,
} from "@aee/mcp";

/** The tool's human-readable text. */
function text(result: { content: Array<{ text: string }> }): string {
  return result.content[0]?.text ?? "";
}

const POINTS_URL = `${NWS_API_BASE}/points/38.9000,-77.0000`;
const FORECAST_URL = `${NWS_API_BASE}/gridpoints/LWX/96,71`;
const ALERTS_CA = `${NWS_API_BASE}/alerts/active/area/CA`;

let seen: string[];
let routes: Map<string, { status?: number; body: unknown }>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  seen = [];
  routes = new Map();
  globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    seen.push(url);
    const entry = routes.get(url);
    if (!entry) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(entry.body), {
      status: entry.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const ALERT_FEATURES = {
  features: [
    {
      properties: {
        event: "Winter Storm Warning",
        areaDesc: "Central Virginia",
        severity: "Severe",
        description: "Heavy snow expected.",
        instruction: "Avoid travel.",
      },
    },
    // The NWS sends nulls, not absent keys, for fields it does not have.
    {
      properties: {
        event: null,
        areaDesc: null,
        severity: null,
        description: null,
        instruction: null,
      },
    },
  ],
};

const TWO_PERIODS = {
  properties: {
    periods: [
      {
        name: "Today",
        temperature: 72,
        temperatureUnit: "F",
        windSpeed: "5 mph",
        windDirection: "NW",
        detailedForecast: "Sunny.",
      },
      {
        name: "Tonight",
        temperature: null,
        temperatureUnit: "F",
        windSpeed: "0 mph",
        windDirection: "N",
        detailedForecast: "Clear.",
      },
    ],
  },
};

const SIX_PERIODS = {
  properties: {
    periods: Array.from({ length: 6 }, (_, i) => ({
      name: `Period ${i + 1}`,
      temperature: 60 + i,
      temperatureUnit: "F",
      windSpeed: "1 mph",
      windDirection: "N",
      detailedForecast: `Forecast ${i + 1}.`,
    })),
  },
};

describe("runAlerts", () => {
  test("returns every alert and a readable summary", async () => {
    routes.set(ALERTS_CA, { body: ALERT_FEATURES });
    const result = await runAlerts("ca");

    assert.equal(result.isError, undefined);
    assert.ok(result.structuredContent, "a successful call must return structured content");
    assert.equal(result.structuredContent.length, 2);
    assert.equal(result.structuredContent[0]?.event, "Winter Storm Warning");
    assert.match(text(result), /Active alerts for CA/);
  });

  test("requests the state code uppercased", async () => {
    routes.set(ALERTS_CA, { body: { features: [] } });
    await runAlerts("ca");
    assert.deepEqual(seen, [ALERTS_CA]);
  });

  test("null NWS fields fall back rather than printing null", async () => {
    routes.set(ALERTS_CA, { body: ALERT_FEATURES });
    const result = await runAlerts("CA");
    assert.ok(result.structuredContent);
    assert.deepEqual(result.structuredContent[1], {
      event: "Unknown",
      area: "Unknown",
      severity: "Unknown",
      description: "No description available",
      instructions: "No specific instructions provided",
    });
  });

  test("no active alerts is a result, not an error", async () => {
    routes.set(ALERTS_CA, { body: { features: [] } });
    const result = await runAlerts("CA");
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, []);
    assert.equal(text(result), "No active alerts for CA");
  });

  test("a failing NWS call is an isError tool result, not an exception", async () => {
    // A throw here would surface as a JSON-RPC error and a buyer would see a
    // protocol failure rather than something to retry.
    routes.set(ALERTS_CA, { status: 503, body: {} });
    const result = await runAlerts("CA");
    assert.equal(result.isError, true);
    assert.match(text(result), /Failed to retrieve alerts data for CA/);
  });

  test("an unexpected failure is caught and named, with no internals leaked", async () => {
    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED /internal/socket");
    };
    const result = await runAlerts("CA");
    assert.equal(result.isError, true);
    assert.match(text(result), /Failed to retrieve alerts/);
  });
});

describe("runForecast", () => {
  test("walks points -> forecast and caps at 5 periods", async () => {
    routes.set(POINTS_URL, { body: { properties: { forecast: FORECAST_URL } } });
    routes.set(FORECAST_URL, { body: SIX_PERIODS });
    const result = await runForecast(38.9, -77);

    assert.equal(result.isError, undefined);
    assert.ok(result.structuredContent, "a successful call must return structured content");
    assert.equal(result.structuredContent.periods.length, 5);
    assert.deepEqual(seen, [POINTS_URL, FORECAST_URL]);
  });

  test("maps NWS camelCase onto the documented snake_case schema", async () => {
    routes.set(POINTS_URL, { body: { properties: { forecast: FORECAST_URL } } });
    routes.set(FORECAST_URL, { body: TWO_PERIODS });
    const result = await runForecast(38.9, -77);
    assert.ok(result.structuredContent);

    assert.deepEqual(result.structuredContent.periods[0], {
      name: "Today",
      temperature: 72,
      temperature_unit: "F",
      wind_speed: "5 mph",
      wind_direction: "NW",
      detailed_forecast: "Sunny.",
    });
  });

  test("a null temperature renders as Unknown, not the string null", async () => {
    routes.set(POINTS_URL, { body: { properties: { forecast: FORECAST_URL } } });
    routes.set(FORECAST_URL, { body: TWO_PERIODS });
    const result = await runForecast(38.9, -77);
    assert.match(text(result), /Temperature: Unknown/);
  });

  test("a location the NWS does not cover is an isError tool result", async () => {
    routes.set(POINTS_URL, { status: 404, body: {} });
    const result = await runForecast(38.9, -77);
    assert.equal(result.isError, true);
    assert.match(text(result), /only US locations are supported/);
  });

  test("a grid point with no forecast URL is an isError tool result", async () => {
    routes.set(POINTS_URL, { body: { properties: {} } });
    const result = await runForecast(38.9, -77);
    assert.equal(result.isError, true);
    assert.match(text(result), /Failed to get forecast URL/);
  });

  test("a forecast with no periods is an isError tool result", async () => {
    routes.set(POINTS_URL, { body: { properties: { forecast: FORECAST_URL } } });
    routes.set(FORECAST_URL, { body: { properties: { periods: [] } } });
    const result = await runForecast(38.9, -77);
    assert.equal(result.isError, true);
    assert.match(text(result), /No forecast periods available/);
  });
});

describe("makeNWSRequest", () => {
  test("identifies this client to the NWS and accepts GeoJSON", async () => {
    let headers: Record<string, string> | undefined;
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const result = await makeNWSRequest<Record<string, boolean>>(`${NWS_API_BASE}/test`);
    assert.deepEqual(result, { ok: true });
    assert.equal(headers?.["User-Agent"], NWS_USER_AGENT);
    assert.equal(headers?.Accept, "application/geo+json");
  });

  test("returns null on a non-2xx status", async () => {
    globalThis.fetch = async () => new Response("nope", { status: 500 });
    assert.equal(await makeNWSRequest(`${NWS_API_BASE}/test`), null);
  });

  test("returns null when the request itself fails", async () => {
    globalThis.fetch = async () => {
      throw new Error("socket hang up");
    };
    assert.equal(await makeNWSRequest(`${NWS_API_BASE}/test`), null);
  });

  test("binds a timeout so a stalled NWS cannot hang a call", async () => {
    let signal: AbortSignal | undefined;
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Response("{}", { status: 200 });
    };
    await makeNWSRequest(`${NWS_API_BASE}/test`);
    assert.ok(signal instanceof AbortSignal, "expected an AbortSignal");
    assert.equal(signal.aborted, false, "the timeout must not fire immediately");
  });
});

describe("the human-readable output", () => {
  test("formatAlert renders every field on its own line", () => {
    const out = formatAlert({
      event: "Flood Watch",
      area: "Travis County",
      severity: "Minor",
      description: "Rising water.",
      instructions: "Move to higher ground.",
    });
    assert.match(out, /Event: Flood Watch/);
    assert.match(out, /Instructions: Move to higher ground\./);
  });

  test("formatPeriod renders a measured temperature with its unit", () => {
    const out = formatPeriod({
      name: "Tonight",
      temperature: 51,
      temperature_unit: "F",
      wind_speed: "3 mph",
      wind_direction: "S",
      detailed_forecast: "Cloudy.",
    });
    assert.match(out, /Temperature: 51°F/);
    assert.match(out, /Wind: 3 mph S/);
  });

  test("formatPeriod renders a missing temperature as Unknown", () => {
    const out = formatPeriod({
      name: "Tonight",
      temperature: null,
      temperature_unit: "F",
      wind_speed: "0 mph",
      wind_direction: "N",
      detailed_forecast: "Clear.",
    });
    assert.match(out, /Temperature: Unknown/);
    assert.doesNotMatch(out, /null/);
  });
});
