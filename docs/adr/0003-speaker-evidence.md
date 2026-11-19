---
status: Accepted
date: 2026-11-18
---

# Move channel evidence rules behind one interface

`speaker-evidence.ts` owns `findingFor`, `localVoiceFinding`, swap detection, evidence scoring and grouping into
items. Move their existing behavior first. The pipeline can import the evidence functions and the evidence code
can use eligibility and leaf constants. Importing the speaker-label index or the pipeline from the rules would
recreate the dependency cycle.

`.claude/plans/2026-11-18-MeetingsArchitecture.md`, "`speaker-evidence.ts` after P2A: moved, signatures unchanged", "P2A: A2. Channel evidence rules move into their own module".
