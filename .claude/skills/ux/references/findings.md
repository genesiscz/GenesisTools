# Wrong on the first try (ledger)

Newest first. Each entry: date, symptom as the user saw it, cause, fix, commit. Generic lessons go to
checklist.md or motion.md as well.

- 2026-10-10 — **Widget opened on a random display.** "Main display" fell back to `NSScreen.main`, which is the
  display with keyboard focus at launch, not the menu-bar display. Fix: `NSScreen.screens.first`. 24fdbb77a.
- 2026-10-10 — **Empty card on collapse.** The content was removed at once (inert `.transition`), the window
  started shrinking ~130 ms later. A fade (2b48b2ceb) moved the ~200 ms teardown mid-shrink; the motion stream
  owns the real fix.
- 2026-10-10 — **Module navigation twice** in the expanded side panel (strip + in-panel row), and Flow and Voice
  Notes shared the `waveform` icon. Fix: row only on the top edge; `mic.fill` / `recordingtape`. 2b48b2ceb, 24fdbb77a.
- 2026-10-10 — **Capture was silent**: `screencapture -i -x` (`-x` suppresses the shutter sound).
- 2026-10-10 — **Settings told the user to run a command that does not exist** (`genesis focus forget`) and to
  hand-edit JSON for project rules; stored settings had readers but no control.
- 2026-10-10 — **Idle widget burned a third of a core**: a `tools hub widget discover` process every 10–20 s,
  each 2–4 s of CPU, plus a LaunchServices signature check per spawned launcher process.
