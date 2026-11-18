---
status: Accepted
date: 2026-11-18
---

# Use one control bar for the widget and full recorder

`RecordingBarModel` owns setup and phase for both hosts. `WidgetSessionEngine` and `ToolsRecorderEngine`
implement `RecordingEngineAdapter` and report the changes each engine can actually apply. The bar shows the
acknowledged value and reason when a live change fails. Separate host-specific bars had already drifted on
controls and recording state.

`.claude/plans/2026-11-18-RecorderControlBar.md`, "The bar's model (GenesisKit, shared by both recorders)", "The bar's phases and what each shows", "The engine seam (two implementations, one protocol)", "P1: the setup model and the engine seam".
