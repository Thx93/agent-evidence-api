/**
 * Unit tests for @aee/extraction.
 *
 * Uses Node's built-in test runner with inline HTML fixtures only: no network,
 * no fixture server, no clock, no randomness (AGENTS.md section 8, SPEC §26).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  extractDocument,
  findEvidenceCandidates,
  hashContent,
  hasNegationCue,
  normalizeText,
} from "./index.js";

const FINAL_URL = "https://example.com/reports/q3";

/** Kitchen-sink fixture exercising metadata, stripping, blocks, and links. */
const FULL_HTML = `<!doctype html>
<html lang="en-GB">
  <head>
    <meta charset="utf-8">
    <title>Acme Quarterly Report</title>
    <meta name="description" content="How Acme grew in Q3.">
    <meta name="application-name" content="Acme App">
    <link rel="canonical" href="/reports/q3">
    <meta property="og:title" content="OG Acme">
    <meta property="og:description" content="OG description">
    <meta property="og:site_name" content="Acme Corp">
    <meta property="og:type" content="article">
    <meta property="article:published_time" content="2024-07-01T09:30:00Z">
    <script type="application/ld+json">
      {"@context":"https://schema.org","@type":"NewsArticle","datePublished":"2024-06-15","dateModified":"2024-08-20T11:00:00Z"}
    </script>
    <script type="application/ld+json">{ this is not valid json ]</script>
    <script type="application/ld+json">["first", "second"]</script>
  </head>
  <body>
    <nav><p>Navigation paragraph.</p></nav>
    <header><h1>Site header</h1></header>
    <main>
      <h1>Quarterly report</h1>
      <script>var tracking = "TrackingScriptText";</script>
      <h2>Products</h2>
      <p>Acme shipped four new products this quarter.</p>
      <div role="navigation"><p>Role navigation text.</p></div>
      <p>Acme revenue rose to 12 million dollars, up 20 percent year over year.</p>
      <div aria-hidden="true"><p>Aria hidden text.</p></div>
      <div hidden><p>Hidden attribute text.</p></div>
      <form><p>Form text.</p></form>
      <svg><text>Svg text.</text></svg>
      <iframe src="https://ads.example/frame"></iframe>
      <h4>Sub detail</h4>
      <p>Ignored deep heading example.</p>
      <p><a href="/reports/q3">Full report</a> and <a href="/reports/q3">duplicate</a> and
        <a href="https://other.example/page#frag">external</a> and
        <a href="mailto:someone@example.com">mail</a> and
        <a href="javascript:void(0)">js</a>.</p>
    </main>
    <aside><p>Aside promo text.</p></aside>
    <footer><p>Footer boilerplate.</p></footer>
  </body>
</html>`;

describe("extractDocument metadata", () => {
  const doc = extractDocument(FULL_HTML, FINAL_URL);

  test("title comes from <title>", () => {
    assert.equal(doc.title, "Acme Quarterly Report");
  });

  test("description comes from meta[name=description]", () => {
    assert.equal(doc.description, "How Acme grew in Q3.");
  });

  test("canonical is resolved against finalUrl", () => {
    assert.equal(doc.canonicalUrl, "https://example.com/reports/q3");
  });

  test("language is preserved as given (en-GB)", () => {
    assert.equal(doc.language, "en-GB");
  });

  test("Open Graph keys have no og: prefix", () => {
    assert.deepEqual(doc.openGraph, {
      title: "OG Acme",
      description: "OG description",
      site_name: "Acme Corp",
      type: "article",
    });
    assert.ok(!Object.keys(doc.openGraph).some((key) => key.startsWith("og:")));
  });

  test("publisher prefers og:site_name", () => {
    assert.equal(doc.publisher, "Acme Corp");
  });

  test("JSON-LD parses valid blocks and silently skips malformed ones", () => {
    assert.equal(doc.jsonLd.length, 2);
    assert.deepEqual(doc.jsonLd[0], {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      datePublished: "2024-06-15",
      dateModified: "2024-08-20T11:00:00Z",
    });
    assert.deepEqual(doc.jsonLd[1], ["first", "second"]);
    assert.ok(!JSON.stringify(doc.jsonLd).includes("not valid json"));
  });
});

