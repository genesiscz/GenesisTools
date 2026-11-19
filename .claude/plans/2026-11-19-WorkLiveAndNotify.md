# Work screen: live without jumps, and a readable Notifications pane that edits its rules: build spec

**Status:** 2026-11-19 00:55, ready for an executor. No decision is open.
**Goal:** The hub's Work screen follows the work store live with no reload button and nothing that moves under the
eye, and its Notifications pane says in words who hears about each change and lets the reader change it in place.
**Non-goals:** the list below.
- No search, filter or item inspector. The sibling spec owns them:
  `.claude/plans/2026-11-19-WorkFindAndDetails.md`. Do not edit its owner regions (named under "Order").
- No new service, no new transport, no polling loop. The live path is the one the screen has: the actions service's
  `work.changed` event plus the store-file watch behind `WorkSource.changes()`.
- No change to how the notifier delivers (`src/utils/work/notify.ts`), to the widget, or to the config file's shape
  on disk. The new action writes the same paths `tools work config set` writes today.
- No VoiceOver, Full Keyboard Access or OS accessibility settings work (ux skill, "Accessibility scope": not
  confirmed for this task). Keep every existing accessibility label and identifier, and give each new control a
  label and an identifier.
**Executor:** one Codex child (`gpt-6.2-astra`, reasoning effort `xhigh`) builds P1 to P4 in order in its own
worktree, on branch `feat/2026-11-19-work-live-b`, and commits per package. It may spawn its own explorer or worker
subagents (in the same worktree) to read code or to try a design; it alone commits. It reads only this file and
what it links.

## Read this first after a compaction

- Owner's words for this work (Martin, 2026-11-19 00:40, with a picture of the Notifications pane):
  - "ur happy with this yeah? theres no filter, no search, no details of the tasks"
  - "also the "reloading" indicator jumps the icons (the rpc should be realtime so no need to refresh no?)"
  - "for sure there will be like 50 more ux issues like this"
  - "Run 2 more astras which will just implement whatever plan-it + handoff you give them based on what i just
    told you - the new features - spec them (at least 500 lines each plan) and just make sure astras do them."
- Standing rules for this child (Martin and the repository):
  - Never push. Never open a PR. The orchestrator (Claude session `ae3ac312`) merges your branch into the feature
    PR branch `feat/2026-11-19-work-find-live` and pushes.
  - Never run `bun run app` (it replaces the installed app for the whole Mac). Verify with tests, snapshots of a
    build in your worktree, and the commands in "Rules for the executor".
  - One Swift build or test at a time on this Mac. Before EVERY `swift build`, `swift test`,
    `bun scripts/native/swift-package.ts ...` or `bun run app:test`, wait until
    `pgrep -x swift-build || pgrep -x swift-test || pgrep -x swift-frontend` finds nothing (loop with a 20 s sleep;
    2026-11-19 03:30: `pgrep -f` with the pattern matched the waiting shells themselves and deadlocked them).
  - Never `rm`. Delete with `tools rm <paths>`. Scratch files go under
    `/tmp/cc/GenesisTools/ae3ac312-7dbe-4045-970a-292aa93ed9ab/work-live-b/`.
  - Never write Martin's real config file in a test or a probe: every test uses a temporary `configPath` or a
    temporary `GENESIS_TOOLS_HOME`. A live probe of the new action runs against a scratch home only.
  - No agent attribution in commits. Commit titles follow `scripts/git/commit-scopes.ts`; check with
    `bun scripts/git/check-commits.ts origin/feat/2026-11-19-work-find-live..HEAD`.
  - Typecheck TypeScript with `tsc-rs --noEmit -p tsconfig.json` (never `tsc`). Tests with `bun scripts/test.ts <paths>`
    (never bare `bun test`).
  - No real person, client or tracker name in code, tests, fixtures or commit messages.
- Progress is under "Progress" at the end of this file (in the MAIN checkout:
  `/Users/Martin/Tresors/Projects/GenesisTools/.claude/plans/2026-11-19-WorkLiveAndNotify.md`). Read it before you
  open code.
- Easy to get wrong:
  1. The screen IS live already: a store change triggers `reload()` (at most once every 3 s, not while the hub is
     hidden). The defect is that every background reload sets `isLoading`, the header inserts a `ProgressView` before
     the reload button, and the button and the tabs move left and back. The fix is not a faster reload; it is a
     reload that the reader does not see.
  2. A notify rule on disk is either a level string (`"inbox"`) or an object `{ level, minSeverity }`. The cell editor
     must keep a `minSeverity` it did not change (P2 decision 3).
  3. Four layers decide a cell: `default`, `config.global`, `config.repo`, `config.project`. The pane writes only
     `config.project` (this project) or `config.global` (every project); `config.repo` is a file in the repository
     and the pane never writes it, it only shows it.

## Sources

- Handoff `h_rkksvd0u` (name `work-live-and-notify`), tasks `p1` to `p4`, one per package.
  - Read: MCP `handoff_get { id: "h_rkksvd0u" }`; claim: `handoff_get { id: "h_rkksvd0u", claim: true }`.
  - Tick: `handoff_action { id: "h_rkksvd0u", actions: [{ action: "check_task", taskId: "p1", proof: { answer:
    "<the Done when check, where it ran>", commitIds: ["<sha>"] } }] }`.
  - Deny: `{ action: "deny_task", taskId: "p3", reason: "<why>" }`. Comment: `{ action: "comment", text: "..." }`.
- The sibling spec `.claude/plans/2026-11-19-WorkFindAndDetails.md` (handoff `h_kxboe8h2`). Its executor works at
  the same time on branch `feat/2026-11-19-work-find-a`.
