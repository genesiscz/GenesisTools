---
status: Accepted
date: 2026-11-18
---

# Evaluate voice seeds before departures and suggestions after them

A derived departure can change who was present for a line. Voice seeding uses the pre-departure facts and the
later suggestion pass uses the corrected facts. Sharing the first result would change the second pass, and
sharing the second would change which voices seeded it. Keep both evaluations of the same rules.

`.claude/plans/2026-11-18-MeetingsArchitecture.md`, "`speaker-evidence.ts` after P3A: per-line outcomes are the interface", "P3A: A3. Per-line outcomes become the interface of the evidence module".
