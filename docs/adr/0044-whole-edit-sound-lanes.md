---
status: Accepted
date: 2026-11-18
---

# Apply sound-lane gain and mute to the whole edit

A lane gives each source one mute and volume for this edit. Cut and speed changes follow the existing time map.
A partial mute, such as removing one cough, needs an interval item with its own undo semantics. The whole-lane
control cannot express that edit.

`.claude/plans/2026-11-18-RecordingEditorLayers.md`, "Saved shape: sound lanes (TypeScript, project.ts; the Swift mirror has the same keys)", "P4: draw the stack and mix the lanes", "Decisions".
