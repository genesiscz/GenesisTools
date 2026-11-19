---
status: Accepted
date: 2026-11-18
---

# Give the global voice library its own directory

Keep the v2 store at `meetings/voice-library/library.json`, outside the directory of v1 project files. A legal
project can be named `library`. Reusing its filename or reserving an archive suffix in that directory could
overwrite a project's data. Scoped legacy readers keep access to their original files.

`.claude/plans/2026-11-18-MeetingsVoiceLibrary.md`, "Interface freeze", "P1: Global storage, compatible views and resumable v1 migration".
