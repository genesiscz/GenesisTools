---
status: Accepted
date: 2026-11-18
---

# Expose the speaker finding for each line

`speakerEvidence` returns swap items and ordered `finding`, `direct` or `none` outcomes per label.
`evidenceItems` turns them into ranges. `independentIndicatorLines` reads only sufficiently confident indicator
findings free of listen, echo or conflict flags. This replaces `onIndicator`, which forced voice seeding to
build ranges it discarded and import the pipeline that called it.

`.claude/plans/2026-11-18-MeetingsArchitecture.md`, "`speaker-evidence.ts` after P3A: per-line outcomes are the interface", "P3A: A3. Per-line outcomes become the interface of the evidence module".
