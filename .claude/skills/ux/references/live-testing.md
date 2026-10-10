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
