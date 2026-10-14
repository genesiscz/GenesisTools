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
- Settings window: the `--clicky --page <id>` face; screenshot it with
  `tools control screenshot --app <pid> --path …` (no focus change).
- `tools control window --app <pid> --json` lists a face's windows; pick by PID, several faces share one bundle.

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