- Martin's picture of the Notifications pane (local only):
  `/Users/Martin/.t3/userdata/attachments/mcp-launch-5fe9e8ac24cb1629aa273835df4df46e93c91fa4b47199d7e9d743de4d675da2-79c13b43-ee82-467e-96bc-79409f1e0de1.png`.
  What it shows: a 13 by 10 grid of lowercase tokens (`epic`, `reopen-undelivered`, `sync-held`), every cell the
  word "list" with a list glyph, a footer that prints the CLI command
  `tools work config set projects.GenesisTools.rules.notify.<type>.<action> '"inbox"'`, and the legend
  "off: nobody · list: the tree only · inbox: one quiet inbox line · banner: the line with a notification".
- The ux skill: `.claude/skills/ux/SKILL.md`, and in full before P1: `.claude/skills/ux/references/checklist.md`,
  `.claude/skills/ux/references/genesiscz.md`, `.claude/skills/ux/references/findings.md`,
  `.claude/skills/ux/references/motion.md`. The swift skill: `.claude/skills/swift/SKILL.md`.
- Design authorities before a judgment call: the `macos-golden-gate-design`, `apple-hig-expert` and
  `review-animations` skills.
- Repository rules that apply: `.claude/rules/macos.md`, `.claude/rules/macos-app.md`,
  `.claude/rules/macos-app-verify.md`, `.claude/rules/opinionated-settings.md`, `.claude/rules/tests.md`,
  `.claude/rules/code.md`, `.claude/rules/tools.md`, `.claude/rules/diagnostics.md` (a probe never writes durable
  state), and the `architecture` skill (`.claude/skills/architecture/SKILL.md`) before you add the action.

### Truth table (checked 2026-11-19 00:55 at `293c1a9048`, branch `feat/2026-11-19-work-find-live`)

| # | Claim | State | Proof |
|---|---|---|---|
| 1 | `WorkScreenModel` listens to `source.changes()` and reloads once per burst of changes, at most every 3 s, and not while the hub is hidden | holds | `WorkScreenModel.swift:95-110` (the `listening` task), commits `d1992ddb1a`, `3e654037cb` |
| 2 | `reload()` sets `isLoading = true` on every reload, background ones included | holds | `WorkScreenModel.swift:159-205` (`isLoading = true` before the load task) |
| 3 | The header shows `ProgressView` while `isLoading`, placed before the reload `IconButton`, so the button and the tabs shift | holds | `src/macos/GenesisTools/Sources/Parts/Hub/Work/HubWork.swift:174-177` |
| 4 | `WorkSource.changes()` merges `rpc.events.workChanged` and a watch of the store for CLI and MCP writes | holds | `WorkSource.swift` `changes()` (the comment on its second line) |
| 5 | The Notifications pane is `WorkNotifyGridView`: a `Grid` with the raw type and action tokens, one cell per action with its level word, and a footer with the CLI command | holds | `src/macos/GenesisKit/Sources/GenesisKit/Work/WorkScreenViews.swift:332-380` and Martin's picture |
| 6 | Notify actions: `spotted, accepted, claimed, finished, reopened, reopen-undelivered, dropped, commented, sync-held, sync-failed`; levels `off, list, inbox, banner`; a rule is a level or `{ level, minSeverity }` | holds | `src/utils/work/rules/config.ts:32-80` |
| 7 | Rule layers: `default, config.global, config.repo, config.project` | holds | `src/utils/work/rules/resolve.ts:9` |
| 8 | `setWorkConfigValue({ path, value, configPath })` writes one dotted path of the machine file through a migrating document update; `tools work config set` is its only caller | holds | `src/utils/work/rules/load.ts:247`, `src/work/commands/register.ts:94-130` |
| 9 | The `work` area of the actions registry makes every method of `workMethods` an action; a write emits `work.changed` | holds | `src/utils/work/api.ts:23` (`workMethods`), commit `5ba7451ea5` |
| 10 | No `work` method writes the config today (`config` only reads) | holds | `config: defineMethod` in `src/utils/work/api.ts:81` takes `project` and `type` only |
| 11 | The Swift client is generated by `scripts/gen-genesis-tools-rpc-swift.ts` into `src/macos/GenesisKit/Sources/GenesisKitBase/Generated/GenesisToolsRPC.swift` | holds | the script exists; the client has `rpc.work.config` at line 19536 |

## Interface freeze

The executor changes this section first (with a dated line) when code forces a change.

### The action (P2)

```ts
// src/utils/work/api.ts, in workMethods
configSet: defineMethod({
    name: "configSet",
    params: z.object({
        scope: z.enum(["project", "global"]),          // config.project or config.global
        project: z.string().optional(),                // required when scope is "project"
        notify: z.object({
            type: z.enum(ITEM_TYPES).or(z.literal("*")), // "*" = every type (only for a column change)
            action: z.enum(NOTIFY_ACTIONS).or(z.literal("*")), // "*" = every action (only for a row change)
            level: z.enum(NOTIFY_LEVELS).nullable(),     // null removes the rule at this layer (inherit)
        }),
    }),
    // result: { changed: Array<{ path: string; from: unknown; to: unknown }>, file: string }
}),
```

- The handler expands `*` to the concrete list, and for each pair writes
  `projects.<project>.rules.notify.<type>.<action>` (scope project) or the global path that `tools work config set`
  uses for the machine-wide rules (find it in `src/utils/work/rules/load.ts`; write it into this section when found).
- A cell whose stored rule is `{ level, minSeverity }` keeps its `minSeverity`: the handler writes
  `{ level: <new>, minSeverity: <kept> }`. `level: null` on such a cell removes the whole rule.
- All pairs of one call land in ONE `machineDocument(...).update` (one file write), so a row change is atomic.
- After the write the service emits `work.changed` (as every work write does), so open Work screens reload.
- Who may call it: the same rule as the other work writes inside the service (a person at a surface; an agent's
  write is refused there). The CLI `tools work config set` stays as it is.

### Swift (P2, P3)

