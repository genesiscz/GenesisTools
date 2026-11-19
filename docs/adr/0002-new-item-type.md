---
status: Accepted
date: 2026-11-18
---

# Share the type of a proposed item

Term and speaker rules both produce items before the record assigns an ID and timestamp. Keep `NewItem` and its
distributive `OmitEach` in the type-only `new-item.ts`, so each item kind retains its fields. Putting the type
in the pipeline would introduce a backward import. Moving it beside `MeetingItem` can wait until the timed-seat
and voice packages release the record schema.

`.claude/plans/2026-11-18-MeetingsArchitecture.md`, "`new-item.ts` (P1A)".
