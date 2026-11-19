---
status: Accepted
date: 2026-11-18
---

# Put area and click-to-pick selection in GenesisKit

Both hosts need to identify the same windows and display rectangles. Keep area selection and picking a window by
clicking it in GenesisKit. Each adapter advertises the targets its engine can record, so the widget can expose
the supported subset. Duplicating picker implementations in the Recorder part would tie the widget to another
host's code.

`.claude/plans/2026-11-18-RecorderControlBar.md`, "P3: the picker: area, several displays, pick a window by clicking, hover and choice pulse", "P5: the widget engine adapter", "Decisions".
