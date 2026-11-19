---
status: Accepted
date: 2026-11-18
---

# Publish a voice-library migration only at a write boundary

Listing, prediction and dry runs read an in-memory v1/v2 view. A supported write or explicit upgrade inventories
inputs, arbitrates with legacy writers, validates models and publishes a verified snapshot with a per-file
digest and row manifest. Preserve the v1 bytes and duplicate multiplicity. File existence alone cannot
distinguish an interrupted import from completion or account for a late legacy write.

`.claude/plans/2026-11-18-MeetingsVoiceLibrary.md`, "Interface freeze", "P1: Global storage, compatible views and resumable v1 migration".
