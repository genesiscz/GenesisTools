# Work screen: find, filter and read every item in full: build spec

**Status:** 2026-11-19 00:45, ready for an executor. No decision is open.
**Goal:** On the hub's Work screen the reader finds any item of a project by words and by filters, and reads one
item in full (its fields, its tasks, its references, its commits and files, its history) beside the list, and acts
on it there.
**Non-goals:** the list below.
- No change to the Notifications pane, the live reload or the title bar's reload control. The second spec owns
  them: `.claude/plans/2026-11-19-WorkLiveAndNotify.md`. Do not edit its owner regions (named under "Order").
- No new store, no new service, no new transport. Every read and write goes through `GenesisToolsRPC.work.*`
  (the actions service), which the screen uses today.
- No server-side text search. The search runs in Swift over rows the screen already reads (decision 2 of P1).
- No change to the widget's Tasks module or its links into Work, except that a link must still land on the item.
- No VoiceOver, Full Keyboard Access or OS accessibility settings work (ux skill, "Accessibility scope": not
  confirmed for this task). Keep every existing accessibility label and identifier, and give each new control a
  label and an identifier.
**Executor:** one Codex child (`gpt-6.2-astra`, reasoning effort `xhigh`) builds P1 to P5 in order in its own
worktree, on branch `feat/2026-11-19-work-find-a`, and commits per package (or per two packages when they are
small). It may spawn its own explorer or worker subagents (in the same worktree) to read code or to try a design;
it alone commits. It reads only this file and what it links.

## Read this first after a compaction

- Owner's words for this work (Martin, 2026-11-19 00:40, with a picture of the Work page):
  - "ur happy with this yeah? theres no filter, no search, no details of the tasks"
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
    `/tmp/cc/GenesisTools/ae3ac312-7dbe-4045-970a-292aa93ed9ab/work-find-a/`.
  - No agent attribution in commits (no `Co-Authored-By`, no "Generated with"). Commit titles follow
    `scripts/git/commit-scopes.ts`; check with `bun scripts/git/check-commits.ts origin/feat/2026-11-19-work-find-live..HEAD`.
  - Typecheck TypeScript with `tsc-rs --noEmit -p tsconfig.json` (never `tsc`). Tests with `bun scripts/test.ts <paths>`
    (never bare `bun test`).
  - No real person, client or tracker name in code, tests, fixtures or commit messages. Pictures of real data stay
    in the scratch folder and are never committed.
- Progress is under "Progress" at the end of this file (in the MAIN checkout:
  `/Users/Martin/Tresors/Projects/GenesisTools/.claude/plans/2026-11-19-WorkFindAndDetails.md`). Read it before you
  open code.