```swift
// WorkSource protocol addition, under `// MARK: - Notify`
func setNotify(project: String?, scope: WorkNotifyScope, type: String, action: String, level: String?) async throws
    -> WorkActionOutcome
public enum WorkNotifyScope: String, Sendable { case project, global }

// WorkNotifyCell gains (decoded from the existing config read; no new read):
public var minSeverity: String?          // when the deciding rule has one
public var writable: Bool { get }        // false when `from == "config.repo"` (a repo file decides)
```

- `WorkScreenModel.setNotify(...)` runs the call, marks the cell pending (the `pending` set with id
  `notify:<type>:<action>`), shows the outcome `NoticePill`, and reloads the notify rows.

### The live state (P1)

```swift
// WorkScreenModel, under `// MARK: - Live`
public enum WorkLiveState: Equatable, Sendable { case live, catchingUp, stopped(reason: String) }
@Published public private(set) var live: WorkLiveState
@Published public private(set) var isFirstLoad: Bool      // true only until the project's first snapshot arrives
public func reconnect()                                   // restarts the change stream and reloads once
```

- `isLoading` stays for compatibility and turns true only while `isFirstLoad` (or an explicit `reload()` from ⌘R).
  Background reloads change neither `isLoading` nor anything in the header.
- `live` is `.live` while the change stream runs; `.catchingUp` while a reload that a change caused runs longer than
  1 s; `.stopped(reason:)` when the stream ends or throws (the actions service went away and the file watch failed).

### Words (P3)

One table in `WorkScreenViews.swift` or a new `WorkNotifyWords` in the new notify file; both the grid and its menus
read it.

| Token | Words |
|---|---|
| actions `spotted, accepted, claimed, finished, reopened, reopen-undelivered, dropped, commented, sync-held, sync-failed` | Spotted, Accepted, Claimed, Finished, Reopened, Reopen not delivered, Dropped, Commented, Sync held, Sync failed |
| levels `off, list, inbox, banner` | Nobody, In the list, Inbox line, Inbox and banner |
| level details | "Nobody hears about it." / "It shows in the Work list only." / "A quiet line in your inbox." / "An inbox line with a notification banner." |
| layers `default, config.global, config.repo, config.project` | Built in, All projects, This repository's file, This project |
| types | the type words of the sibling spec's table (Epic, Handoff, Feature, Bug, Incident, Task, Test, Clean-up, Check, Idea, Risk, Limit, To-do) |

Level glyphs and colours (the same in the cell, the menu and the legend; different states differ in hue and glyph,
not only shade, per the ux skill): Nobody `bell.slash` dim; In the list `list.bullet` dim; Inbox line `tray` blue;
Inbox and banner `bell.badge` orange.

- 2026-11-19 01:01 The machine-wide path is global.rules.notify.<type>.<action>. For exact bulk Undo, configSet also accepts restore (instead of notify), a bounded list of concrete type/action pairs with raw from/to rules. Undo checks the expected current values under the same lock before restoring. Each changed path includes its structural type/action so dots in a project name are preserved.

## Order

- Wave 1: P1 and P2 start now. P1 is Swift only; P2 is TypeScript first, then the generated client and the Swift
  call. One child does P1, then P2 (or P2 first when P1 is blocked waiting for a Swift build).
- Wave 2: P3 needs P2 (built).
- Wave 3: P4 needs P1 (built) and P3 (built).
- Owner regions shared with the sibling spec (its executor runs at the same time):
  - `HubWork.swift`: this spec owns `WorkMain.header` (the title bar row: the spinner, the reload button, the live
    pill). The sibling owns `WorkMain.content` and below. Do not edit the content.
  - `WorkScreenModel.swift`: this spec owns `reload()`, `isLoading`, the change-stream task and a new
    `// MARK: - Live` block, and adds `setNotify` under `// MARK: - Notify`. The sibling adds a
    `// MARK: - Find and select` block. Do not edit that block.
  - `WorkScreenViews.swift`: this spec owns `WorkNotifyGridView` (P3 moves it to a new file); the sibling owns
    `WorkItemsView`.
  - `WorkSource.swift`: this spec adds `setNotify` under `// MARK: - Notify` and extends the notify decoding; the
    sibling adds `list(project:)` under its own mark and changes `detail`.
  The orchestrator merges both branches; a conflict outside these rules is a deviation to write down.

## Packages

### P1: the live Work screen without reload jumps

**Owner files:** `src/macos/GenesisKit/Sources/GenesisKit/Work/WorkScreenModel.swift` (`reload`, `isLoading`, the
change-stream task, `// MARK: - Live`), `src/macos/GenesisTools/Sources/Parts/Hub/Work/HubWork.swift`
(`WorkMain.header` only), `src/macos/GenesisKit/Tests/GenesisKitTests/WorkScreenTests.swift`,
`src/macos/GenesisTools/Tests/HubWorkTests.swift`
**Needs:** nothing
**Handoff:** closes p1 of `h_rkksvd0u`
**Decisions:**
1. The reload button goes away. ⌘R (a hub command for the Work mode, through the hub's existing command or menu
   routing, never a local key monitor) and an item "Read the work again" in the project row's context menu keep a
   manual reload for a stuck state. Ruled out: keeping the button, because the screen follows the store and the
   button invites a reload that changes nothing (Martin: "the rpc should be realtime so no need to refresh").
2. No progress indicator in the header for a background reload. The first load of a project shows its progress in
   the content area (the existing loading state), never in the header. Ruled out: a fixed-width slot for the
   spinner, because a spinner that turns every few seconds is motion that means nothing to the reader.
3. When live updates stop (`live == .stopped`), the header shows one small pill "Not live" in orange with a tooltip
   that says the reason in one sentence and a "Reconnect" action (`reconnect()`). The pill takes the place the
   button had, so nothing else moves when it appears. While `.catchingUp` nothing shows.
