---
status: Accepted
date: 2026-11-18
---

# Give samples immutable IDs and refusals a source-line key

Use a persisted random `vs_` ID for a new sample. Migrated rows use their complete canonical tuple and duplicate
occurrence, with collision checks. Moving a sample keeps its ID. Refusals follow proven root recording and
source-line lineage across copies and track changes. A row number can change after preview, while a physical
print ID alone lets a rejected utterance return through another copy.

`.claude/plans/2026-11-18-MeetingsVoiceLibrary.md`, "Interface freeze", "P1: Global storage, compatible views and resumable v1 migration", "P3: Scoped CLI and correction playback".