- Easy to get wrong:
  1. The Items pane today shows only OPEN work (open containers from `work.tree`, the spotted and the reopened rows
     from `work.triage`). Search must also find done and dropped items; they come from `work.list` (P1), shown in
     their own results section, never mixed into the open sections.
  2. A filter never empties a container silently: a container whose members match stays, opens, and shows only the
     matching members with "3 of 12 tasks match".
  3. The detail is beside the list (an inspector) on a wide window and replaces the list on a narrow one. The
     route `work=<ref>` (hub links, the widget's task links) selects the item in both cases.

## Sources

- Handoff `h_kxboe8h2` (name `work-find-and-details`), tasks `p1` to `p5`, one per package.
  - Read: MCP `handoff_get { id: "h_kxboe8h2" }`; claim: `handoff_get { id: "h_kxboe8h2", claim: true }`.
  - Tick: `handoff_action { id: "h_kxboe8h2", actions: [{ action: "check_task", taskId: "p1", proof: { answer:
    "<the Done when check, where it ran>", commitIds: ["<sha>"] } }] }`.
  - Deny: `{ action: "deny_task", taskId: "p4", reason: "<why>" }`. Comment: `{ action: "comment", text: "..." }`.
  - CLI form: `tools handoff get h_kxboe8h2`, `tools handoff action h_kxboe8h2 --help`.
- The sibling spec `.claude/plans/2026-11-19-WorkLiveAndNotify.md` (handoff `h_rkksvd0u`). Its executor works at
  the same time on branch `feat/2026-11-19-work-live-b`. The owner regions under "Order" keep you apart.
- Martin's picture of the Notifications pane (local only):
  `/Users/Martin/.t3/userdata/attachments/mcp-launch-5fe9e8ac24cb1629aa273835df4df46e93c91fa4b47199d7e9d743de4d675da2-79c13b43-ee82-467e-96bc-79409f1e0de1.png`.
- A picture of the Items pane with real data, before this work (local only, it shows real titles):
  `/tmp/cc/GenesisTools/ae3ac312-7dbe-4045-970a-292aa93ed9ab/uxpass/hub-work-live.png`.
- The ux skill: `.claude/skills/ux/SKILL.md`, and in full before P2: `.claude/skills/ux/references/checklist.md`,
  `.claude/skills/ux/references/genesiscz.md`, `.claude/skills/ux/references/findings.md`. The swift skill:
  `.claude/skills/swift/SKILL.md` (performance of lists, `Equatable` rows, `.liveRow`).
- Design authorities to load before a judgment call: the `macos-golden-gate-design` and `apple-hig-expert` skills
  (inspector layout, search field, filter controls).
- Repository rules that apply: `.claude/rules/macos.md`, `.claude/rules/macos-app.md` (the components table: use
  it), `.claude/rules/macos-app-verify.md`, `.claude/rules/opinionated-settings.md`, `.claude/rules/tests.md`,
  `.claude/rules/code.md`, `.claude/rules/tools.md`.

### Truth table (checked 2026-11-19 00:45 at `293c1a9048`, branch `feat/2026-11-19-work-find-live`)

| # | Claim | State | Proof |
|---|---|---|---|
| 1 | The Items pane lists open containers (with members), spotted rows grouped by type, and reopened rows with no worker; there is no search field and no filter | holds | `WorkItemsView` in `src/macos/GenesisKit/Sources/GenesisKit/Work/WorkScreenViews.swift:32-70`; the only `TextField` in the Work files is the reason popover |
| 2 | The snapshot comes from `work.tree` (containers) and `work.triage` (spotted, reopened) for one project | holds | `WorkSource.snapshot` in `src/macos/GenesisKit/Sources/GenesisKit/Work/WorkSource.swift` (the `rpc.work.tree` and `rpc.work.triage` calls) |
| 3 | `work.list` takes `project`, `under`, `spottedIn`, `state[]`, `type[]`, `tag`, `severity[]`, `worker`, `fields[]`, `limit` (max 5000); it has no text query | holds | `list` in `src/utils/work/api.ts` |
| 4 | `WorkItemDetail` decodes only `item.{id,title,type,state,project,body,acceptance}` and `members` | holds | `src/macos/GenesisKit/Sources/GenesisKit/Work/WorkItemDetail.swift:1-14` |
| 5 | `work.show` returns `item` (with `fields` such as `where`, `why`, `userSees`, plus `severity`, `tags`, `rev`), `refs` (`out`, `in`, each with `kind`, `to`/`from`, `by`), `pointers` (`kind`: `commit`, `file`, ...; `target`), and `log` (events with `ts`, `actor`, `kind`) | holds | `tools work show w_5d4ch4ts --json` read 2026-11-19 00:44 |
| 6 | The hub opens an item through the route `work=<ref>`: `WorkScreenModel.openItem(_:)` sets `itemRef`, and `WorkMain` then REPLACES the list with a detail (title, type, state, id, body, acceptance, tasks) and an "All items" back button | holds | `WorkScreenModel.swift:41,143-155`, `src/macos/GenesisTools/Sources/Parts/Hub/Work/HubWork.swift:183-230`, `HubNavigation.swift` key `work` |
| 7 | Row actions exist: accept, drop (reason), finish (proof), reopen (reason), add to a handoff, pair, unpair, sync | holds | `WorkScreenAction` in `WorkSource.swift`, `actions(ref:state:accept:)` in `WorkScreenViews.swift` |
| 8 | `rpc.work.comment`, `rpc.work.claim`, `rpc.work.release` exist in the generated client | holds | `src/macos/GenesisKit/Sources/GenesisKitBase/Generated/GenesisToolsRPC.swift:19543-19547` |
| 9 | Item states are `spotted, open, active, done, dropped, reopened`; severities `critical, high, medium, low`; types are in `ITEM_TYPES` | holds | `src/utils/work/model/vocab.ts:6-27` |
| 10 | Real data, project GenesisTools: 46 to 47 open containers and 48 to 50 spotted items; the spotted section starts below the first screen | holds | the live snapshot of 2026-11-19 00:29 (picture above) |
| 11 | Hub preferences live in `HubPreferences` (GenesisKit); a side panel is `ResizableSidePanel` | holds | `src/macos/GenesisKit/Sources/GenesisKit/Settings/HubPreferences.swift:174`, `HubPRs.swift:2797` |

## Interface freeze

The executor changes this section first (with a dated line) when code forces a change.

### Files

- `src/macos/GenesisKit/Sources/GenesisKit/Work/WorkItemDetail.swift`: the full detail model (P1).
- `src/macos/GenesisKit/Sources/GenesisKit/Work/WorkFilter.swift` (new): the filter value and its matcher (P1).
- `src/macos/GenesisKit/Sources/GenesisKit/Work/WorkFindBar.swift` (new): the find bar view (P2).
- `src/macos/GenesisKit/Sources/GenesisKit/Work/WorkItemInspector.swift` (new): the inspector view (P3).
- `src/macos/GenesisKit/Tests/GenesisKitTests/WorkFindTests.swift` (new): P1 to P4 tests.
- Edited: `WorkSource.swift` (one new read), `WorkScreenModel.swift` (filter, index, selection), `WorkScreenViews.swift`
  (Items pane filtering), `HubWork.swift` (the split), `HubPreferences.swift` (one setting).

### The detail model (P1)

```swift
public struct WorkItemDetail: Decodable, Equatable, Sendable {
    public struct Item: Decodable, Equatable, Sendable {
        public var id: String
        public var title: String
        public var type: String
        public var state: String
        public var project: String?
        public var body: String?
        public var acceptance: String?
        public var severity: String?
        public var worker: String?
        public var tags: [String]?
        public var rev: Int?
        /// The type's own fields (`where`, `why`, `userSees`, and any rule-defined field), as text.
        public var fields: [String: String]?   // decode strings; a non-string value is rendered as compact JSON
    }
    public struct Ref: Decodable, Equatable, Sendable, Identifiable {
        public var kind: String          // e.g. "spotted-in", "member-of", "blocks"
        public var other: String         // the ref at the far end (`to` for out, `from` for in)
        public var outgoing: Bool
        public var byTitle: String?      // `by.sessionTitle` when present
        public var id: String { (outgoing ? "out:" : "in:") + kind + ":" + other }
    }
    public struct Pointer: Decodable, Equatable, Sendable, Identifiable {
        public var kind: String          // "commit", "file", "pr", "url", ...
        public var target: String
        public var id: String { kind + ":" + target }
    }
    public struct Event: Decodable, Equatable, Sendable, Identifiable {
        public var seq: Int
        public var ts: Date
        public var kind: String          // the log event kind
        public var actor: String         // a readable actor: session title, "you", or the harness
        public var summary: String?      // the event's own note, reason, proof or comment text
        public var id: Int { seq }
    }
    public var item: Item
    public var members: [WorkRowValue]?
    public var refs: [Ref]
    public var pointers: [Pointer]
    public var log: [Event]
}
```

- The decoder is tolerant: a missing `refs`, `pointers` or `log` decodes as `[]`; an unknown pointer kind is kept.
- The todo fallback in `WorkSource.detail` (a `question` todo) fills only `item` and empty lists.

### The filter (P1)

```swift
public struct WorkFilter: Equatable, Sendable {
    public var text: String = ""                 // words; every word must match (AND), case and diacritics folded
    public var types: Set<String> = []           // empty = every type
    public var states: Set<WorkFilter.StateGroup> = [.open]
    public var severities: Set<String> = []      // empty = any severity, including none
    public var mine: Bool = false                // worker is this person (the hub's own identity) or unclaimed by agents
    public enum StateGroup: String, CaseIterable, Sendable { case open, spotted, reopened, done, dropped }
    public var isActive: Bool { get }            // anything other than the default
    public static let `default`: WorkFilter
    public func matches(_ row: WorkFilter.Row) -> Bool
    public struct Row: Equatable, Sendable {     // one searchable row, from a member, a triage row or a list row
        public var ref: String; public var title: String; public var type: String; public var state: String
        public var severity: String?; public var worker: String?; public var text: [String]   // where, why, slot
    }
}
```

- `StateGroup.open` covers `open` and `active`. `spotted` and `reopened` are their own groups. The default filter is
  `[.open, .spotted, .reopened]`, which shows what the pane shows today.
- A word matches a row when it is a prefix of a word of the title, the ref, the type, the worker, or any `text`
  entry. A ref typed in full (`w_5d4ch4ts`, `h_kxboe8h2`) matches exactly and ranks first.

### The model (P1, P4)

```swift
// WorkScreenModel additions
@Published public var filter: WorkFilter                  // reset to .default when the project changes
@Published public private(set) var index: [WorkRowValue]  // every item of the project from work.list, loaded once per
                                                           // project and again when the store changes, only while a
                                                           // filter includes .done or .dropped or text is not empty
@Published public var selection: String?                  // the selected ref; the inspector shows it
public func select(_ ref: String?)                        // sets selection, loads the detail, writes the route
public func moveSelection(_ step: Int)                    // keyboard: next or previous visible row
public var visibleRefs: [String] { get }                  // the refs in on-screen order, after the filter
```

- `openItem(_:)` (the route) stays and calls `select(_:)`. `itemRef` and `itemDetail` stay as they are; `selection`
  equals `itemRef` once selected. The executor may merge them if every caller still compiles and the route works.

### The setting (P4)

- `HubPreferences.workDetailPlacement: String`, values `"beside"` (default) and `"replace"`, persisted with the other
  hub preferences. Settings row in the hub's settings page where the Work mode's other settings live (or the
  General page if there are none), titled "Item details", detail "Beside the list, or in place of the list".
- On a window narrower than 900 pt the inspector replaces the list whatever the setting says.

### Words on screen (P2, P3)

No raw token from the store reaches the screen. One table in `WorkFilter.swift` (`WorkWords`) maps each token, and
both the find bar and the inspector read it. A token missing from the table shows capitalised with dashes as spaces.

| Token | Words |
|---|---|
| states `spotted, open, active, done, dropped, reopened` | Spotted, Open, Active, Done, Dropped, Reopened |
| state group `open` (filter menu) | Open or active |
| types `epic, handoff, feature, bug, incident, task, test, cleanup, check, idea, risk, limit, todo` | Epic, Handoff, Feature, Bug, Incident, Task, Test, Clean-up, Check, Idea, Risk, Limit, To-do |
| severities `critical, high, medium, low`, none | Critical, High, Medium, Low, Not judged |
| refs out `parent, member, related, duplicate-of, recheck-of, follow-up-of, blocks, spotted-in` | Part of, Has task, Related to, Duplicate of, Recheck of, Follow-up of, Blocks, Spotted in |
| refs in (same kinds, seen from the other side) | Has part, Task of, Related to, Has duplicate, Rechecked by, Followed up by, Blocked by, Spotted here |
| pointer kinds `commit, file, pr, url` | Commit, File, Pull request, Link |

Log event kinds (`rg -n "kind: \"" src/utils/work/store` on 2026-11-19 00:50): `created`, `moved` (a state change: its
payload names `from` and `to`), `edited`, `linked`, `unlinked`, `commented`, `pointed`, `logged` (an attempt:
fixed, partly, failed, a limit), `delivered`. Words: "created it"; a move by its target state ("accepted it" for
spotted to open, "claimed it" for open to active, "released it" for active to open, "finished it", "dropped it",
"reopened it"); "edited <field names>"; "linked <kind words> <ref>"; "unlinked ..."; "commented: <text>";
"added <pointer kind words> <target>"; "logged an attempt: <outcome>"; "delivered to <session>". Check the payload
names in the store code before you write the decoder, and write any kind you add into Progress.

### Empty, loading and failure states (P2, P3)

- The project is loading: the list area shows the existing loading state; the find bar is visible and disabled.
- The index for done and dropped rows is loading: the "Done and dropped" section shows one line with a small
  progress view and "Reading done and dropped items", never an empty section.
- No row matches anywhere: `EmptyState(symbol: "magnifyingglass", text: "No item matches", detail: "<the query>")`
  with a "Clear filters" button under it.
- The detail failed to load: `FailureInline(.unexpected(error, outcome: "Could not read <ref>", action: "Read the
  item"), form: .pane)` in the inspector, with retry. The list stays usable.
- A selected item disappears from the project (moved, or its project changed): the inspector keeps the last detail
  with a line "This item is no longer in <project>" and a button "Open it" that routes to its new project.
- A write from the inspector failed: the outcome `NoticePill` stays (error), and the reason or proof text the reader
  typed is kept in the popover so nothing typed is lost.

- 2026-11-19 00:57 Event.action carries the verb derived from the event payload; Event.summary keeps the note, reason or proof. The archive index also supplies matching open rows that have neither a container nor a triage entry.

- 2026-11-19 03:08 Item.checkoutPath reads the creating actor's repoRoot only when that actor named the item's project. The host resolves its main checkout off the main thread so relative file links also work on a cold Work route.

- 2026-11-19 03:24 Executor clarification: wait while pgrep -x swift-build, pgrep -x swift-test or pgrep -x swift-frontend finds an actual process. Keep the 20-second poll and the repository build lock. This supersedes the original full-command-line guard for every remaining Swift call.

## Order

- Wave 1: P1 starts now.
- Wave 2: P2 needs P1 (built). P3 needs P1 (built). P2 and P3 do not share an owner file; one child does P2, then P3.
- Wave 3: P4 needs P2 (built) and P3 (built).
- Wave 4: P5 needs P4 (built).
- Owner regions shared with the sibling spec (its executor runs at the same time):
  - `HubWork.swift`: this spec owns `WorkMain.content` and everything below the header; the sibling owns
    `WorkMain.header` (the title bar row) and the model's reload state. Do not edit the header row.
  - `WorkScreenModel.swift`: this spec adds `filter`, `index`, `selection` and their functions in a new
    `// MARK: - Find and select` block; the sibling edits the load and reload functions and adds a live state.
    Do not change `reload()`, `isLoading` or the change-stream task; call them.
  - `WorkScreenViews.swift`: this spec owns `WorkItemsView`; the sibling owns `WorkNotifyGridView`.
  - `WorkSource.swift`: this spec adds `list(project:)` under `// MARK: - Find`; the sibling adds `setNotify` under
    its own mark.
  The orchestrator merges both branches; a conflict outside these rules is a deviation to write down.

## Packages

### P1: full item detail data and the filter model

**Owner files:** `src/macos/GenesisKit/Sources/GenesisKit/Work/WorkItemDetail.swift`,
`src/macos/GenesisKit/Sources/GenesisKit/Work/WorkFilter.swift` (new),
`src/macos/GenesisKit/Sources/GenesisKit/Work/WorkSource.swift` (the `// MARK: - Find` block and `detail`),
`src/macos/GenesisKit/Sources/GenesisKit/Work/WorkScreenModel.swift` (the `// MARK: - Find and select` block),
`src/macos/GenesisKit/Tests/GenesisKitTests/WorkFindTests.swift` (new)
**Needs:** nothing
**Handoff:** closes p1 of `h_kxboe8h2`
**Decisions:**
1. The detail reads `work.show` once per selection and keeps the last 20 details in memory, refreshed when the store
   changes and the item is on screen. Ruled out: one `work.show` per visible row, because a project has 50 to 100
   open items and the reader looks at one.
2. Text search runs in Swift over rows the screen has. The open rows come from the snapshot it already reads; done
   and dropped rows come from ONE `work.list` call for the project (`fields: ref,state,type,severity,worker,title,
   project,slot`, `limit: 5000`), made only while the filter needs them. Ruled out: a `query` parameter on
   `work.list`, because it needs a TS change, a regenerated client and a store index for a list that fits in memory
   (5,000 short rows).
3. The matcher folds case and diacritics (`folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)`)
   and splits on whitespace and punctuation. It is a pure function with unit tests; no view calls `localizedCase...`.
4. `fields` values decode as text: a string stays, a number or a bool is printed, an object or array is compact
   JSON. The inspector shows them under their own labels (P3).
5. The log's `actor` becomes one readable string at decode time: `by.sessionTitle`, else "you" for the person, else
   the harness name. The raw actor is not kept.
**Done when:** `bun scripts/native/swift-package.ts test --package-path src/macos/GenesisKit --filter WorkFindTests`
passes, with these cases: the `w_5d4ch4ts` reply shape (a fixture copied from `tools work show <id> --json` with
invented titles) decodes every field, ref, pointer and event; a reply without `refs`/`pointers`/`log` decodes;
`WorkFilter` matches "inbox imag" to "The widget inbox overview shows ... images" and not to "Inbox count"; a full
ref ranks first; the default filter shows exactly the rows today's pane shows (spotted, reopened, open members);
`.done` alone shows only done rows.
**Targets:**
- ideally the filter over 5,000 rows takes under 10 ms on this Mac; way: an `XCTest` `measure` block over generated
  rows; source: tool; if not: write the number into Progress and go on.
**Effort:** about two hours. Stop at the first matcher that passes the cases.
**Not in this package:** any view.

### P2: the find bar and the filtered Items pane

**Owner files:** `src/macos/GenesisKit/Sources/GenesisKit/Work/WorkFindBar.swift` (new),
`src/macos/GenesisKit/Sources/GenesisKit/Work/WorkScreenViews.swift` (`WorkItemsView` only),
`src/macos/GenesisKit/Tests/GenesisKitTests/WorkFindTests.swift` (new, made in P1)
**Needs:** P1 (built)
**Handoff:** closes p2 of `h_kxboe8h2`
**Decisions:**
1. The find bar is one row at the top of the Items pane, under the title bar hairline, outside the scroll view so
   it never scrolls away (like `PanelFindBar` sits above its scroll view). Left: a search field with a magnifier,
   the placeholder "Find items by words or ref", a clear button while it has text, Esc clears it, ⌘F focuses it
   (register it with the hub's find router: `.panelFindNative(...)` or the router's own API, never a second ⌘F
   owner). Right: the filter controls.
2. Filters are compact pull-down buttons (`MenuButton`), one per facet: "Type", "State", "Severity", and a toggle
   "Mine". A facet with a choice shows it in its label ("State: Open, Spotted", "Type: bug +2"). Each menu has
   "Any" at the top. Ruled out: a row of chips for every type (13 types do not fit beside the field), and native
   SwiftUI `Menu` (the components table forbids it in headers).
3. While the filter is active the bar shows "12 of 96 items" and a "Clear filters" button; the default filter
   shows nothing extra.
4. The sections keep their order and titles. A section with no match shows one line "No match in <section>"
   in faint text and stays one line tall. A container with matching members opens automatically and shows only
   those members, with "3 of 12 tasks match" in place of "x of y open". When the reader closes such a container,
   it stays closed until the filter changes.
5. Done and dropped rows (when the State facet includes them, or text is typed) appear in a fourth section
   "Done and dropped" under the others, sorted newest first by the list's order, at most 200 rows with
   "Show 200 more" after them. A row there has the reopen action only.
6. A typed full ref that matches nothing open opens the item anyway (the inspector shows it), so a pasted ref always
   works.
7. Matching words are not highlighted in this package. (A highlight is a later choice; write it under "Seen, not
   fixed" if the pass shows it is needed.)
8. The filter is per project and per window life; it is not saved. Ruled out: saving it, because a filter that
   survives a restart hides items the reader forgot about.
**Done when:** `WorkFindTests` render `WorkItemsView` with a fixture of 3 containers, 10 spotted rows of 3 types and
2 reopened rows, then: typing "basket" leaves one container open with "1 of 4 tasks match" and the other sections
reading "No match in ..."; the State facet set to Done shows the "Done and dropped" section only; "Clear filters"
restores the first rendering's text exactly. The picture pair `work-find-before.png` / `work-find-after.png`
(test-drawn, fixture data, same size) is written when `WIDGET_SHOTS` is set.
**Targets:**
- ideally typing a letter re-renders the pane in under 16 ms with 100 open rows; way: `HubMainBusy.measure` or an
  XCTest `measure` around one filter change and render; source: tool; if not: write the number into Progress and go
  on (debounce the text by 80 ms only if the number is over 50 ms).
**Effort:** about three hours.
**Not in this package:** the inspector, keyboard row selection.

### P3: the item inspector beside the list

**Owner files:** `src/macos/GenesisKit/Sources/GenesisKit/Work/WorkItemInspector.swift` (new),
`src/macos/GenesisTools/Sources/Parts/Hub/Work/HubWork.swift` (`WorkMain.content` and below),
`src/macos/GenesisTools/Tests/HubWorkTests.swift`
**Needs:** P1 (built)
**Handoff:** closes p3 of `h_kxboe8h2`
**Decisions:**
1. The inspector is a trailing `ResizableSidePanel` (key `work.inspector`, default width 420, min 320, max 640) next
   to the list. It shows the selected item; with no selection it shows `EmptyState(symbol: "sidebar.trailing",
   text: "Select an item", detail: "Its fields, tasks, references and history show here.")`. Ruled out: a sheet or
   a popover, because the reader compares items while the list stays visible.
2. Sections, top to bottom (each only when it has content):
   - Head: state glyph (`WorkStateLook`), the title (selectable, wraps to 3 lines), then one line: type in words
     ("Bug", "Handoff"), state in words ("Spotted", "Open", "Active", "Done", "Dropped", "Reopened"), severity as the
     same `Badge` the rows use, the ref as a `CopyChip`, the project.
   - Actions: the same actions the row offers (accept, finish, drop, reopen, add to a handoff), as labelled buttons
     with their glyph, not glyphs alone; a reason or proof opens the existing `WorkReasonButton` popover. Plus
     "Claim" and "Release" when the state allows them (`rpc.work.claim`, `rpc.work.release`).
   - "Where": a `PathLabel` when the value is `path` or `path:line` and the file exists under the project's main
     checkout; plain selectable text otherwise.
   - "Why", "What a user sees", "Acceptance", other fields: label plus selectable text; the body as markdown through
     the host's markdown renderer (the same one the transcript uses), clamped to 20 lines with "Show all".
   - "Tasks" (a container): each member as a row with its state glyph and title; a click selects it (the inspector
     moves to the member; a back chevron in the inspector head returns to the container).
   - "References": grouped by kind in words ("Spotted in", "Member of", "Blocks", "Blocked by"); each one shows the
     other item's title when the screen knows it (snapshot or index) and its ref; a click selects it.
   - "Commits and files": a commit pointer as the hub's commit link (`tools hub link` form is not available here:
     use the hub's own commit route that `HubPlace` already has for `commit=`), a file pointer as `PathLabel`, a PR or
     URL pointer as `ExternalLink`.
   - "History": the log newest first, one line each: `LiveAgo` brief time, the actor, the event in words ("spotted
     it", "accepted it", "claimed it", "finished it: <proof>", "dropped it: <reason>", "commented: <text>"), with
     unknown kinds shown as the kind word. At most 30 lines, then "Show all".
   - "Comment": a two-line text field with a "Comment" button (`rpc.work.comment`); Return adds a newline,
     ⌘Return sends. After sending, the history shows the comment and the field clears.
3. A write from the inspector shows its outcome as the screen's existing `NoticePill` and keeps the selection;
   after the store changes, the inspector refreshes the same ref (a dropped item stays readable).
4. The list marks the selected row with the row selection fill (`RowButtonStyle` selected look) and
   `.accessibilityAddTraits(.isSelected)`.
5. When the setting says "replace", or the window is narrower than 900 pt, the inspector content shows in place of
   the list with today's "All items" back button. Both forms use the same `WorkItemInspector` view.
**Done when:** `bun run app:test -- --filter HubWorkTests` passes with a new case: a route `work=w_x` on a fixture
source selects `w_x`, the inspector shows its "Where", "References", "History" texts, and a tap on a member selects
the member. A hub snapshot from the worktree build (`.claude/rules/macos-app-verify.md`: build in the worktree, then
`.build/debug/GenesisTools --hub --mode work --width 1300 --height 820 --snapshot <scratch>/work-inspector-after.png`
with `GENESIS_TOOLS_BIN=<worktree>/tools GENESIS_HUB_SERVER=0`) shows the list and the inspector side by side; the
title bar audit line ends in `ok`.
**Targets:**
- ideally a selection change shows the cached detail in the same frame and a new detail in under 300 ms; way: a
  `HubPerf` span `work.detail.load`; source: tool; if not: write the number into Progress.
**Effort:** about four hours.
**Not in this package:** keyboard selection, the setting (P4).

### P4: keyboard selection, the route and the detail placement setting

**Owner files:** `src/macos/GenesisKit/Sources/GenesisKit/Settings/HubPreferences.swift`,
`src/macos/GenesisKit/Sources/GenesisKit/Work/WorkScreenModel.swift` (`moveSelection`, `visibleRefs`),
`src/macos/GenesisTools/Sources/Parts/Hub/Work/HubWork.swift` (key handling in the content), the hub settings page
file that holds the hub's other General rows (find it with `rg -n 'NativeSettings' src/macos/GenesisTools/Sources/Parts/Hub`)
**Needs:** P2 (built), P3 (built)
**Handoff:** closes p4 of `h_kxboe8h2`
**Decisions:**
1. ↑ and ↓ move the selection through `visibleRefs` (members of open containers included); Return on a container
   opens or closes it; Esc in the list clears the selection; ⌘F focuses the find field. Keys work only while the
   list or the inspector has focus, never while a text field has it. Ruled out: a local key monitor (the panel find
   router owns ⌘F; a second owner breaks it).
2. The selected row scrolls into view with `ScrollViewReader` (`anchor: nil`, so it moves only when off screen),
   with no animation under Reduce Motion (`@GenReduceMotion`).
3. The route writes `work=<ref>` on selection, so the hub's back and forward history steps through items. A route
   to a ref outside the filter clears the filter's text and states so the row is visible, and says so in the find bar
   ("Filter cleared to show w_x").
4. The setting `workDetailPlacement` follows the rule in `.claude/rules/opinionated-settings.md` (default "beside").
**Done when:** `WorkFindTests` cover `moveSelection` over a filtered list (skips hidden rows, stops at the ends) and
the route clearing a filter; `HubWorkTests` covers the "replace" placement showing the back button; the hub settings
page shows the "Item details" row (a test or a `--features` snapshot of the page).
**Effort:** about two hours.
**Not in this package:** a saved filter.

### P5: picture pairs, the ux checklist pass and the gate

**Owner files:** none new; fixes go into the files of P1 to P4.
**Needs:** P4 (built)
**Handoff:** closes p5 of `h_kxboe8h2`
**Decisions:**
1. Walk `.claude/skills/ux/references/checklist.md` over every view this spec added or changed, and run
   `bun .claude/skills/ux/scripts/ux-scan.ts <changed swift files>`. Fix what fails, in this package. A defect in a
   view this spec did not touch is filed with `tools work spot "<title>" --type bug --where <file:line>
   --user-sees "<what a user sees>"`, not fixed.
2. Picture pairs (same size, fixture data): find bar empty and with a query; inspector of a spotted bug, of a
   handoff with tasks, of a done item with history; narrow window (replace form). Write them under the scratch folder
   and list them in Progress. Pictures of real data stay local.
**Done when:** gate commands 1 to 6 under "Rules for the executor" pass on the branch head (first:
`bun scripts/native/swift-package.ts test --package-path src/macos/GenesisKit --filter 'WorkFindTests|WorkScreenTests|HubPreferencesTests'`),
every pair exists, and Progress lists each checklist item that did not apply with one reason.
**Effort:** about two hours.
**Not in this package:** new features found during the pass (they go to "Seen, not fixed").

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
    button, `.genHoverPlain()` / `.rowButton` for every other clickable thing, `MenuButton` for pull-downs,
    `Plural.count`, `LiveAgo` with `.brief` in rows, `PathLabel`, `ExternalLink`, `CopyChip`, `EmptyState`,
    `FailureInline` for a failed load (never `error.localizedDescription` in a `Text`), `GenDisclosure` for anything
    that opens or closes.
  - Rows of a long list take values, are `Equatable` with `.equatable()`, and call `.liveRow(selected:)`.
  - A view body only reads cached state; every RPC call runs in the model, off the view body.
  - Every behaviour a reasonable user could want another way ships as a setting with your pick as its default
    (`.claude/rules/opinionated-settings.md`); name each one in Progress.
  - Text in the UI: sentence case, no em or en dash, no raw state or type token shown as is (map it to words).
- Swift builds in a linked worktree: `bun scripts/native/swift-package.ts test --package-path src/macos/GenesisKit
  --filter <names>` for GenesisKit, `bun run app:test -- --filter <names>` for the app (it builds in the worktree's
  own `.build/opt`; it never installs). Run `bun install` once in the worktree first.
- The gate, on the branch head, in the worktree, one Swift command at a time:
  1. `bun scripts/native/swift-package.ts test --package-path src/macos/GenesisKit --filter 'WorkFindTests|WorkScreenTests|HubPreferencesTests'`
  2. `bun run app:test -- --filter HubWorkTests`
  3. `bun scripts/ci/lint-rules.ts`
  4. `tsc-rs --noEmit -p tsconfig.json` (only when a `.ts` file changed; the known TS5115 zod error is not yours)
  5. `bun scripts/git/check-commits.ts origin/feat/2026-11-19-work-find-live..HEAD`
  6. `bash scripts/ci/placeholder-check.sh`
- Commits: one per package, or one per two small packages, titled like
  `feat(GenesisHub, work): the Items pane finds items by words and filters` (scope `(GenesisHub, work)` for hub and
  Work views, `(GenesisKit)` for a shared component). No agent attribution.
- When every package is done: tick the last task, send `finish_handoff`, and end your run with one line:
  `branch feat/2026-11-19-work-find-a, head <sha>, gate <passed|failed: what>`.

## Decisions

- No decision was asked. Martin's order (2026-11-19 00:40): "spec them ... and just make sure astras do them".

### Decisions the planner made

- The inspector sits beside the list by default; "in place of the list" is a setting (`workDetailPlacement`).
- Search runs in Swift over loaded rows; done and dropped items load through one `work.list` call only when asked.
- The filter is not saved across launches.
- No match highlighting in this round.
- Comments are added from the inspector; editing an item's fields (title, severity, type) is not in this spec
  (`rpc.work.edit` exists; it is a later step and goes under "Seen, not fixed" if the pass asks for it).
- The detail cache keeps 20 items.
- Keys: ↑ ↓ Return Esc ⌘F, list and inspector focus only.

## Progress

- 2026-11-19 00:57 Verified base 49ff462117, installed dependencies, and claimed the five handoff tasks. P1 is in progress.

- 2026-11-19 01:00 The detail decoder handles claimed, released, paired and unpaired journal events in addition to the frozen list. The model shares one 20-entry detail cache and one project index.

- 2026-11-19 01:07 P1 committed at 1b0f05bde5. The compiler stopped during the external interruption before reporting a test result. The resumed gate is waiting for the shared Swift slot.

- 2026-11-19 01:19 The P1-only WorkFindTests passed in this worktree. The 5,000-row matcher averaged 45 ms across ten samples (42.5–56.4 ms) against the 10 ms target; folding and tokenizing each row on each scan costs time. Full gate in progress.

- 2026-11-19 01:39 The combined GenesisKit gate passed 33 tests on 1b0f05bde5 (10.17 s). The app gate started after it.

- 2026-11-19 01:50 P1 gate passed: 33 kit and 11 app tests, lint, subject check and tracked-file placeholder scan. No TS changed. Current-account MCP handoff check was refused because the resumed connector has no sessionId; local action recovery in progress.

- 2026-11-19 01:51 The resumed shell retains its original CODEX_THREAD_ID. The same handoff action executor accepted the P1 proof from that identity; handoff_get confirms 1/5.

- 2026-11-19 02:06 P2 find bar, projected list and offscreen tests committed at 043548e385. Tests enter basket through the actual native field editor. Awaiting the shared Swift slot for the kit gate; the app gate follows it. Scratch evidence: /tmp/cc/GenesisTools/ae3ac312-7dbe-4045-970a-292aa93ed9ab/work-find-a/p2-kit.log and /tmp/cc/GenesisTools/ae3ac312-7dbe-4045-970a-292aa93ed9ab/work-find-a/p2-app.log.

- 2026-11-19 02:15 P2's rendered basket, Done and clear tests passed. The 100-row projection/layout/bitmap averaged 264 ms with substantial load variance, above the 50 ms threshold. The field now echoes immediately and applies the filter after 80 ms. Restored the existing lowercase noun in section counts after WorkScreenTests caught the regression.

- 2026-11-19 02:17 Captured the local pre-inspector baseline from the verified P1 app at 1300 × 820 pt, on work=w_5d4ch4ts. Read the image: the old detail replaces the list. Title-bar audit ended in ok. Local-only pair begins at /tmp/cc/GenesisTools/ae3ac312-7dbe-4045-970a-292aa93ed9ab/work-find-a/work-inspector-before.png.

- 2026-11-19 03:01 P2 kit gate passed 35/35 at 43bd8504fb, including native typing, reset text parity, archived-only results, legacy rendering, and the 80 ms change. App gate is building in the isolated worktree.

- 2026-11-19 03:04 Remaining inspector and keyboard/placement drafts are in /tmp/cc/GenesisTools/ae3ac312-7dbe-4045-970a-292aa93ed9ab/work-find-a/design as WorkItemInspector.swift, WorkReasonButton.swift, HubWorkTests.swift and settings/*.swift. integrate-p3.py then integrate-p4.py apply the staged design to the worktree; they have only been exercised against scratch copies. Validate each package separately before ticking it.

- 2026-11-19 03:08 P2 gate passed on 43bd8504fb: 35 kit tests, 11 app tests, lint, subjects, and placeholder checks. Verified both 2000 × 3000 fixture images at /tmp/cc/GenesisTools/ae3ac312-7dbe-4045-970a-292aa93ed9ab/work-find-a/work-find-before.png and /tmp/cc/GenesisTools/ae3ac312-7dbe-4045-970a-292aa93ed9ab/work-find-a/work-find-after.png. Final 100-row sample 69 ms (bitmap rendering included).

- 2026-11-19 03:12 P3 inspector and its production host, source actions and fixture tests are in commit 213b8f34a8. The host owns routing and drafts, including when the window crosses the placement threshold. App build pending.

- 2026-11-19 03:24 P3 gate waiting on the prescribed pgrep: two successive samples found only waiting zsh processes, PIDs 14567 and 25132, in the separate inbox-feed2 worktree. Their inline command includes the pgrep pattern itself. Asked whether to exclude verified waiting shells; left the original gate and the other processes alone.

- 2026-11-19 03:36 Image inspection found the default State menu truncates before its selected-count suffix. CPU OCR read 'State: Open or activ...' in work-find-before.png. The P5 checklist pass will use the short Open label for a multi-choice summary and keep Open or active in the menu.

- 2026-11-19 03:43 The first native inspector pair showed the list and selected detail side by side and titlebar audit ok. P3 first app run exposed a narrow title truncation and a hidden test window that queued mouse events without dispatching them. Updated the row layout and event pump; rerunning.

- 2026-11-19 03:51 After fixing the moved-project refresh and native event pump, 36 kit and 14 app tests passed, including task click/back and all four matched inspector pairs. Toolchain lint required a conventional EnvironmentKey for compact rows on Command Line Tools machines; removed the @Entry macro and am verifying the amended head.

- 2026-11-19 03:51 The shared perf log reported work.detail.load spans of 8.9, 394.0 and 18.5 ms alongside this worktree's live captures. One exceeded 300 ms. They include service wait, and the Mac was shared. The cache test separately proves same-frame availability on a repeated selection.

- 2026-11-19 04:15 P3 passed on 1f20b07cce: 36/36 kit and 14/14 app tests, all static gate checks, live title-bar audit ok. Hidden-window member click and back both passed.

- 2026-11-19 04:16 P4 adds Item details (hub.work.detailPlacement). Beside the list is the default; replace opens details in place. Below 900 pt selection uses the replacement layout. Filters stay per window and reset on project changes.

- 2026-11-19 04:45 P4 gate passed at 8348648870: 43 kit and 16 app tests. Hub Back/Forward, wide replace, route clearing and all three rendered settings layouts passed, along with lint, subjects and the placeholder scan.

- 2026-11-19 04:53 Checklist references below use each section's bullet order in .claude/skills/ux/references/checklist.md. Affordance 4/5 (media thumbnails, agent attachments), 7 (custom button style), 8 (drop target), and 11 (context-only commands) do not apply: these views use text and existing kit controls. For 2 the named container row selects its details; its separately labelled chevron folds the tasks. For 14/15 we used the worktree host, real field-editor input and real member/back clicks. The installed app was outside the brief. Menu pointer selections and each individual RPC write were not exercised in the installed app.

- 2026-11-19 04:53 Windows and overlays 1/2/4/5/7/8/9/11 are existing window dragging, responder, tab, floating-window, screen placement, modal and Dock policies. Work adds an interior pane. Item 3 has no unsolicited overlay. Layout 2/5/9/10/12/13 do not apply to autosizing panels, nonactivating tabs, module icons, timeline marks, held answer rows or inline time links. Work uses the existing window and a trailing divider. Wide/narrow renders cover the reachable 900 pt breakpoint.

- 2026-11-19 04:53 Widget and panel controls 4 is for a session terminal; each row here is a work item. Round 2 items 3/4/5/6/7/8/9 concern fitted widget height, agent headers, session activity, sounds, preview bubbles, parallel session lists and flashes; none was introduced here. Counts describe the sections immediately below them. Hit targets and keyboard were inspected on the actual fields, disclosures, row selectors and labelled actions. Keyboard 13/14 remain the host's standard app and mode commands.

- 2026-11-19 04:53 VoiceOver 1–14 were reviewed at the code level for meaningful labels, control IDs, selection traits, glyphs and reading order. Manual VoiceOver, Full Keyboard Access and changed accessibility settings were outside the explicitly confirmed scope. VoiceOver 4/5/10/11 have no new hover-only action, unsolicited alert, exiting overlay or glass material. Feedback 5 uses the existing screen notice by the interface freeze; 9/12 have no agent-blocking approval or batch write. Errors and recovery 8 has no permission request. Undo and destructive actions 1/3/6 have no new undo stack, permanent deletion or repeated confirmation. Drop/finish change work state; Reopen remains available. Empty and loading states 4 has no onboarding flow.

- 2026-11-19 04:53 Motion 2/8/9/10/11 introduce no AppKit animator, chained animation, entry scale, decorative loop or flash. Motion 4 was checked in source; OS settings were not toggled. Attention and notifications 1–7 belong to approvals, notification focus, popups, system notices, alert actions, notice timers and sounds; this package uses the existing notice and leaves notification delivery to the sibling. Counts/words 3/8/10 have no numbered option badges, repeated time chips or nearest-media timestamps. Settings 4/7/8/9 have no dependent option, editable preference text, numeric unit or stepping control. Settings 1–3 were checked through isolated preferences, reopened domains and all three rendered layouts.

- 2026-11-19 04:53 Loading, swaps and diffs 3/4/6/7/8/10/11/12/13/14 cover saved window frames, highlighted diffs, tab animation, changed file reveal, follow-latest scrolling, renames, file recency, file-tree outline keys, tab-following and hosted repositories. No such behavior was added. The selected item is replaced immediately only on an explicit selection; the last successful detail stays visible during a refresh. Dragged edges 1–5 use the existing ResizableSidePanel, value rows and liveRow controls; 6/7 are resize-engine benchmark and dev-monitor checks. The engine was reused and the wide/narrow end states were rendered. Drag-frame latency and release costs were not measured.

- 2026-11-19 05:16 Opus took over. Feature A's five commits were cherry-picked onto feat/2026-11-19-work-find-live a97ebb7ddb (feature B; backup branch backup/2026-11-19-work-find-a-pre-restack at 7ef2c67c0c). Conflicts in WorkScreenModel (snapshot didSet beside B's preview state, write() with B's NoticeStack and readAfterWrite, activate/deactivate), WorkScreenTests (B's GenesisKitFixtureTextRequest kept), HubWork (B's WorkHeader beside A's HubWorkContent) and HubWorkTests (B's file plus A's three hunks). The owned diff now uses a97ebb7ddb.

- 2026-11-19 05:45 Two adaptations to feature B after the restack, both in the owned range. 4f9a364598: the list read beside an open item now goes through the same adopt path as a list read (B's pending-state preview and row animation), and an equal live read refreshes a dropped find index without publishing (the first kit run failed WorkFindTests.testTheModelReadsTheIndexOnDemand... and WorkScreenTests.testAnEqualLiveReadPublishesNothing... until this). d75dc384e4: a routed row already in the list when the list first appears scrolls into view after layout; HubWorkTests.testARoutedArchiveRowFarBelowTheFoldIsScrolledIntoView covers both orders.

- 2026-11-19 05:45 Gate on d75dc384e4 in the worktree on this Mac: kit `swift-package.ts test --filter 'Work|HubPreferencesTests'` 105 tests, 3 skipped, 0 failures (final-kit.log); app `app:test -- --filter HubWork` 22 tests, 0 failures (final-app.log); lint-rules OK on 11,047 files and 23 rules; check-commits 7 commits in a97ebb7ddb..HEAD, 0 to fix; placeholder-check 813 patterns, no match. WorkScreenTestsRemoval passed in every kit run, so no flaky rerun was needed. No TypeScript changed. Logs are in /tmp/cc/GenesisTools/ae3ac312-7dbe-4045-970a-292aa93ed9ab/work-find-a.

- 2026-11-19 05:45 Picture pairs on this HEAD's code, same size per pair: work-find-{before,after}.png 2000 x 3000 (kit WorkFindTests with WIDGET_SHOTS); hub-work-inspector-{bug,handoff,done}-{before,selected}.png 3000 x 2000 and hub-work-inspector-narrow-{before,selected}.png 1640 x 2000 (app HubWorkTests with HUB_WORK_SHOTS). The handoff pair shows B's WorkHeader (no reload button, no spinner) above A's list and inspector. Find OCR in the test asserts 'Find items by words or ref' and 'State: Open +2'.

- 2026-11-19 05:45 Live capture from the worktree build, work=w_5d4ch4ts at 1300 x 820 pt: work-inspector-after.png beside work-inspector-before.png, title-bar audit ended in ok. The details sit beside the list with State: Done, but the done row itself is not in the list: the app's project index counts 361 GenesisTools items while `tools work list` returns 970, and w_5d4ch4ts is not among the 361. Filed as w_no6yvic6. The real picture stays local.

- 2026-11-19 05:45 UX pass closed on the owned range: `git diff --name-only --diff-filter=ACM a97ebb7ddb..HEAD -- '*.swift' | xargs bun .claude/skills/ux/scripts/ux-scan.ts` scanned 14 Swift files (WorkScreenTests left the owned diff, since B's OCR helper replaced A's one-line change there). Facts: no file animates without reading Reduce Motion, no file has two reload buttons, 5 arrow-key handlers. The item-by-item exclusions of 04:53 still apply; the restack added no new control. VoiceOver, Full Keyboard Access and OS settings were not tested (no confirmation in this task).

## Seen, not fixed

- 2026-11-19 01:00 A project with more than 5,000 items can have rows beyond the single allowed list response. The store currently returns its oldest 5,000.

- 2026-11-19 05:45 w_no6yvic6: the Work screen's project index misses closed items that the CLI lists, so a route to one of them shows its details but not its row.

## Deviations

- 2026-11-19 00:57 The local handoff CLI has no get subcommand. Claimed through handoff_get instead.

- 2026-11-19 01:00 The work.list SQL orders by created_ts ascending, so the source reverses the returned rows to show the newest archive item first. The 5,000-row request limit still applies.

- 2026-11-19 01:10 The search bar keeps its focus through resizing. When the list is too narrow for one row, the search stays above the facet controls; all four remain visible.

- 2026-11-19 01:13 WorkScreenModel keeps the existing reload function and change-stream task. Its changed() and successful-write paths invalidate the find cache so the next settled reload refreshes the index and the visible detail.

- 2026-11-19 02:56 The machine's Vision E5RT engine failed before OCR in six existing and new kit tests. The Work screenshot read now retries the same image through the system CPU recognizer; the expected text and capture paths stay the same.

- 2026-11-19 04:52 The live route to an archived item showed 314 of 362 rows and expanded unrelated open handoffs. A routed standalone done or dropped item now selects its own archive state. A canonical full ref with a matching row yields that exact item across sections. A header carries no worker in work.tree; Mine uses actual index ownership or matching members.

## 2026-11-19 04:56 — Handoff from the astra worker

### DONE

P1–P4 are checked on handoff `h_kxboe8h2`. P5 is committed and remains open. These are the exact commands behind the results below, run from the assigned worktree.

| Check | Command |
|---|---|
| Kit | `bun scripts/native/swift-package.ts test --package-path src/macos/GenesisKit --filter 'WorkFindTests|WorkScreenTests|HubPreferencesTests'` |
| App | `bun run app:test -- --filter HubWorkTests` |
| Lint | `bun scripts/ci/lint-rules.ts` |
| Subjects | `bun scripts/git/check-commits.ts origin/feat/2026-11-19-work-find-live..HEAD` |
| Placeholders | `bash scripts/ci/placeholder-check.sh` |

| Package and commit | Implementation and verification on that commit | Kit / App passed | Lint files / rules | Subjects checked / rejected | Placeholder patterns / hits |
|---|---|---:|---:|---:|---:|
| P1 `1b0f05bde5` | Full detail decoding, filter, lazy project index and 20-item cache. The additional command `bun scripts/native/swift-package.ts test --package-path src/macos/GenesisKit --filter WorkFindTests` passed 11/11. | 33 / 11 | 11,036 / 23 | 1 / 0 | 813 / 0 |
| P2 `43bd8504fb` | Find bar, facets, matching members and archive. A native field-editor test entered “basket” and verified the restored rendering after clearing. | 35 / 11 | 11,037 / 23 | 2 / 0 | 813 / 0 |
| P3 `1f20b07cce` | Inspector, writes, history, links and draft retention. Real mouse events selected a member and returned to its container. The worktree's live 1300 × 820 capture recorded a title-bar audit ending in `ok`. | 36 / 14 | 11,038 / 23 | 3 / 0 | 813 / 0 |
| P4 `8348648870` | Filtered keyboard selection, Back/Forward, route reveal and placement. `hub.work.detailPlacement` defaults to `beside`, supports `replace`, and uses replacement below 900 pt. Both choices rendered in all three settings layouts. | 43 / 16 | 11,038 / 23 | 4 / 0 | 813 / 0 |
| P5 `7ef2c67c0c` | Shorter facet summary, cross-section exact-ref results, archive routing, ownership checks and revision-safe draft writes. The already-running App test finished at 04:55 with 16/16 passing. | 46 / 16 | unrun | unrun | unrun |

### STATE

**HEAD `7ef2c67c0cb5684a9b1bba8180863bf1a0453294`** on `feat/2026-11-19-work-find-a`. `git status --short` produced no output. All edits were already committed. The P5 gate wrapper was stopped before its remaining commands. No new build or test was started for this handoff. No TypeScript changed, so the conditional TypeScript check does not apply.

All paths below are under [the evidence directory](/tmp/cc/GenesisTools/ae3ac312-7dbe-4045-970a-292aa93ed9ab/work-find-a/). Brace groups name individual files in that directory.

| Evidence | Files |
|---|---|
| Passing package logs | `p1-{resumed,all-kit,app,lint,personal}.log`, `p2-retry-{kit,app,lint,commits,personal}.log`, `p3-{kit,app,lint,commits,personal}.log`, `p4-verify-{kit,app,lint,commits,personal}.log`. The P1 subject check printed its result in the session. |
| HEAD test and UX logs | [p5-kit.log](/tmp/cc/GenesisTools/ae3ac312-7dbe-4045-970a-292aa93ed9ab/work-find-a/p5-kit.log), [p5-app.log](/tmp/cc/GenesisTools/ae3ac312-7dbe-4045-970a-292aa93ed9ab/work-find-a/p5-app.log), `p5-ux-scan-before.log`, `p5-ux-scan.log`, `p5-ux-changed.log` |
| HEAD fixture pairs | `work-find-{before,after}.png` and `hub-work-inspector-{bug,handoff,done,narrow}-{before,selected}.png`. Inspector “before” means the same fixture with no selection. All four inspector pairs were written by the final App test. |
| Other fixture pictures | `hub-work.png`, `hub-work-linked.png`, `hub-work-cold-bug.png`, `hub-work-member-container.png`, `hub-work-member-task.png`, `hub-work-wide-replace.png`. The member-task picture is from an earlier run. |
| Earlier live captures, local-only | `work-inspector-{before,after}.png` and corresponding `.geometry.json` files, `baseline-snapshot.log`, `p3-first-snapshot.log`, `p3-snapshot.log`, `p4-live.png`, `p4-live.geometry.json`, `p4-snapshot.log`. The live “after” predates P5. |
| Troubleshooting | `p1-kit.log` (interrupted), `p2-kit.log` (count wording and initial timings), `p2-lock-timeout.log`, `p2-vision-failure.log`, `p3-first-app.log` (click and truncation), `p3-final-kit.log` (moved item), `p3-verify-lint.log` (macro), `p4-kit.log` (OCR). `swift-check` contains the corrected wait. `design/` contains historical drafts already integrated into the branch. |

### TODO

1. **Finish P5's HEAD gate.** Run Lint, Subjects and Placeholders exactly as listed above. Record their outputs in `p5-{lint,commits,personal}.log`. If source changes, repeat the applicable gate on the new HEAD. Both Swift suites already passed on the current HEAD.
2. **Finish P5 picture verification.** Open the five HEAD fixture pairs listed above and record their paths and dimensions in Progress. Refresh the live “after” using the worktree executable against the same item as the baseline. From the worktree run `GENESIS_TOOLS_BIN="$PWD/tools" GENESIS_HUB_SERVER=0 src/macos/GenesisTools/.build/opt/debug/GenesisTools --hub --mode work --work w_5d4ch4ts --width 1300 --height 820 --snapshot "$D/work-inspector-after.png"`, with `D` set to the evidence directory. Confirm the archive row is visible beside its detail and the title-bar audit ends in `ok`. Keep real-data pictures local.
3. **Close the UX pass in this main-checkout spec.** The exact scan was `git diff --name-only --diff-filter=ACM 49ff462117..HEAD -- '*.swift' | xargs bun .claude/skills/ux/scripts/ux-scan.ts`. It scanned 15 Swift files. The changed-line report flags glyph sizes, text derived from data, loading and empty states, destructive actions, error strings and one clipped selectable title for manual judgment. The item-by-item exclusions are already in Progress. HEAD find-picture OCR read both “Find items by words or ref” and “State: Open +2”.
4. **Finish the handoff.** Append final evidence to Progress, check `p5` with its commit and proof, then send `finish_handoff`. Handoff state at transfer is 4/5. Leave publication to the orchestrator.

**Known limits.** In `WorkSource.swift`, the single list read returns the oldest 5,000 rows before the UI reverses them. Larger projects can omit newer items. In `WorkFilter.swift`, Mine can establish container ownership only from available index data or matching members. HEAD measured 44 ms for 5,000 matches and 64 ms for the 100-row render against the 10/16 ms targets. Typing uses the specified 80 ms debounce. One live detail read took 394 ms against a 300 ms target. These targets are non-gating. The executor brief asks for one combined follow-up question about them. Manual VoiceOver, Full Keyboard Access, OS setting changes, installed-app testing and drag-frame measurements were outside this run.

### TRAPS

- Use the owner-approved 20-second loop with `pgrep -x swift-build || pgrep -x swift-test || pgrep -x swift-frontend`, then the repository wrapper. Full-command-line matching caught another waiting shell. A 240-second repository lock timeout also occurred. Retry without removing the shared lock.
- Vision sometimes failed to initialize E5RT before OCR. The Work fixture tests retry the same pixels on CPU. OCR also read “I” as “l” and inserted a space after a path's colon. The fixtures now avoid the ambiguous setting label and normalize that one path-spacing artifact.
- Hidden-window clicks require dispatching queued mouse events. Keep frame probes and bitmap reads in the same window. A render alone previously let a missed member click go undetected.
- Use `49ff462117` for the owned diff. The integration branch moved during the run. The lint rule requires a conventional `EnvironmentKey` for Command Line Tools compatibility.
- The resumed MCP connector had no session ID. The original shell's genuine `CODEX_THREAD_ID` allowed `tick.ts` to record proofs through the normal handoff executor. Opus should claim using its own identity.
