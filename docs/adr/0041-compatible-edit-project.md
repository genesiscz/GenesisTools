---
status: Accepted
date: 2026-11-18
---

# Extend edit projects with optional fields at version 1

TypeScript and Swift both write edit projects. Add optional `audio.lanes` and `layers` to version 1 with the
same keys, operations and shared cases. Derive defaults when opening an older project and leave its file
untouched until an edit. A version bump would make an older app refuse projects saved from another worktree.

`.claude/plans/2026-11-18-RecordingEditorLayers.md`, "Interface freeze", "P1: TypeScript shapes, derivations and ops", "P3: the Swift model and ops".
