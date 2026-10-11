# Wrong on the first try (ledger)

Newest first. Each entry: date, symptom as the user saw it, cause, fix, commit. Generic lessons go to
checklist.md or motion.md as well.

- 2026-10-11 — **A fitted panel that grew or shrank with "Source and context" dropped frames (largest gaps 37–59
  ms), and the side panel cut off its own header while it shrank.** Two causes. The outline (a Core Animation
  mask) started at the click while the content (a SwiftUI animation) started a frame or two later, because the
  main thread was still drawing the click: fix, both start on the first display frame (40568ffc1). And the
  composer's AppKit text field moved with the content, so every frame ran a hosting-view layout and rebuilt the key
  view loop (`FocusBridge.invalidateKeyViewLoop` in a `sample` of the fold); `ReshapeCostProbeTests` isolated it
  (gap p50 18–26 ms with the field, 8 ms with a drawn stand-in): fix, the composer draws a stand-in while
  `\.edgePanelMoving` is true (6f3de7867). Real app, one-card codex session, Source and context closed then opened,
  largest gap before (one run) → after (three runs): side shrink 41.2 → 12.5–18.7 ms, side grow 37.5 → 14.0–18.0
  ms, top shrink 47.3 → 12.5 and 25.0 ms (one run gave 79 ms; the front app changed during it), top grow 59.2 →
  12.5–20.8 ms. Gap p50 was 16.7 ms in 3 of 4 reshapes before and 8.3 ms in 10 of 12 after; first callback 13–26
  ms; one window resize per change; header and composer in every outline frame. The live checks first took the keyboard and lost the panel to the user's clicks elsewhere:
  passive mode (da23479e8, 69724feaa). `ax.swift` walked accessibility cycles without end: 772e6e2cb.

- 2026-10-11 — **Image viewer: the title row's "1 of 5" sat on top of the window title.** `.titlebarRow()` starts
  after `WindowTitlebar.leadingReserve`, which measures AppKit's title field; it was measured before the field was
  laid out, and a later title change ("A and B" while comparing) is never measured again. Fix: hide the AppKit
  title (`titleVisibility = .hidden`, the title stays set for the Window menu) and draw the name in the row with
  `.titlebarLabel()`. The title bar audit's "flat band under the strip" rule also fires on any canvas that
  letterboxes a picture; the viewer's snapshot test checks the zone and the row instead. eb2c0bcc5.

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
- 2026-10-10 — **Swift builds failed with "cannot find type" for types in files that existed.** The disk was full
  (129 MiB): the compiler's emit-module step failed first and only later lines said "No space left on device". Check
  `df -h /System/Volumes/Data` before debugging a strange build error. Stale Chrome/Brave `code_sign_clone` copies in
  `/var/folders/*/*/X` were 16 GB of it.
- 2026-10-10 — **Image attachments were 42 × 30 chips with a `photo` glyph.** Fix: GenesisKit `MediaThumbnailView`
  (off-main decode, cache keyed by file identity, in-place preview). 5008ca4a5.
- 2026-10-10 — **Disclosures reacted only on the chevron, buttons had no hand.** Fix: `GenDisclosure`; pointer built
  into the shared hover styles. eb0292629.
- 2026-10-10 — **Permission failures were grey text or an `.alert` inside a widget panel.** Fix: one
  `PermissionCenter` dialog with a denial simulation for the real app. 1fcecc6b3.
- 2026-10-10 — **Settings: two quick module toggles lost one.** A snapshot load that started before a preference
  write landed after it and replaced the optimistic state; the next toggle patched from stale data. Found only by a
  live pass that presses every switch and reads it back in a new process (`scripts/native/settings-v2.ts`). d5ae82bef.
- 2026-10-10 — **One accessibility identifier on four switches** (the same module in four edge cards). No test or
  assistive tool could address one. Identifiers must be unique per window. d5ae82bef.
- 2026-10-10 — **Expand jumped preview → full in one frame; collapse showed an empty card.** Per-frame window
  resizes plus a 250 ms content build before the first frame. Fixed with one resize + an animated mask. 417458101.