4. A reload keeps the reader's place: the containers that were open stay open (keyed by ref), the scroll position
   stays, and a row that a change removed fades out (`RowArrival`, or the transition `.genReveal` in reverse) instead
   of the list jumping. New rows fade in. Under Reduce Motion (`@GenReduceMotion`) both are instant.
5. A reload never replaces an equal snapshot: compare and assign only when the value changed (the snapshot is
   `Equatable`), so SwiftUI does no work for a change in another project.
6. A pending write (`pending` set) keeps its row's look until the reload after the write has arrived, so the row
   does not flash back to its old state between the write and the reload.
**Done when:** `bun scripts/native/swift-package.ts test --package-path src/macos/GenesisKit --filter WorkScreenTests`
passes with new cases: a background reload (a tick on a fake `changes()` stream) leaves `isLoading` false and the
header's text unchanged; a stream that ends sets `live` to `.stopped`, and `reconnect()` sets it back to `.live`
and reloads once; an equal snapshot does not publish a change (count `objectWillChange` emissions); the open
containers survive a reload. `bun run app:test -- --filter HubWorkTests` passes with a case that the header has no
"Read this project's work again" button and shows "Not live" only for `.stopped`.
**Targets:**
- ideally a background reload of an unchanged project costs under 5 ms on the main thread; way:
  `HubMainBusy.measure("work.reload")` around the assignment; source: tool; if not: write the number into Progress.
**Effort:** about three hours.
**Not in this package:** the Notifications pane.

### P2: the work.configSet action and WorkSource.setNotify

**Owner files:** `src/utils/work/api.ts` (the `configSet` entry), `src/utils/work/handlers.ts`,
`src/utils/work/formatters.ts`, `src/utils/work/rules/load.ts` (only if a batch writer is needed),
`src/utils/work/config-set.test.ts` (new),
`src/macos/GenesisKit/Sources/GenesisKitBase/Generated/GenesisToolsRPC.swift` (regenerated, never hand-edited),
`src/macos/GenesisKit/Sources/GenesisKit/Work/WorkSource.swift` (`// MARK: - Notify`, the notify decoding)
**Needs:** nothing
**Handoff:** closes p2 of `h_rkksvd0u`
**Decisions:**
1. One action with a scope and a `*` for a whole row or column, not one action per cell. Ruled out: the pane calling
   `configSet` ten times for a row, because ten file writes race the notifier's reads and give ten `work.changed`
   events.
2. The action lives in `workMethods`, so the CLI, MCP and service doors get it from the same table (the generated
   door rule of the work area). The existing `tools work config set <path> <json>` stays for any path; the new
   action is the typed door for notify rules only. Ruled out: a generic "set any path" action, because a surface that
   can write any path can break the file's rules section.
3. `minSeverity` survives a level change (see the interface freeze).
4. The action refuses `scope: "project"` without `project`, a `*` on both type and action, and an unknown project
   (one that has no items and no config section), each with a diagnostic code: `PROJECT_REQUIRED`, `TOO_WIDE`,
   `UNKNOWN_PROJECT`.
5. Regenerate the Swift client with `bun scripts/gen-genesis-tools-rpc-swift.ts` (read its header for flags) and
   commit the generated file in the same commit as the method.
**Done when:** `bun scripts/test.ts src/utils/work/config-set.test.ts src/utils/work/work.test.ts src/utils/work/wire.test.ts`
passes, with cases on a temporary config file: one cell written at project scope; a row (`action: "*"`) written in
one file write (count the document updates); `null` removes the key; a `{ level, minSeverity }` rule keeps its
`minSeverity`; the three refusals. `tsc-rs --noEmit -p tsconfig.json` shows only the known TS5115 error.
`bun scripts/native/swift-package.ts test --package-path src/macos/GenesisKit --filter WorkScreenTests` passes with a
fake source case for `setNotify`. A probe on a scratch home:
`GENESIS_TOOLS_HOME=/tmp/cc/GenesisTools/ae3ac312-7dbe-4045-970a-292aa93ed9ab/work-live-b/home ./tools work config-set ...`
(or the generated CLI name for the method) prints the changed paths, and `./tools work config --project <p> --json`
shows the new level with `from: "config.project"`.
**Targets:**
- ideally one row write takes under 50 ms; way: time the test's call; source: tool; if not: write it into Progress.
**Effort:** about three hours.
**Not in this package:** the pane.

### P3: the Notifications pane

