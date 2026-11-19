---
status: Accepted
date: 2026-11-18
---

# Separate choosing a recording target from starting a take

Opening the recorder shows setup. A picker choice changes the target, giving the user time to check sound,
camera and frame rate. Record starts the take through the existing engine path. The old immediate-start behavior
remains available through `recorder.picker.choiceStarts`, off by default. Making it the default could capture a
window before setup was finished.

`.claude/plans/2026-11-18-RecorderControlBar.md`, "P3: the picker: area, several displays, pick a window by clicking, hover and choice pulse", "P6: the full recorder on the bar", "P7: the widget's entries open the bar and the picker".
