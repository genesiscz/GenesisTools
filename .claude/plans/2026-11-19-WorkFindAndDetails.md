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
    `pgrep -f 'swift-build|swift-test|swift-frontend'` prints nothing (loop with a 20 s sleep).
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

## Seen, not fixed

## Deviations
