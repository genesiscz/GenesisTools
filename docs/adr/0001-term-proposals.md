---
status: Accepted
date: 2026-11-18
---

# Give term proposals their own module

Term spelling depends on words, the dictionary and transcript context. `suggest-terms.ts` owns those rules,
including `UNKNOWN_WORD_CONFIDENCE`. The pipeline calls `termItems` and uses `TermThresholds`. Importing the
confidence table from `suggest.ts` would make the term module depend on its caller.

`.claude/plans/2026-11-18-MeetingsArchitecture.md`, "`suggest-terms.ts` (P1A): moved, signatures unchanged", "P1A: A1. Term proposals move out of the pipeline module".
