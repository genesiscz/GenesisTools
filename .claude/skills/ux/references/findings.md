# Wrong on the first try (ledger)

Newest first. Each entry: date, symptom as the user saw it, cause, fix, commit. Generic lessons go to
checklist.md or motion.md as well.

- 2026-10-13 18:18 — **Second pass on Martin's 15-item review, the transcript, the PRs view.**
  - *"X new" scrolled down but not to the bottom.* The pill's own click counted as the reader's, so rows that
    measured during the glide were not followed. The pill now chases the end for 2 s (eae978b26).
  - *Split / Unified did nothing.* The page and Swift paths were correct; the controls were native segmented
    `Picker`s. `GenSegmentedTabs` now (0f49adbed). A hosted page test first "reproduced" it falsely: a hidden page
    gets no animation frames (see the swift skill's gotchas).
  - *"This file is not in a git repository" flashed on open.* A tri-state lookup: pending shows nothing (5435005a9).
  - *The rendered diff looked heavy and tables read as striped.* Strips in the bar column instead of backgrounds;
    word marks stay (b24e9455d).
  - *The repository panel lagged while scrolling.* An AppKit hover view per row from `instantTooltip` (75281f361),
    after the lists moved off the main thread (7da16a1dd).
  - *A tab switch showed a blank page.* `GenRenderSwap` keeps the old page until the new one rendered, in the viewer
    and the hub's session switch (3c6033454, e2dbe79ca).
  - *The PRs view showed "gt-clone: no gh/glab driver for /Users/…/GenesisTools".* A clone whose origin is a local
    folder is not a hosted project: it is skipped quietly (1eb0848ad).

- 2026-10-13 17:22 — **Markdown viewer, one day of review (GenesisKit `Markdown/`, PRs #499, #501).**
  - *A note stuck at an empty preview.* The page sometimes missed a render. Every render now carries a tag the page
    keeps; the host confirms it and sends again (0273fba64, ef6bde0ae).
  - *Clicks on `[[ado/312798.analysis]]` did nothing.* The resolver read `.analysis` as a file extension and never
    tried `.md`. Note names hold dots; try `<name>.md` whenever the literal path is no file (2bcecb1d2).
  - *The git panel hung the window.* 3,416 rows, one button and tooltip each. Fold, page, lazy rows (ca5b6b5a6).
  - *"This file / Repository" looked like two loose buttons.* A native segmented `Picker` in a window that is not key.
    `GenSegmentedTabs` everywhere, not only in non-activating panels (ca5b6b5a6).
  - *Change bars covered list numbers; changed table rows had none.* One column of bars in an overlay (21dfc1e44).
  - *The window size was lost on every restart.* The autosave name was dropped by `NSWindowController.init`.
  - *"This file is not in a git repository" flashed for a second* while the repository lookup ran: a pending lookup
    and a negative answer were the same `nil`.
  - *The page went blank on every tab switch:* a fresh web view per tab.
  - *Tests wrote fixture folders and 5,000 entries into the user's notes vault* for a month (#500).

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
