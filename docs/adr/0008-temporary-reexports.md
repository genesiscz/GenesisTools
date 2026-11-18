---
status: Accepted
date: 2026-11-18
---

# Stage module moves with temporary re-exports

Move the term, speaker and answer rules without changing their behavior. Re-export the old names while other
packages own the callers. P3A drops the `evidenceItems` bridge when the seed reader switches. P5A switches the
remaining callers and removes their bridges. Moving callers in the extraction commit would give two packages the
same files.

`.claude/plans/2026-11-18-MeetingsArchitecture.md`, "Move table (lines at `dc43ef8cca`; find by name at your base)", "P5A: A5. Callers move to the new modules; legacy doors are deleted".