describe("extractDocument fallbacks", () => {
  test("title and description fall back to Open Graph", () => {
    const html = `<html><head>
      <meta property="og:title" content="OG Only">
      <meta property="og:description" content="OG only description">
    </head><body><main><p>Body text.</p></main></body></html>`;
    const doc = extractDocument(html, "https://example.com/a");
    assert.equal(doc.title, "OG Only");
    assert.equal(doc.description, "OG only description");
  });

  test("missing canonical yields null", () => {
    const doc = extractDocument("<html><body><p>x</p></body></html>", "https://example.com/a");
    assert.equal(doc.canonicalUrl, null);
  });

  test("non-http canonical yields null", () => {
    const html = `<html><head><link rel="canonical" href="mailto:someone@example.com"></head>
      <body><p>x</p></body></html>`;
    const doc = extractDocument(html, "https://example.com/a");
    assert.equal(doc.canonicalUrl, null);
  });

  test("unresolvable canonical with an invalid finalUrl yields null", () => {
    const html = `<html><head><link rel="canonical" href="/relative"></head><body><p>x</p></body></html>`;
    const doc = extractDocument(html, "not a url");
    assert.equal(doc.canonicalUrl, null);
  });

  test("empty language attribute yields null", () => {
    const doc = extractDocument(`<html lang="  "><body><p>x</p></body></html>`, "https://example.com/a");
    assert.equal(doc.language, null);
  });

  test("absent language attribute yields null", () => {
    const doc = extractDocument("<html><body><p>x</p></body></html>", "https://example.com/a");
    assert.equal(doc.language, null);
  });

  test("publisher falls back to meta application-name, then hostname", () => {
    const withAppName = `<html><head><meta name="application-name" content="Acme App"></head>
      <body><p>x</p></body></html>`;
    assert.equal(extractDocument(withAppName, "https://example.com/a").publisher, "Acme App");

    const bare = "<html><body><p>x</p></body></html>";
    assert.equal(extractDocument(bare, "https://news.example.org/a").publisher, "news.example.org");
    assert.equal(extractDocument(bare, "not a url").publisher, null);
  });
});

describe("extractDocument dates", () => {
  const wrap = (head: string): string => `<html><head>${head}</head><body><p>x</p></body></html>`;

  test("JSON-LD datePublished/dateModified are normalised to ISO 8601", () => {
    const doc = extractDocument(FULL_HTML, FINAL_URL);
    assert.equal(doc.publishedAt, "2024-06-15T00:00:00.000Z");
    assert.equal(doc.modifiedAt, "2024-08-20T11:00:00.000Z");
  });

  test("JSON-LD wins over meta tags", () => {
    const head = `<script type="application/ld+json">{"datePublished":"2020-01-02"}</script>
      <meta property="article:published_time" content="2024-07-01T09:30:00Z">`;
    const doc = extractDocument(wrap(head), FINAL_URL);
    assert.equal(doc.publishedAt, "2020-01-02T00:00:00.000Z");
  });

  test("article:published_time and article:modified_time are used as fallbacks", () => {
    const head = `<meta property="article:published_time" content="2023-05-05T10:00:00+02:00">
      <meta property="article:modified_time" content="2023-06-06T10:00:00Z">`;
    const doc = extractDocument(wrap(head), FINAL_URL);
    assert.equal(doc.publishedAt, "2023-05-05T08:00:00.000Z");
    assert.equal(doc.modifiedAt, "2023-06-06T10:00:00.000Z");
  });

  test("meta[name=date] and <time datetime> are published-date fallbacks", () => {
    assert.equal(
      extractDocument(wrap(`<meta name="date" content="2021-03-04">`), FINAL_URL).publishedAt,
      "2021-03-04T00:00:00.000Z",
    );
    assert.equal(
      extractDocument(wrap(`<time datetime="2022-02-02">Feb 2022</time>`), FINAL_URL).publishedAt,
      "2022-02-02T00:00:00.000Z",
    );
  });

  test("an unparseable date yields null, never an invented value", () => {
    const head = `<meta property="article:published_time" content="sometime last spring">`;
    const doc = extractDocument(wrap(head), FINAL_URL);
    assert.equal(doc.publishedAt, null);
    assert.equal(doc.modifiedAt, null);
  });

  test("a generic published date is never reused as modifiedAt", () => {
    const head = `<meta name="date" content="2021-03-04">`;
    const doc = extractDocument(wrap(head), FINAL_URL);
    assert.equal(doc.publishedAt, "2021-03-04T00:00:00.000Z");
    assert.equal(doc.modifiedAt, null);
  });
});

