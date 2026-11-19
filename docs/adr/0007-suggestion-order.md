---
status: Accepted
date: 2026-11-18
---

# Keep suggestion order visible in the pipeline

`suggest.ts` keeps speaker hints, `labeledItems`, reconciliation and the sequence of passes. The order
determines how a later rule sees earlier evidence. A table of passes would still have one caller and shared
mutable state, while making the dependency between steps harder to see.

`.claude/plans/2026-11-18-MeetingsArchitecture.md`, "Move table (lines at `dc43ef8cca`; find by name at your base)", "Decisions".
