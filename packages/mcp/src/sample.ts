/**
 * A real, previously produced evidence package, served by the free `sample` tool.
 *
 * The same object the Worker serves at /demo.json — copied rather than imported
 * because the Worker must not pull the MCP SDK into its bundle for one constant.
 * If one changes, change both; they describe the same call.
 *
 * Why a free sample tool at all: every other route asks an agent to pay before it
 * can judge whether the output is any good. A caller that reaches this tool has
 * already decided to interact; letting it read one real response - with sources,
 * retrieval times and content hashes - costs nothing and is the cheapest possible
 * proof that the paid call is worth $0.003.
 *
 * This is a sample, not a live call: it takes no arguments and always returns the
 * same package. The paid tool is research_evidence.
 */
export const SAMPLE_EVIDENCE = {
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
