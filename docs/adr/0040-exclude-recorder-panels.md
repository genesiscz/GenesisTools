---
status: Accepted
date: 2026-11-18
---

# Exclude recorder controls and markers before capture starts

Prepare panel window IDs before calling the engine. The bar, picker, pulse and active outline use nonshared
panels and pass their IDs to the engine's capture exclusion list. Waiting until a panel first becomes visible
could put the recording controls into the recording itself.

`.claude/plans/2026-11-18-RecorderControlBar.md`, "Read this first after a compaction", "The engine seam (two implementations, one protocol)", "P2: the screen pulse and the shared overlay panels", "P4: the control bar view".