describe("extractDocument main content", () => {
  const doc = extractDocument(FULL_HTML, FINAL_URL);

  test("blocks are newline-separated in document order", () => {
    assert.equal(
      doc.mainText,
      [
        "Quarterly report",
        "Products",
        "Acme shipped four new products this quarter.",
        "Acme revenue rose to 12 million dollars, up 20 percent year over year.",
        "Sub detail",
        "Ignored deep heading example.",
        "Full report and duplicate and external and mail and js.",
      ].join("\n"),
    );
  });

  test("nav, header, aside, footer, script, and hidden content are excluded", () => {
    for (const excluded of [
      "Navigation paragraph.",
      "Site header",
      "TrackingScriptText",
      "Role navigation text.",
      "Aria hidden text.",
      "Hidden attribute text.",
      "Form text.",
      "Svg text.",
      "Aside promo text.",
      "Footer boilerplate.",
    ]) {
      assert.ok(!doc.mainText.includes(excluded), `mainText should exclude: ${excluded}`);
    }
  });

  test("wordCount equals whitespace-split tokens of mainText", () => {
    assert.equal(doc.wordCount, doc.mainText.split(/\s+/).filter(Boolean).length);

    const small = extractDocument(
      "<html><body><main><p>one two three four five</p></main></body></html>",
      "https://example.com/a",
    );
    assert.equal(small.mainText, "one two three four five");
    assert.equal(small.wordCount, 5);
  });

  test("empty documents produce empty text and a hash of the empty string", () => {
    const doc = extractDocument("", "https://example.com/a");
    assert.equal(doc.mainText, "");
    assert.equal(doc.wordCount, 0);
    assert.equal(doc.contentHashSha256, hashContent(""));
  });

  test("fell back to the densest div when no semantic container exists", () => {
    const html = `<html><body>
      <div><p>short</p></div>
      <div><p>The longest paragraph of the page lives here and carries the content.</p></div>
    </body></html>`;
    const doc = extractDocument(html, "https://example.com/a");
    assert.equal(doc.mainText, "The longest paragraph of the page lives here and carries the content.");
  });
});

describe("extractDocument headings", () => {
  const doc = extractDocument(FULL_HTML, FINAL_URL);

  test("h1-h3 are captured with level and normalised text; h4 is ignored", () => {
    assert.deepEqual(doc.headings, [
      { level: 1, text: "Quarterly report" },
      { level: 2, text: "Products" },
    ]);
  });

  test("headings with only whitespace are dropped", () => {
    const doc = extractDocument(
      "<html><body><main><h1>  </h1><h2> Real </h2></main></body></html>",
      "https://example.com/a",
    );
    assert.deepEqual(doc.headings, [{ level: 2, text: "Real" }]);
  });
});

describe("extractDocument links", () => {
  const doc = extractDocument(FULL_HTML, FINAL_URL);

  test("links are absolute, de-duplicated, and http(s) only", () => {
    assert.deepEqual(doc.links, [
      "https://example.com/reports/q3",
      "https://other.example/page",
    ]);
  });

  test("maxLinks bounds the result", () => {
    const html = `<html><body><main><p>
      <a href="/1">1</a><a href="/2">2</a><a href="/3">3</a><a href="/4">4</a><a href="/5">5</a>
    </p></main></body></html>`;
    const bounded = extractDocument(html, "https://example.com/a", { maxLinks: 2 });
    assert.deepEqual(bounded.links, ["https://example.com/1", "https://example.com/2"]);

    const zero = extractDocument(html, "https://example.com/a", { maxLinks: 0 });
    assert.deepEqual(zero.links, []);
  });
});

describe("normalizeText", () => {
  test("collapses whitespace and normalises line endings", () => {
    assert.equal(normalizeText("  Hello\r\n\r\nWorld  "), "Hello World");
    assert.equal(normalizeText("a\t\tb\nc"), "a b c");
    assert.equal(normalizeText("\r lone carriage return"), "lone carriage return");
  });

  test("strips control characters without gluing words together", () => {
    assert.equal(normalizeText("foo\u0000bar"), "foo bar");
    assert.equal(normalizeText("\u0007bell\u009f"), "bell");
  });

  test("is idempotent", () => {
    const once = normalizeText(" Multiple   spaces \r\n and newlines ");
    assert.equal(normalizeText(once), once);
  });
});

