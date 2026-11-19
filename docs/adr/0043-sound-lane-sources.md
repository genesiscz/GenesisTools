---
status: Accepted
date: 2026-11-18
---

# Play each recorded sound source once

For a frames proxy, derive microphone and system lanes from the per-source files and their recorded offsets.
When those lanes represent the proxy mix, omit the mixed movie track in preview and export, even when a
constituent lane is muted. Preserve old track-zero mutes on the derived lanes. A movie with only a mixed track
and no separate sources gets one lane. Rebuilding every proxy is unnecessary, and playing both representations
doubles the sound.

`.claude/plans/2026-11-18-RecordingEditorLayers.md`, "Saved shape: sound lanes (TypeScript, project.ts; the Swift mirror has the same keys)", "P2: lanes known from the first open", "P4: draw the stack and mix the lanes".
