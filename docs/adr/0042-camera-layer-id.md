---
status: Accepted
date: 2026-11-18
---

# Refer to the camera by ID in the layer stack

The reserved ID `camera` gives the recorded camera a place in layer order, while `project.camera` remains the
owner of its file, offsets, geometry and visibility. Layer edits translate to those existing fields. Hiding the
layer preserves the recording. Moving or copying the camera into `layers.media` would break older readers or
leave two settings to reconcile.

`.claude/plans/2026-11-18-RecordingEditorLayers.md`, "Saved shape: the layer stack (TypeScript, project.ts; the Swift mirror has the same keys)", "Ops (TypeScript op schemas in project.ts; Swift EditOp mirrors each)".