describe("hashContent", () => {
  test("matches the known sha256 of \"abc\"", () => {
    assert.equal(hashContent("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("is deterministic for the same input and differs for different input", () => {
    assert.equal(hashContent("same text"), hashContent("same text"));
    assert.notEqual(hashContent("same text"), hashContent("same text."));
  });

  test("contentHashSha256 hashes the normalised main text", () => {
    const doc = extractDocument(FULL_HTML, FINAL_URL);
    assert.equal(doc.contentHashSha256, hashContent(doc.mainText));
    assert.match(doc.contentHashSha256, /^[0-9a-f]{64}$/);
  });
});

describe("findEvidenceCandidates", () => {
  const html = `<html><body><main>
    <h2>Products</h2>
    <p>Acme shipped four new products this quarter.</p>
    <p>The quantum computing research division published a paper on error correction.</p>
  </main></body></html>`;
  const doc = extractDocument(html, "https://example.com/a");
  const question = "What did the quantum computing research division publish?";

  test("ranks the matching paragraph first and drops non-matching ones", () => {
    const candidates = findEvidenceCandidates(doc, question, { maxItems: 5, maxExcerptChars: 600 });
    assert.equal(candidates.length, 1);
    const [first] = candidates;
    assert.ok(first);
    assert.match(first.excerpt, /quantum computing research division/);
    assert.equal(first.relevance, "direct");
    assert.equal(first.context, "h2:Products > p[2]");
    assert.ok(first.score > 0);
  });

  test("returns an empty array when nothing matches", () => {
    const candidates = findEvidenceCandidates(doc, "antarctic penguin migration", {
      maxItems: 5,
      maxExcerptChars: 600,
    });
    assert.deepEqual(candidates, []);
  });

  test("returns an empty array when maxItems is zero", () => {
    assert.deepEqual(findEvidenceCandidates(doc, question, { maxItems: 0, maxExcerptChars: 600 }), []);
  });

  test("is deterministic across repeated calls", () => {
    const first = findEvidenceCandidates(doc, question, { maxItems: 5, maxExcerptChars: 600 });
    const second = findEvidenceCandidates(doc, question, { maxItems: 5, maxExcerptChars: 600 });
    assert.deepEqual(first, second);
  });

  test("stable ties fall back to document order", () => {
    const tied = extractDocument(
      `<html><body><main>
        <p>Wombat habitat restoration.</p>
        <p>Wombat habitat protection.</p>
      </main></body></html>`,
      "https://example.com/a",
    );
    const candidates = findEvidenceCandidates(tied, "wombat habitat", {
      maxItems: 5,
      maxExcerptChars: 600,
    });
    assert.equal(candidates.length, 2);
    assert.equal(candidates[0]?.excerpt, "Wombat habitat restoration.");
    assert.equal(candidates[1]?.excerpt, "Wombat habitat protection.");
  });

  test("truncates on a word boundary with an ellipsis only when needed", () => {
    const candidates = findEvidenceCandidates(doc, question, { maxItems: 5, maxExcerptChars: 24 });
    const [first] = candidates;
    assert.ok(first);
    assert.ok(first.excerpt.endsWith("\u2026"));
    assert.ok(first.excerpt.length <= 25);
    assert.ok(!first.excerpt.includes("  "));

    const whole = findEvidenceCandidates(doc, question, { maxItems: 5, maxExcerptChars: 600 })[0];
    assert.ok(whole);
    assert.ok(!whole.excerpt.endsWith("\u2026"));
  });

  test("never emits contradictory; only direct or supporting", () => {
    const candidates = findEvidenceCandidates(doc, question, { maxItems: 5, maxExcerptChars: 600 });
    for (const candidate of candidates) {
      assert.ok(["direct", "supporting", "context"].includes(candidate.relevance));
      assert.notEqual(candidate.relevance, "contradictory");
    }
  });

  test("a weak secondary match is labelled supporting and ranked below direct", () => {
    const mixed = extractDocument(
      `<html><body><main>
        <p>The quantum computing research division published its findings.</p>
        <p>Separately, the division moved offices.</p>
      </main></body></html>`,
      "https://example.com/a",
    );
    const candidates = findEvidenceCandidates(mixed, "quantum computing research division published", {
      maxItems: 5,
      maxExcerptChars: 600,
    });
    assert.equal(candidates[0]?.relevance, "direct");
    assert.equal(candidates[1]?.relevance, "supporting");
    assert.ok((candidates[0]?.score ?? 0) > (candidates[1]?.score ?? 0));
  });
});

describe("hasNegationCue", () => {
  test("detects documented negation and contrast cues", () => {
    for (const text of [
      "The company denies the report.",
      "Production has not resumed.",
      "The claim is false.",
      "Sales never recovered.",
      "The service no longer operates.",
      "Output ceased in March.",
      "The ministry refuted the allegation.",
    ]) {
      assert.equal(hasNegationCue(text), true, `expected a cue in: ${text}`);
    }
  });

  test("does not fire on plain affirmative text or substrings", () => {
    for (const text of [
      "Revenue increased sharply.",
      "This is a notable improvement.",
      "The northern region expanded.",
    ]) {
      assert.equal(hasNegationCue(text), false, `unexpected cue in: ${text}`);
    }
    assert.equal(hasNegationCue(""), false);
  });

  test("recognises the explicit 'nothing' cue", () => {
    assert.equal(hasNegationCue("Nothing changed."), true);
  });
});
