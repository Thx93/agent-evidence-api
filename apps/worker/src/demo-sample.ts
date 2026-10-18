/**
 * A real evidence package, produced by a real paid call to this service, served
 * publicly so a visitor can judge the output before spending anything.
 *
 * This is not a mock-up. It is the verbatim response to:
 *   "Did the EU AI Act enter into force in August 2024?"
 *        https://artificialintelligenceact.eu/implementation-timeline/
 * fetched live, settled on-chain, and captured on 2026-10-18.
 *
 * Why it exists: the only way to evaluate this service used to be to fund a
 * wallet, install a client and pay before seeing a single byte of output. That is
 * too much friction for a human deciding whether the thing is any good, and no
 * amount of directory listings fixes it. A free sample does.
 *
 * Per SPEC section 24 it holds only what the service normally returns: public
 * page content, already published by the source. No customer data is involved
 * because the operator asked the question.
 */
export const DEMO_SAMPLE = {
  "request_id": "req_2c2c13159b1f41f0b7343f47",
  "version": "1",
  "question": "Did the EU AI Act enter into force in August 2024?",
  "assessment": {
    "status": "supported",
    "basis": "1 source(s) contained passages matching the question (artificialintelligenceact.eu) with no contradicting passages found."
  },
  "sources": [
    {
      "requested_url": "https://artificialintelligenceact.eu/implementation-timeline/",
      "final_url": "https://artificialintelligenceact.eu/implementation-timeline/",
      "status": 200,
      "content_type": "text/html; charset=UTF-8",
      "title": "Implementation Timeline | EU Artificial Intelligence Act",
      "canonical_url": "https://artificialintelligenceact.eu/implementation-timeline/",
      "description": null,
      "publisher": "artificialintelligenceact.eu",
      "language": "en-US",
      "published_at": null,
      "modified_at": null,
      "retrieved_at": "2026-10-18T20:02:07.241Z",
      "word_count": 1949,
      "content_hash_sha256": "9f71ccf31723b4d01c2ca8cdb74ed6a76e1be0e624e91dd12e6f0cbd875fad35",
      "evidence": [
        {
          "excerpt": "Application: Date of entry into force of the AI Act.",
          "context": "h3:2024 > p[17]",
          "relevance": "direct"
        },
        {
          "excerpt": "1 August 2024",
          "context": "h3:2024 > p[16]",
          "relevance": "direct"
        },
        {
          "excerpt": "Commission: Commission must draw up a report on the delegation of power conferred for a period of five years from 1 August 2024, outlined in Article 97.",
          "context": "h3:2028 > p[186]",
          "relevance": "direct"
        },
        {
          "excerpt": "Providers: Providers of GPAI models that have been placed on the market before this date need to be compliant with the AI Act by 2 August 2027.",
          "context": "h3:2025 > p[47]",
          "relevance": "supporting"
        },
        {
          "excerpt": "2024",
          "context": "h3:2024",
          "relevance": "supporting"
        }
      ],
      "structured_data": {
        "json_ld": [],
        "open_graph": {}
      },
      "warnings": [],
      "from_cache": false,
      "redirect_chain": []
    }
  ],
  "limitations": [
    "Assessment is derived from deterministic lexical matching, not semantic reasoning. A configured reasoning provider may refine it, but never replaces source evidence."
  ],
  "processing_ms": 1489
} as const;
