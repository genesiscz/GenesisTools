---
status: Accepted
date: 2026-11-18
---

# Plan all suggestion changes and apply them once

`planSuggestions` returns new items, edits keyed by existing item ID and expected prior state, and changes to
participant stays. Preview consumes that plan. The normal writer calls `applySuggestionChanges` once under the
record lock after checking the expected state. Keeping retirements, surviving slices, signatures or choices as
side effects of `suggestItems` would make preview and save disagree.

`.claude/plans/2026-11-18-MeetingsRoomAndCallPresence.md`, "Interface freeze", "P3R: R3. Rule integration, mic questions and one record update".
