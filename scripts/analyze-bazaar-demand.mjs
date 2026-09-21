#!/usr/bin/env node
/**
 * The x402 demand map, measured from the whole catalogue rather than a sample.
 *
 *   node scripts/analyze-bazaar-demand.mjs [--refresh]
 *
 * Sources, in order of authority:
 *
 *   CDP Bazaar      https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources
 *                   The only catalogue that publishes REAL usage per resource:
 *                   `quality.l30DaysTotalCalls` and `l30DaysUniquePayers`. It is
 *                   the sole demand evidence in the ecosystem.
 *   PayAI           https://facilitator.payai.network/discovery/resources
 *                   Larger, but publishes no usage numbers, so it is used only to
 *                   cross-check coverage and the MCP shelf.
 *
 * The catalogue earlier rounds sampled at 500 entries. A sample cannot establish
 * "absent" and it cannot size a pool, so this pages everything and reports how much
 * it actually looked at.
 *
 * The snapshot is cached under data/ (gitignored) so repeated analysis is free;
 * `--refresh` re-fetches.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT = join(ROOT, "data", "cdp-bazaar-snapshot.json");
const REFRESH = process.argv.includes("--refresh");

const CDP = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";
const PAGE = 1000;

async function fetchPage(offset) {
  const url = `${CDP}?limit=${PAGE}&offset=${offset}`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw new Error("unreachable");
}

async function snapshot() {
  if (!REFRESH && existsSync(SNAPSHOT)) {
    const cached = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
    console.log(`snapshot: reusing ${cached.items.length} entries from ${cached.fetched_at}`);
    return cached;
  }
  const items = [];
  let total = null;
  for (let offset = 0; ; offset += PAGE) {
    const page = await fetchPage(offset);
    const batch = page.items ?? [];
    total = page.pagination?.total ?? total;
    items.push(...batch);
    process.stderr.write(`\r  fetched ${items.length}${total ? "/" + total : ""}`);
    if (batch.length < PAGE) break;
    if (offset > 60_000) break;
  }
  process.stderr.write("\n");
  const snap = { fetched_at: new Date().toISOString(), total, items };
  mkdirSync(dirname(SNAPSHOT), { recursive: true });
  writeFileSync(SNAPSHOT, JSON.stringify(snap));
  console.log(`snapshot: fetched ${items.length}${total ? "/" + total : ""} entries`);
  return snap;
}

/** Keyword categories. Deliberately overlapping with the earlier analysis so the
 * two are comparable, and applied to tags + description + resource path. */
const CATEGORIES = [
  ["search", [/\bsearch\b/, /\bserp\b/, /google trends/, /\bquery\b/, /web search/, /\bfind\b/]],
  ["retrieval", [/\bretriev/, /\bcontents?\b/, /\bcrawl/, /\bscrape/, /\bextract/, /\bfetch\b/, /\bmarkdown\b/, /\bread (a|the) (web ?page|page|url)/, /\burl/]],
  ["verification", [/\bverif/, /\bevidence\b/, /\bfact.?check/, /\bcitation/, /\bprovenance\b/, /\battest/, /\bclaims?\b/]],
  ["crypto-data", [/\bprice\b/, /\bcandle/, /\bohlc/, /\bswap/, /\bliquidat/, /\byield\b/, /\bgas\b/, /\bwallet\b/, /\bonchain\b/, /\btoken/, /\bblockchain\b/, /\bdex\b/, /\bperp/, /\bfunding rate/, /\btvl\b/, /\bdefi\b/]],
  ["social", [/\btwitter\b/, /\bx\.com\b/, /\breddit/, /\bsocial\b/, /\btelegram/, /\bdiscord/, /\bfarcaster/, /\blinkedin/, /\binstagram/, /\btiktok/, /\byoutube\b/]],
  ["ai-media", [/\bimage\b/, /\bvideo\b/, /\bspeech\b/, /\btranscri/, /\btts\b/, /\bvoice\b/, /\bmusic\b/, /\bgenerat/, /\bllm\b/, /\bchat\b/, /\bcompletion/, /\bembedding/, /\bprompt\b/]],
  ["data-other", [/\bweather\b/, /\bgeocod/, /\bmaps?\b/, /\bflight/, /\bnews\b/, /\bemail\b/, /\benrich/, /\bcompany\b/, /\bpeople\b/, /\btranslate\b/, /\bdns\b/, /\bwhois\b/]],
];

