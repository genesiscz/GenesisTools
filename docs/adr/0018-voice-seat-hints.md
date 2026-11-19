---
status: Accepted
date: 2026-11-18
---

# Infer a seat only from independent positive voice matches

Seat preview compares compatible human-confirmed prints before imposing the seat it is trying to infer. It needs
two independent non-overlapping positives on one side and none on the other. Report both counts and leave the
seat unresolved when the evidence conflicts. Comparing a target with its own recorded copy, or teaching from the
hint, would let a line confirm itself.

`.claude/plans/2026-11-18-MeetingsRoomAndCallPresence.md`, "Interface freeze", "P4R: R4. Independent voice evidence in seat suggestion".
