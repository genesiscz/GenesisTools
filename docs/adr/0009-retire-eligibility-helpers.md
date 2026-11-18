---
status: Accepted
date: 2026-11-18
---

# Retire eligibility helpers after checking their callers

After room R4 and library P6, inspect callers of `presenceAt`, `storedPresentAt`, `microphoneCandidates`,
`MutedCallLines` and `callMutes`. Delete a helper once its production callers are gone. Record the reason for
any remaining reader. Blanket deletion could remove a legitimate recorder observation, while keeping unused
eligibility paths would invite conflicting speaker choices.

`.claude/plans/2026-11-18-MeetingsArchitecture.md`, "P5A: A5. Callers move to the new modules; legacy doors are deleted".
