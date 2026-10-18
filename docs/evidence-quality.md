# What the assessment can and cannot tell you

This document records a measured limitation, because it decides whether the
product is sellable and the honest answer is not a comfortable one.

## The finding

A real paid call, 2026-10-19:

```
question: Who won the 2024 UEFA Euro final and what was the score?
source:   https://en.wikipedia.org/wiki/UEFA_Euro_2024_final
verdict:  supported
excerpts: "England then won the game very late on when Palmer assisted Ollie
           Watkins to score in the 90th minute, sending them through to their
           first major tournament final"          <- labelled "direct"
          "Across men's and women's ... fourth England-Spain tournament final"
          "The UEFA Euro 2024 final was a football match that determined the
           winners of UEFA Euro 2024."           <- true, but says nothing
```

The answer is Spain, 2-1. No returned excerpt states it. The verdict said
`supported`.

## Why

Matching is deterministic and lexical: IDF-weighted term overlap plus an adjacency
bonus, with negation cues. Nothing in that pipeline knows that the passage is about
a *different* match. The excerpt above contains "won", "score" and "final" - three
of the question's six distinctive words - and that is enough to clear any
coverage threshold that still accepts genuine answers.

Two changes were made in response, and neither is a cure:

1. **An absolute coverage floor** (0.75 of the question's distinctive word weight,
   measured per word rather than per surface variant). Before, labels were relative
   to the best passage in the document, so a document whose best passage was weak
   still produced a "direct" one. This rejects passages that merely touch the
   question.
2. **A regression test** built from this exact failure: a document about a
   semi-final must yield no stance-bearing passage for a question about the final.

The floor does not fix the case above, because the off-target passage is not weakly
overlapping - it is strongly overlapping and wrong. That is the lexical ceiling, and
it is why `limitations` has always said the assessment is "deterministic lexical
matching, not semantic reasoning".

## What this means for selling it

An agent that trusts the `status` field on this class of question will be misled.
Until matching is semantic, the verdict is reliable only when the question shares a
distinctive vocabulary with the answer - company facts, defined terms, specific
attributes - and unreliable when it asks about one of several similar events.

The documented path is the optional Laya sidecar (see README). It scores candidate
passages with a typed-decision model instead of term overlap. It is not required to
run the service, which is why this limitation is recorded here rather than papered
over.

## The honest one-line summary

The service is honest about its provenance and its limitations, and it is not yet
reliable enough to be worth $0.003 to a buyer who checks.
