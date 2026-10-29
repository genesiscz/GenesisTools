# Testing the real app without touching the user

## Which build
- Test the REAL GenesisTools.app built from the checkout you changed (`bun run app`), so its real privacy grants
  apply. `bun run app:status` names the branch and commit installed.
- Widget and Clicky faces are gated: `bun scripts/native/staging.ts on|off|status|start` (defaults key
  `GenesisToolsStagingFaces` on com.genesiscz.genesistools). Other users never set it.
- The Preview bundle (`bun scripts/build-widget-preview.ts`) has its own bundle ID and state root
  (~/.genesis-tools/widget-preview/data); the real app's widget state is ~/.genesis-tools/hub/widget. Use the
  Preview for a parallel experiment on another display, never both on the same screen.
- `bun run app` reaps the widget face; restart it with `staging.ts start`.

## Driving without the pointer
- `bun scripts/native/widget-drive.ts [--preview] send "<command>"`: `expand <edge> [group]`,
  `module <id> <edge> [group]`, `hover|unhover <edge> [group]`, `collapse`, `select <key>`, `settings [page]`.
- Change preferences through the widget's own door: `tools hub widget call --input <json>` with
  `{"action":"preferences","patch":{…}}` (e.g. `showWidget`).
- Settings window: the `--features --page <id>` face (`--clicky` is its old name); screenshot it with
  `tools control screenshot --app <pid> --path …` (no focus change).
- `tools control window --app <pid> --json` lists a face's windows; pick by PID, several faces share one bundle.

## Real-pointer drags of the hub's resize edges (2026-10-29 19:41)
- Scripts: `.claude/skills/swift/scripts/resize/` (`hub-drags.ts` every edge of the named modes, `drag-frames.ts` one
  drag with a window capture every 60 ms, `release-sample.ts` one drag with `sample` on the release, `sample-who.ts`
  to read a sample by frame family, `bench-summary.ts` for `--bench` JSON). They move the real pointer, so they run
  only inside `tools say "Stop touching"` … `tools say "Done"`, and the hub must be in front (`focusHub`).
- The edge is an accessibility element labelled "Resize <title>" (`tools control dump --app <pid>`), long and thin;
  drag along its frame. The proof is the hub's own `hub.resize <panel> a->b pt: N steps … step gap p50 p95` line and
  the `…release main busy` line after it; no line means the pointer hit something else (MISSED), not a free step.
- Let the mode load first. PRs shows its threads list up to 40 s after the switch (`prs.threads.show`, 0.7 to 1.5 s on
  the main thread) and renders readiness after that; a drag inside that window measures the load. A step gap p95
  of 400 ms with a `hub.mode.prs` or `prs.list.render` line in the same seconds is the load, not the resize.
- `HubMainBusy` is wall time on the main thread: at a load average of 36 the same release read 324 ms that read 302
  at 6. Note `uptime` with every run and rerun under 12 (`when-quiet`-style wait) before comparing.
- **Without the user's pointer** (the overlay cursor, window-addressed events): the hub window exceeds the snapshot
  limit, so observe one element, then act on it with element-scoped revalidation (the hub repaints its live times):
  `tools control see --app <pid> --query "Resize Worktrees"` (the row's `index` and `targetKey`), then
  `tools control act --app <pid> --snapshot <token> --element <index> --action drag --to <x,y> --duration 1
  --background --revalidate-scope element --target-key <key>`, within the snapshot's `expiresInSeconds`. The proof
  is the same `hub.resize` line. A SwiftUI `DragGesture` took such a drag only sometimes (a fresh key window);
  GenesisKit's handle takes it through an AppKit view (`GenResizeDragSurface`, `acceptsFirstMouse`), so every panel
  on the engine resizes this way (2026-10-29, Martin: "it should be able with the cursor from the overlay").

## Watching
- `tools hub dev monitor` under the Monitor tool; filter out timers another stream owns, keep stalls/crashes.
- A stall that hits every process at once with a load average of 30+ is the machine, not your view.

## Input on the user's screen (Martin, 2026-10-14)
- Every press, drag, key and pointer move goes through `tools control` with `--background`: window-addressed events,
  the animated blue cursor shows what happens (`--note` labels it), the hardware pointer and the keyboard focus stay
  with the user. Never an own `CGEvent` poster on the HID tap, never System Events keystrokes or menu clicks. If
  `tools control` lacks the action, ask for it instead of falling back (2026-10-14: `act --action drag --to` refuses
  a destination outside the snapshot window, so a window cannot be dragged yet).
- Read the target's frame right before the press. A press on empty screen lands in whatever window is behind.
- Reproduce a click bug the way the user clicked: a real press, hold and small drag differs from an accessibility
  press (the viewer's dead clicks needed the hold). Keep it inside the app under test.
- Never attach a debugger to the user's running app, and never poll in a loop without a sleep: both froze the Mac.
  For "clicks do nothing", ship a diagnostic build that logs every mouse down and up with the hit view and the
  window's key, active, modal and sheet state, then read `log show --predicate 'subsystem == "genesiskit"'`.
- A window with `sharingType = .none` (screen-effect panels, the camera bubble) is invisible to every capture; check
  its bounds with `CGWindowListCopyWindowInfo` instead of trusting an empty screenshot.
- Turn back off whatever you turned on for a test (a setting, a preview) and say so in the report.
- A click delivered in the background to an inactive window is no proof that clicks work or fail: it arrives with
  key and active false, and macOS may use it to activate the window only. Prove a dead-click bug from the app's own
  press and action log, or with the window key while the user agrees to give up focus.
- A window whose text changes live (a "saved 1 min ago" status) makes `tools control act` refuse as stale. Pass the
  row's `--target-key <stableKey> --revalidate-scope element` from the same `see`.
- `tools control click --app <app> --desc <label> --depth 40` presses one named control without taking focus (Martin,
  2026-10-23: "you can control click it wont steal my focus"). Press by label, one control at a time. Never sweep
  a grid of coordinates over a real window: a sweep hits the side-effect buttons (Obsidian, Editor) and opens dialogs
  and files in the user's apps.
- When a whole window stops reacting, first read its unified log for an exception (`command log show --predicate
  'processID == <pid>' --last 10m | rg -i "exception|raise"`), then theorise.
