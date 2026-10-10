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