**Owner files:** `src/macos/GenesisKit/Sources/GenesisKit/Work/WorkNotifyViews.swift` (new),
`src/macos/GenesisKit/Sources/GenesisKit/Work/WorkScreenViews.swift` (remove `WorkNotifyGridView` from it),
`src/macos/GenesisKit/Sources/GenesisKit/Work/WorkScreenModel.swift` (`// MARK: - Notify`),
`src/macos/GenesisKit/Tests/GenesisKitTests/WorkNotifyTests.swift` (new)
**Needs:** P2 (built)
**Handoff:** closes p3 of `h_rkksvd0u`
**Decisions:**
1. Keep a grid (types down, actions across): it is the right shape for 13 by 10 choices. Fix what makes it
   unreadable:
   - Column heads in words (table above), two lines at most, centred over their cells; row heads in type words.
   - A cell shows the level glyph and colour only; the word is in its tooltip and in the legend. A cell whose value
     is not the built-in default carries a small dot in the corner; the tooltip names the deciding layer ("This
     project", "All projects", "This repository's file").
   - The header row and the type column stay in place while the grid scrolls (pinned, as in a spreadsheet).
   - Alternate row fills (very faint) and a hover fill on the row and column under the pointer, so the eye finds
     the cell's type and action.
2. A click on a cell opens a menu (`MenuButton`): the four levels with glyph and word (the current one checked),
   a separator, "Use the built-in level (<word>)" (writes `null` at the layer that decides), and the scope:
   "For this project" (default) or "For all projects". A cell decided by the repository file is read-only: the menu
   says "Set in <repo>/<file>" and offers "Open the file" (`PathOpener`).
3. A click on a row head opens a menu that sets the whole row (`action: "*"`); a click on a column head sets the
   whole column (`type: "*"`). Each asks nothing more: the change is one write, and Undo is offered in the outcome
   pill (it writes the previous values back, which the model kept).
4. Above the grid: one line that explains the screen ("Who hears about each change to this project's work. Click a
   cell to change it.") and a type filter field (the same look as the sibling's find field, local to this pane) that
   hides rows not matching.
5. Below the grid: the legend (glyph, word, detail sentence per level) and a disclosure "Command line" that shows
   the `tools work config set` form for the last changed cell with a copy button. The CLI line is no longer shown by
   default.
6. A pending cell shows its new glyph at half opacity until the reload confirms it; a failed write puts the old
   glyph back and shows the error pill (`FailureReport`, never a raw error string).
7. The grid rows are `Equatable` value views with `.liveRow`, so a hover or a write re-renders one row, not the
   grid.
**Done when:** `bun scripts/native/swift-package.ts test --package-path src/macos/GenesisKit --filter WorkNotifyTests`
passes with: the grid draws "Reopen not delivered" and no raw token (`reopen-undelivered`, `sync-held`) anywhere;
a cell menu lists the four level words and marks the current one; choosing "Inbox line" calls the fake source's
`setNotify` with `scope: .project, type: "bug", action: "spotted", level: "inbox"`; a row-head choice calls it once
with `action: "*"`; a repo-decided cell has no level items; the type filter "bu" leaves only the Bug row. The picture
pair `work-notify-before.png` / `work-notify-after.png` (test-drawn, fixture data, same size) is written when
`WIDGET_SHOTS` is set.
**Targets:**
- ideally a hover over a cell re-renders one row; way: a `RenderProbe` count or an `objectWillChange` count in the
  test; source: tool; if not: write it into Progress.
**Effort:** about four hours.
**Not in this package:** severity thresholds (`minSeverity`) in the editor: show them in the tooltip ("only high and
above"), but editing them is a later step (write it under "Seen, not fixed").

### P4: picture pairs, the ux checklist pass and the gate

**Owner files:** none new; fixes go into the files of P1 to P3.
**Needs:** P1 (built), P3 (built)
**Handoff:** closes p4 of `h_rkksvd0u`
**Decisions:**
1. Walk `.claude/skills/ux/references/checklist.md` over every view this spec added or changed, and run
   `bun .claude/skills/ux/scripts/ux-scan.ts <changed swift files>`. Fix what fails, in this package. A defect in a
   view this spec did not touch is filed with `tools work spot "<title>" --type bug --where <file:line>
   --user-sees "<what a user sees>"`, not fixed.
2. Verify the motion of P1 with instruments, not one picture (`.claude/skills/ux/references/motion.md`): a sequence
   of off-screen frames across a background reload shows the header pixels unchanged (crop the title bar strip and
   compare), and a removed row fades.
3. Picture pairs (same size, fixture data): the header before and after (with the reload button, then without it,
   then with "Not live"); the grid before and after; an open cell menu; the row-head menu. Write them under the
   scratch folder and list them in Progress. Pictures of real data stay local.
**Done when:** gate commands 1 to 6 under "Rules for the executor" pass on the branch head (first:
`bun scripts/native/swift-package.ts test --package-path src/macos/GenesisKit --filter 'WorkScreenTests|WorkNotifyTests'`),
every pair exists, the header strip comparison shows zero changed pixels across three background reloads, and
Progress lists each checklist item that did not apply with one reason.
**Effort:** about two hours.
**Not in this package:** new features found during the pass (they go to "Seen, not fixed").

### The header, before and after (P1)

Before (today, at 1300 pt), the title bar row reads left to right:

```
[checklist glyph] Work  GenesisTools  47 containers · 50 spotted items · 0 reopened items   [Items|Notifications] (spinner) [⟳]
```

The spinner appears for each background reload and pushes the tabs and the reload button to the left, then they move
back. After this package:

```
[checklist glyph] Work  GenesisTools  47 containers · 50 spotted items · 0 reopened items   [Items|Notifications]
[checklist glyph] Work  GenesisTools  47 containers · 50 spotted items · 0 reopened items   [Items|Notifications] (Not live ⟲)
```

- The second line is the `.stopped` state only. The pill sits at the trailing end, where the button was, and it is
  the last element, so its appearance moves nothing to its left.
- The counts are buttons that scroll to their sections (commit `a57efd5263` on unified, `b903f38959` on the fixes
  branch). Keep them; when the branches merge the orchestrator resolves the header with both changes.
- Nothing in the row changes its width during a background reload: the counts change only when a number changes,
  and their font uses monospaced digits (`.monospacedDigit()`) so "9" to "10" moves only what follows the number.

### The live path in detail (P1)

1. The model starts the change stream when the Work mode becomes visible and the project is set; it stops it when
   the hub hides (the existing `HubVisibility` gate) and starts it again on show, with one reload on show.
2. A tick starts a 3 s window (the existing throttle). The reload in that window runs off the main thread; only the
   final assignment of a changed snapshot happens on the main actor.
3. If the stream ends (the service quit, a socket error), the model sets `.stopped(reason:)` with the reason in one
   sentence ("The GenesisTools service stopped."), and tries `reconnect()` by itself after 5 s, 15 s and 60 s; after
   the third failure it waits for the reader's "Reconnect".
4. After the Mac wakes from sleep, the model reloads once and restarts the stream (`NSWorkspace.didWakeNotification`),
   because the socket may have died without an end event.
5. A write from this screen does not wait for the tick: it reloads once when its call returns, and the tick that
   follows finds an equal snapshot and publishes nothing (decision 5).
6. `HubPerf` spans: `work.live.tick`, `work.live.reload`, `work.live.reconnect`, so `tools hub dev monitor` shows a
   storm of reloads if one starts.

### Keyboard in the grid (P3)

- The grid takes focus on click. ←, →, ↑ and ↓ move a focus ring from cell to cell; Space or Return opens the cell's
  menu; Esc leaves the grid. Row and column heads take focus the same way at the edges.
- The focus ring is the kit's focus look (no custom colour). The focused cell's row and column get the same faint
  cross-hair fill as hover.
- Keys work only while the grid has focus, never while the type filter field has it.

### Test fixtures (P2, P3)

- P2: a temporary config file per test (`configPath` argument), seeded with: no notify section; a project section
  with `bug.spotted = "inbox"`; a project section with `bug.reopened = { level: "banner", minSeverity: "high" }`; a
  global section with `task.finished = "off"`. The tests read the file back and compare the JSON, not the reply only.
- P3: a fake `WorkSource` whose `notify(project:)` returns three types (bug, task, handoff) by all ten actions, with
  one cell from each layer (`default`, `config.global`, `config.repo`, `config.project`) and one cell with a
  `minSeverity`, and whose `setNotify` records its calls. Titles and project names are invented (`Orchard`).

### Walkthrough: what the reader sees (P4 checks each story)

1. An agent spots a bug while the reader looks at the Items pane. Within about 3 s the new row fades in under
   "Spotted"; the header's "50 spotted items" becomes "51 spotted items"; nothing else in the header moves; the
   scroll position stays.
2. The reader finishes a task from its row. The row shows its new state at once (pending look), the outcome pill
   says "Finished", and when the reload arrives the row keeps that look without a flash back.
3. The reader quits the GenesisTools service from the menu bar. Within a few seconds the header shows "Not live";
   its tooltip says why. The service starts again; within 5 s the pill goes away by itself.
4. The reader opens Notifications, sees "Bug" by "Spotted" with the tray glyph in blue, hovers it and reads "Inbox
   line: a quiet line in your inbox. Set for this project." Clicks it, chooses "Inbox and banner"; the cell turns
   orange with the bell glyph, half opacity until the reload confirms it.
5. The reader clicks the "Commented" column head and chooses "Nobody". Every cell of the column shows the bell-slash
   glyph; the outcome pill says "Commented: nobody hears about it, for 13 types" with "Undo"; Undo restores each cell.
6. A cell set in the repository's file shows a lock glyph in its tooltip line and its menu offers only "Open the
   file".
7. The reader types "ha" in the type filter; only "Handoff" stays; Esc clears the field and every row comes back.

### Empty, loading and failure states (P1, P3)

- First load of a project: the content area shows the loading state; the header shows the project and nothing that
  turns.
- The notify read failed: `FailureInline(.unexpected(error, outcome: "The notification rules did not load", action:
  "Read the rules"), form: .pane)` with retry, in place of the grid.
- A project with no rule anywhere: the grid shows the built-in levels with no dots, and the explanation line adds
  "Every cell uses the built-in level."
- The actions service is down: writes are disabled with the tooltip "Changes need the GenesisTools service; it is
  not running", and the header shows "Not live".
- A write races another writer (the CLI changed the same cell): the reload after the write shows the store's value;
  the outcome pill says "Changed by another writer" when the value read back is not the one written.

## Rules for the executor

- A package is done when its "Done when" holds and the gate passes. Tick its handoff task with the command, where
  it ran and the commit. Then start the next package.
- A number shows a direction. It is a gate only where the package says `gate: yes` (none here).
- When a measurement shows a target is out of reach, write the number and the reason into Progress and go on. Ask
  the owner about all such limits in ONE question at the end.
- While you verify, fix a new thing only when it loses data, shows an invented fact or blocks the package. Each other
  thing is one line under "Seen, not fixed", and a `tools work spot` item when it is outside this spec's views.
- The handoff tasks and Progress are the only lists. Make no second checklist.
- A fix that needs a new library, a new service or a large new feature is the owner's decision: write what it costs
  and what it buys under "Seen, not fixed" and go on.
- Write each deviation from the spec under "Deviations" with the reason.
- After a compaction, read "Read this first after a compaction" before the next tool call.
- Repository rules this change touches:
  - Use the shared components (`.claude/rules/macos-app.md` table): `IconButton` with a tooltip for every icon-only
    button, `.genHoverPlain()` / `.rowButton` for every other clickable thing, `MenuButton` for pull-downs (never a
    SwiftUI `Menu` in a header), `NoticePill`, `FailureInline` / `FailureReport` for failures (never
    `error.localizedDescription` in a `Text`), `GenDisclosure` for the "Command line" disclosure, `CopyChip`.
  - Every animation reads Reduce Motion through `@GenReduceMotion` and uses `GenMotion` curves.
  - A view body only reads cached state; every RPC call runs in the model.
  - TypeScript: the work area's method table, handlers and formatters pattern (read two existing methods first);
    zod params; no `any`; a diagnostic code per refusal; tests on a temporary config path
    (`.claude/rules/tests.md`). A new method name passes `bun scripts/ci/check-package-boundaries.ts`.
  - Every behaviour a reasonable user could want another way ships as a setting with your pick as its default
    (`.claude/rules/opinionated-settings.md`); name each one in Progress. (The default scope "For this project" is
    such a choice: the menu offers the other one, so no extra setting is needed.)
  - Text in the UI: sentence case, no em or en dash, no raw token shown as is.
- Swift builds in a linked worktree: `bun scripts/native/swift-package.ts test --package-path src/macos/GenesisKit
  --filter <names>` for GenesisKit, `bun run app:test -- --filter <names>` for the app (it builds in the worktree's
  own `.build/opt`; it never installs). Run `bun install` once in the worktree first.
- The gate, on the branch head, in the worktree, one Swift command at a time:
  1. `bun scripts/native/swift-package.ts test --package-path src/macos/GenesisKit --filter 'WorkScreenTests|WorkNotifyTests'`
  2. `bun run app:test -- --filter HubWorkTests`
  3. `bun scripts/test.ts src/utils/work`
  4. `tsc-rs --noEmit -p tsconfig.json` (the known TS5115 zod error is not yours)
  5. `bun scripts/ci/lint-rules.ts` and `bun scripts/git/check-commits.ts origin/feat/2026-11-19-work-find-live..HEAD`
  6. `bash scripts/ci/placeholder-check.sh`
- Commits: one per package, titled like `feat(GenesisHub, work): the Work screen follows the store with no reload
  button and no moving header` (Swift) or `feat(tools): work configSet writes notify rules for a cell, a row or a
  column` (TypeScript). No agent attribution.
- When every package is done: tick the last task, send `finish_handoff`, and end your run with one line:
  `branch feat/2026-11-19-work-live-b, head <sha>, gate <passed|failed: what>`.

## Decisions

- No decision was asked. Martin's order (2026-11-19 00:40): "spec them ... and just make sure astras do them".

### Decisions the planner made

- The reload button is removed; ⌘R and a context-menu item stay for a stuck state.
- No header spinner for a background reload; a "Not live" pill only when live updates stop.
- One typed action `work.configSet` for notify rules, with `*` for a row or a column, one file write per call.
- The pane writes the project layer by default, the global layer on request, never the repository file.
- The grid stays a grid, with words, glyph and colour per level, pinned heads and hover cross-hair.
- The CLI line moves into a closed "Command line" disclosure.
- Editing `minSeverity` is out of this round; it shows in the tooltip.
- Reconnect tries by itself after 5 s, 15 s and 60 s, then waits for the reader.
- The header counts use monospaced digits, so a count change moves only what follows it.
- A whole-row or whole-column change asks nothing; Undo in the outcome pill restores the previous values.
- The grid takes keyboard focus on click; arrow keys move between cells, Space opens the cell menu.

## Progress

- 2026-11-19 00:57 Claimed h_rkksvd0u on the requested branch at 49ff462117. bun install passed.

- 2026-11-19 01:12 P1 model/header and capture tests are staged; native gate is queued behind another worktree. During the Swift wait, P2 focused tests passed (19), TS5115 was the only type diagnostic, and scratch CLI config-set plus config --json verified inbox from config.project in Orchard. Evidence: /tmp/cc/GenesisTools/ae3ac312-7dbe-4045-970a-292aa93ed9ab/work-live-b/probe-write.log and probe-read.json.

- 2026-11-19 01:16 P1 committed locally as d099e7a7be; its Swift gate is pending. P2 typed Swift calls and Undo receipt decoding joined the worktree while the shared build slot is occupied. The queued kit run will exercise both packages.

- 2026-11-19 01:27 P2 is committed as 4d28b6d833. The first native build compiled the Work product and exposed a read-only system environment key in two test fixtures. Switched the fixtures to the kit’s writable Reduce Motion environment. The wider work and registry run passed 119 tests; the row write plus Undo test took 3.49 ms on its first run.

- 2026-11-19 01:34 The native product compiled. A fixture correction is queued for WorkScreenTests and the original grid capture. P3 scratch drafts are in /tmp/cc/GenesisTools/ae3ac312-7dbe-4045-970a-292aa93ed9ab/work-live-b (WorkNotifyViews.swift, P3Model.swift, P3Tests.swift, P3MenuButton.swift, assemble-p3.py); integrate after the baseline is captured. The handoff tasks remain open pending native verification.

- 2026-11-19 01:47 The 13 WorkScreenTests, including real socket EOF and the generated null edit, passed. The original 2200×1200 grid capture is /tmp/cc/GenesisTools/ae3ac312-7dbe-4045-970a-292aa93ed9ab/work-live-b/work-notify-original-ImageRenderer.png. Removed-row capture passed its assertions, but the one failing calibration made it inconclusive. Changed the recorder to yield between every frame and require distinct intermediate values. P3 is integrated, with the first combined gate queued.

- 2026-11-19 01:51 Folded the motion fixture correction into P1 and the wildcard/readback metadata into P2. The first three package commits are e0dadd2b50, 971cd484cb and 7e230698e6; before/after history preparation had the identical tree 2688726a57724ffe58be0e2bff0f17dc94950e11. ConfigSet service tests passed for a human edit, a rejected agent edit, dry-run and no-op event counts.

- 2026-11-19 02:08 First combined visual run: zero value-row evaluations for a crosshair move; unchanged model read 0.082 ms including task resumption. The real removal recorded 0.87 and 0.13 of the original ink, with none intermediate under Reduce Motion. The corrected calibration passed. The first menu rendering drew symbols without titles and unhosted NSMenu dispatch missed two bulk actions; those fixtures were corrected for the next gate.

- 2026-11-19 02:10 UX checklist, pointer and layout: each actionable cell has a native menu, full cell hit area, label and identifier. Header recovery reserves its width; the column highlight and type rail stop at the last row. The existing project sidebar and Items content retain their ownership. Media thumbnails, drop targets, drag edges, pane resize, sticky session order, notch/rail bubbles, video and attachment previews do not apply to a rules table.

- 2026-11-19 02:10 UX checklist, keyboard and accessibility: grid arrows reach the pinned heads, Return and Space request the selected menu, Escape exits the grid or clears the filter. The project context command also has the existing hub reload shortcut. Composer send/newline keys, staged text on dismissal and multi-step confirmation keys do not apply. VoiceOver, Full Keyboard Access and OS preference changes were outside the authorized scope. Test hosts use the kit’s Reduce Motion environment.

- 2026-11-19 02:10 UX checklist, feedback and recovery: first reads, stale reads, saving, failure and disconnected states have separate presentations. Writes retain their pending look through readback; notices float, offer Undo for saved rules or Details for a failure. Media capture/cancel, login and privacy grants, agent approvals, dangerous deletions, unsent drafts and modal confirmations do not apply to reversible rule edits.

- 2026-11-19 02:10 UX checklist, windows, attention and settings: this work adds no production window, title-bar drag behavior, overlay panel, sound, delivery channel or system notification. Dock activation, display placement, window restore/minimum sizes, timers for attention flashes, quiet hours and audio previews therefore do not apply. The scope menu defaults to For this project; For all projects edits the existing global layer. Command line starts closed. Reduce Motion uses the established setting. The disk schema gains no preference keys.

- 2026-11-19 02:10 UX checklist, words and loading: action/type/level/layer labels come from the Work vocabulary. Filtering keeps the viewport; a selected cell shows pending and then the confirmed rule. Time links, transcripts, mixed media, grouped session lists, file diffs/renames, tab-switching commands, badges for unread inbox totals and draggable shelves are outside this view. Menu and grid captures use fixture state; foreground operation of the installed app was excluded by the brief.

- 2026-11-19 02:49 Hub capture: zero changed pixels in each of nine strips from three slow background reads, zero changes left of the stopped pill, and 7,986 moving pixels in the old spinner control. Frame size 2600×104. After the shared Mac’s Vision accurate recognizer reported E5RT/InvalidTransition before recognizing text, the fixtures adopted the fast CPU recognizer, which the existing native test suite uses for rendered labels. The final kit and hub gates are rerunning in order.

- 2026-11-19 03:05 Picture pairs use /tmp/cc/GenesisTools/ae3ac312-7dbe-4045-970a-292aa93ed9ab/work-live-b/. Header, 2600×104: header/work-header-before.png, header/work-header-after.png, header/work-header-stopped.png and header/work-header-reconnected.png. The nine waiting, slow and settled strips are recorded in header/work-header-pixels.json. Grid, 2200×1200: work-notify-before.png and work-notify-after.png. work-notify-cell-menu.png and work-notify-row-menu.png are offscreen drawings of the production NSMenu entries over the grid at their measured anchors. The baseline, fixture and menu provenance stay alongside the PNGs.

- 2026-11-19 03:07 At final head ea26030d31, all 114 Work tests, lint, commit subjects, generated outputs, package boundaries and the placeholder probe pass. The only TypeScript diagnostic is the allowed TS5115 at evaluate.ts:7. The serialized native gates are queued behind Swift builds and a sibling inbox-feed2 wrapper (PID 14567) whose command line matches this worktree’s pgrep check. macOS excludes ancestors from pgrep by default, so the sibling’s own check can finish normally.

- 2026-11-19 03:25 GenesisKit passed all 22 cases on ea26030d31, including the calibrated fade and Reduce Motion controls. The equal read emitted zero changes and took 0.100 ms including task resumption. The remaining hub wait was restarted with the repository lock and exact process names (pgrep -x for swift-build, swift-test and swift-frontend, in a 20 s loop), per the corrected rule.

- 2026-11-19 03:31 Gate passed on ea26030d31e02151e5cd64cece03cf8dc2e08da3. Local commits in order: e0dadd2b50 (quiet live header), 971cd484cb (atomic rule edits and Undo), 7e230698e6 (editable notification grid), ea26030d31 (rendered verification). Native tests passed 22/22 in GenesisKit and 13/13 in HubWorkTests; Work passed 114/114, service 6/6. tsc-rs returned only the allowed TS5115, lint checked 11,040 files, four commit subjects passed, and 813 placeholder patterns matched nothing. Generated files and package boundaries passed. All nine reload frames matched, row opacity reached 87%, 9% and 2% before disappearing, and Reduce Motion had zero intermediate frames. All four handoff tasks checked and finish_handoff accepted.

## Seen, not fixed

- 2026-11-19 01:01 Severity thresholds remain editable in the config file. The grid displays the configured threshold; changing a level preserves it.

- 2026-11-19 02:08 The assigned base renders counts as one summary. Keep the parallel clickable counts when merging the header. The legacy config read still reports per-surface delivery overrides; this editor changes the four project-rule layers described above.

## Deviations

- 2026-11-19 00:57 The direct MCP connector had no caller session and the handoff CLI has no get command. tools scripts call genesis-tools.handoff_get inherited the Codex identity and confirmed the claim.

- 2026-11-19 00:59 The shared RPC event stream never ended on socket loss. Added opt-in disconnect completion in its generator and regenerated the client. The existing Work file watch also observes machine config changes. Existing event subscriptions keep their reconnect behavior.

- 2026-11-19 01:47 For cells that inherit from a stronger remaining rule, reset names the actual inherited level. A wildcard-decided level cannot be removed for a single cell; its menu explains this and still allows a concrete override. Bulk edits skip repository-decided cells in the same transaction.

- 2026-11-19 01:51 The existing notify entry takes only project and rows inside an outer ScrollView. WorkMain.body now hosts the editable pane, notice stack and first-load/row-motion modifiers; the existing WorkMain.content and WorkItemsView bodies were left intact for the sibling. The project row hosts the specified context action. MenuButton gained optional symbols, identifiers and a keyboard anchor, with existing defaults.

- 2026-11-19 02:49 Scratch homes have separate app/build.lock files. The final runners also acquire the real shared cross-worktree build slot, then pass the required empty pgrep check before launching each command with the scratch home. No installed app or OS accessibility setting is changed.

- 2026-11-19 03:05 Final fixture OCR uses the accurate revision 1 recognizer on CPU, including for small counts. The calibration and production opacity tests now require intermediate ink to exceed five times the measured fit error, use the same criterion for instant removal and Reduce Motion, and require two distinct intermediate ink levels for a fade.