function categorize(item) {
  const hay = [
    item.description ?? "",
    (item.tags ?? []).join(" "),
    item.resource ?? "",
    item.serviceName ?? "",
  ]
    .join(" ")
    .toLowerCase();
  for (const [name, patterns] of CATEGORIES) {
    if (patterns.some((p) => p.test(hay))) return name;
  }
  return "uncategorized";
}

function priceUsd(item) {
  const a = (item.accepts ?? [])[0];
  if (!a || typeof a.amount !== "string") return null;
  const decimals = a.network === "eip155:8453" || String(a.network).includes("8453") ? 6 : 6;
  const n = Number(a.amount) / 10 ** decimals;
  return Number.isFinite(n) ? n : null;
}

function pct(n, d) {
  return d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`;
}

function main(snap) {
  const items = snap.items;
  const withQuality = items.filter((i) => i.quality && typeof i.quality.l30DaysTotalCalls === "number");

  console.log(`\n=== coverage ===`);
  console.log(`resources in catalogue : ${items.length}${snap.total ? ` of ${snap.total}` : ""}`);
  console.log(`with usage data        : ${withQuality.length} (${pct(withQuality.length, items.length)})`);
  console.log(`fetched at             : ${snap.fetched_at}`);

  const totalCalls = withQuality.reduce((n, i) => n + i.quality.l30DaysTotalCalls, 0);
  const totalPayers = withQuality.reduce((n, i) => n + i.quality.l30DaysUniquePayers, 0);
  const zero = withQuality.filter((i) => i.quality.l30DaysTotalCalls === 0).length;
  const zeroPayers = withQuality.filter((i) => (i.quality.l30DaysUniquePayers ?? 0) === 0).length;

  console.log(`\n=== volume, last 30 days (only where usage is published) ===`);
  console.log(`total calls            : ${totalCalls.toLocaleString()}`);
  console.log(`sum of per-service payers: ${totalPayers.toLocaleString()}  (sums double-count a wallet that buys several services)`);
  console.log(`services with 0 calls  : ${zero} (${pct(zero, withQuality.length)})`);
  console.log(`services with 0 payers : ${zeroPayers} (${pct(zeroPayers, withQuality.length)})`);

  // ---- by category ---------------------------------------------------------
  const cat = new Map();
  for (const i of withQuality) {
    const c = categorize(i);
    const e = cat.get(c) ?? { services: 0, calls: 0, payers: 0 };
    e.services += 1;
    e.calls += i.quality.l30DaysTotalCalls;
    e.payers += i.quality.l30DaysUniquePayers ?? 0;
    cat.set(c, e);
  }
  console.log(`\n=== by category (published usage only) ===`);
  console.log(`category        services      calls     payers   calls/svc  calls/payer`);
  for (const [name, e] of [...cat.entries()].sort((a, b) => b[1].calls - a[1].calls)) {
    console.log(
      `${name.padEnd(14)} ${String(e.services).padStart(8)} ${e.calls.toLocaleString().padStart(10)} ` +
        `${e.payers.toLocaleString().padStart(10)} ${(e.calls / e.services).toFixed(0).padStart(10)} ` +
        `${(e.calls / Math.max(e.payers, 1)).toFixed(1).padStart(12)}`,
    );
  }

  // ---- price bands ---------------------------------------------------------
  const bands = [
    ["<$0.003", (p) => p < 0.003],
    ["$0.003-0.01", (p) => p >= 0.003 && p < 0.01],
    ["$0.01-0.03", (p) => p >= 0.01 && p < 0.03],
    ["$0.03-0.10", (p) => p >= 0.03 && p < 0.1],
    [">=$0.10", (p) => p >= 0.1],
  ];
  console.log(`\n=== by price band (published usage only) ===`);
  console.log(`band            services      calls   payers  calls/svc`);
  for (const [label, test] of bands) {
    const set = withQuality.filter((i) => {
      const p = priceUsd(i);
      return p !== null && test(p);
    });
    const calls = set.reduce((n, i) => n + i.quality.l30DaysTotalCalls, 0);
    const payers = set.reduce((n, i) => n + i.quality.l30DaysUniquePayers, 0);
    console.log(
      `${label.padEnd(14)} ${String(set.length).padStart(8)} ${calls.toLocaleString().padStart(10)} ` +
        `${payers.toLocaleString().padStart(8)} ${(calls / Math.max(set.length, 1)).toFixed(0).padStart(10)}`,
    );
  }

  // ---- concentration -------------------------------------------------------
  const sorted = [...withQuality].sort((a, b) => b.quality.l30DaysTotalCalls - a.quality.l30DaysTotalCalls);
  const top = (n) => sorted.slice(0, n).reduce((s, i) => s + i.quality.l30DaysTotalCalls, 0);
  console.log(`\n=== concentration ===`);
  console.log(`top 1 service  : ${pct(top(1), totalCalls)} of all calls`);
  console.log(`top 10 services: ${pct(top(10), totalCalls)} of all calls`);
  console.log(`top 50 services: ${pct(top(50), totalCalls)} of all calls`);
  console.log(`top 100        : ${pct(top(100), totalCalls)} of all calls`);
  console.log(`\nthe 15 busiest resources:`);
  for (const i of sorted.slice(0, 15)) {
    const q = i.quality;
    const p = priceUsd(i);
    console.log(
      `  ${String(q.l30DaysTotalCalls).padStart(7)} calls  ${String(q.l30DaysUniquePayers).padStart(6)} payers  ` +
        `$${(p ?? 0).toFixed(4).padStart(8)}  ${i.resource.slice(0, 68)}`,
    );
  }

  // ---- the pool: wallets that actually paid for something ------------------
  console.log(`\n=== what "the buyer pool" is made of ===`);
  const bigPayers = [...withQuality].sort((a, b) => (b.quality.l30DaysUniquePayers ?? 0) - (a.quality.l30DaysUniquePayers ?? 0));
  console.log(`services with >=100 distinct payers: ${withQuality.filter((i) => (i.quality.l30DaysUniquePayers ?? 0) >= 100).length}`);
  console.log(`services with >=10  distinct payers: ${withQuality.filter((i) => (i.quality.l30DaysUniquePayers ?? 0) >= 10).length}`);
  console.log(`\n  the 10 widest:`);
  for (const i of bigPayers.slice(0, 10)) {
    const p = priceUsd(i);
    console.log(
      `  ${String(i.quality.l30DaysUniquePayers).padStart(6)} payers  ${String(i.quality.l30DaysTotalCalls).padStart(7)} calls  ` +
        `$${(p ?? 0).toFixed(4).padStart(8)}  ${i.resource.slice(0, 60)}`,
    );
  }

  // Machine-readable summary for the docs and for the on-chain step.
  const summary = {
    fetched_at: snap.fetched_at,
    resources: items.length,
    with_usage: withQuality.length,
    total_calls: totalCalls,
    categories: Object.fromEntries([...cat.entries()]),
    top_payto: bigPayers
      .filter((i) => (i.quality.l30DaysUniquePayers ?? 0) > 0)
      .slice(0, 40)
      .map((i) => ({
        payTo: i.accepts?.[0]?.payTo,
        network: i.accepts?.[0]?.network,
        resource: i.resource,
        callers: i.quality.l30DaysUniquePayers,
        calls: i.quality.l30DaysTotalCalls,
        price: priceUsd(i),
      })),
  };
  const out = join(ROOT, "data", "cdp-demand-summary.json");
  writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(`\nsummary written to ${out}`);
}

main(await snapshot());
