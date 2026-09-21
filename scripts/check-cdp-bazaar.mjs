// Is this service in the Coinbase CDP Bazaar?
//
// Pages the WHOLE catalogue. An earlier claim of absence rested on a 500-entry
// sample of 15,141, which is not proof of absence - so this scans everything and
// says how much it actually looked at.
const BASE = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";
const NEEDLE = process.argv[2] || "agent-evidence-api";

let off = 0, seen = 0, found = [], total = null, pages = 0;

while (true) {
  let j;
  try {
    const res = await fetch(`${BASE}?limit=250&offset=${off}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    j = await res.json();
  } catch (e) {
    console.error(`  page ${pages}: ${e.message}; retrying once`);
    await new Promise((r) => setTimeout(r, 1500));
    j = await (await fetch(`${BASE}?limit=250&offset=${off}`)).json();
  }
  const items = j.items || [];
  if (total === null) total = j.pagination?.total ?? null;
  if (!items.length) break;

  seen += items.length;
  pages += 1;
  for (const e of items) if (JSON.stringify(e).includes(NEEDLE)) found.push(e);

  if (items.length < 250) break;
  off += 250;
  if (off > 30000) break;
}

const complete = total === null || seen >= total;
console.log(
  `  ${found.length ? `LISTED (${found.length} entry/ies)` : "absent"}` +
  ` — scanned ${seen}${total ? "/" + total : ""} in ${pages} pages` +
  `${complete ? "" : " (INCOMPLETE — treat as unknown)"}`,
);
for (const f of found.slice(0, 3)) {
  console.log(`    ${f.resource}`);
  if (f.quality) console.log(`    calls=${f.quality.l30DaysTotalCalls} payers=${f.quality.l30DaysUniquePayers}`);
}
process.exit(0);
