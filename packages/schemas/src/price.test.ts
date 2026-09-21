import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { priceString, priceAtomicUnits } from "./price.js";

/**
 * Regression tests for sub-cent pricing.
 *
 * The bug these exist for: `priceString` used to end in `toFixed(2)`, so a
 * configured price of 0.003 rendered as "$0.00" and the live paywall asked every
 * buyer for zero USDC. It was invisible for the whole life of the service because
 * $0.03 is the only sub-dollar price two-decimal rounding gets right, and $0.03
 * was the only price ever configured. The first realistic price exposed it.
 */
describe("priceString", () => {
  it("renders a two-decimal price exactly as before", () => {
    assert.equal(priceString("0.03"), "$0.03");
  });

  it("preserves sub-cent prices instead of rounding them to zero", () => {
    // The regression: these all became "$0.00" and charged nothing.
    assert.equal(priceString("0.003"), "$0.003");
    assert.equal(priceString("0.002"), "$0.002");
    assert.equal(priceString("0.005"), "$0.005");
    assert.equal(priceString("0.000001"), "$0.000001");
  });

  it("never renders a price of zero for a positive input", () => {
    for (const v of ["0.000001", "0.001", "0.003", "0.01", "0.03", "0.1", "1", "25"]) {
      const s = priceString(v);
      assert.notEqual(s, "$0", `price ${v} rendered as zero`);
      assert.ok(Number(s.slice(1)) > 0, `price ${v} rendered as ${s}`);
    }
  });

  it("accepts a leading dollar sign and surrounding whitespace", () => {
    assert.equal(priceString("$0.003"), "$0.003");
    assert.equal(priceString(" 0.01 "), "$0.01");
  });

  it("renders whole amounts without a trailing decimal point", () => {
    assert.equal(priceString("1"), "$1");
    assert.equal(priceString("25"), "$25");
  });
});

describe("priceString refuses an unusable price", () => {
  // A payment path must never silently substitute a price. The old code fell back
  // to a hard-coded "$0.03", which would have charged a price nobody configured.
  for (const bad of ["", "0", "0.0", "-1", "abc", "NaN", "Infinity", "$"]) {
    it(`throws for ${JSON.stringify(bad)}`, () => {
      assert.throws(() => priceString(bad), /must be a positive number/);
    });
  }
});

describe("the manifest amount and the challenge string agree", () => {
  // They were computed by two different pieces of code until this was fixed, and
  // they disagreed in production: the manifest said 3000 while the live challenge
  // asked for 0. This asserts the round trip for every price we would plausibly set.
  for (const p of ["0.001", "0.002", "0.003", "0.005", "0.01", "0.03", "0.05", "0.25", "1"]) {
    it(`agrees for ${p}`, () => {
      const units = priceAtomicUnits(p);
      const back = Number(priceString(p).slice(1)) * 1_000_000;
      assert.equal(Math.round(back), Number(units), `${p}: manifest ${units} vs challenge ${back}`);
    });
  }
});
