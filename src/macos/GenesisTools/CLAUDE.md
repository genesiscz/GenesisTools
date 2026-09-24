# GenesisTools.app (Swift) — rules for every window

Loaded automatically when you work under `src/macos/GenesisTools/`. The root CLAUDE.md rule still
applies: after ANY edit to `Sources/**`, `web/**` or `Info.plist`, run `bun run app` (build, sign,
install, reap stale faces). Swift UI you have not seen rendered is not done.

## Use the shared components (Sources/Hub/HubComponents.swift), never hand-roll these

| Need | Use | Never |
|---|---|---|
| An icon-only button | `IconButton(systemName:tooltip:action:)` | a bare `Button { Image(...) }` without a tooltip |
| Any other control that is not self-explanatory | `.instantTooltip("…")` (Hub/Stolen/UI/InstantTooltip.swift) | `.help(...)` alone: it shows after a long delay and is easy to miss |
| A link to a web page (repo, branch, PR, commit) | `ExternalLink(text:url:)` (opens in Brave, shows the ↗ glyph) | plain text that happens to be a URL |
| Repo / branch web URLs, the branch's PR/MR | `RepoFactsStore.shared.facts(for: path, pr:)` (fed by `tools hub repo --json`) + `PullRequestLink` | parsing `git remote` in Swift, or any `Process` in a view body |
| A file or folder path | `PathLabel(path:)` (menu: Finder, Cursor, cmux, copy; plus copy / reveal / Cursor icons) | a bare `Text(path)` |
| Open a file at a line | `PathOpener.cursor(path, line:)` | `open -a` without the line |
| A side panel | `ResizableSidePanel(key:edge:)` (drag to resize, drag to the edge to collapse, persisted) | a fixed `.frame(width:)` sidebar |
| A sidebar group header | `GroupHeader` + `GroupPrefs` (collapse, pin, move up/down, persisted) | an uppercase static label |
| A status message | `NoticePill` (fades, error stays) | a raw colored `Text` line |

**Every button has a hover effect.** Icon buttons: `IconButton` (uses `.genHoverIcon()`); text-like buttons and
links: `.buttonStyle(.genHoverPlain())`; list rows and menu rows: `.buttonStyle(.genHoverRow())` (all from
Hub/Stolen/UI/GenHoverButton.swift). Never `.buttonStyle(.borderless)` on something clickable.

**Every button that shows only an icon has a tooltip.** Check before you finish: `rg -n 'Image\(systemName' Sources | rg -v 'IconButton|instantTooltip'` and look at each hit.

## 🛑 Never block the main thread inside a view body

`Process.waitUntilExit()` spins the main run loop. Inside a SwiftUI `body` that lets AppKit lay out
the view that is still being computed: AttributeGraph prints `cycle detected` and SwiftUI's
StackLayout array is freed twice (EXC_BAD_ACCESS in `StackLayout.Child`, hub crash 2026-09-24).
A body only reads cached state; anything that spawns, reads git, or hits the disk more than a
stat goes through a store that loads on a background queue (see `RepoFactsStore`). Data that the
`tools` CLI can compute comes from `tools`, not from Swift reimplementations.
To find a cycle: `AG_TRAP_CYCLES=1 GenesisTools --hub … --snapshot /tmp/x.png`, then read the
newest `~/Library/Logs/DiagnosticReports/GenesisTools-*.ips` stack.

## Measure every load

Every load that can be slow runs in a span: `HubPerf.begin("area.what", detail)` then
`span.end()`, or `HubPerf.measure(...)`. Spans, stalls and hang samples go to
`~/.genesis-tools/logs/app-perf.log` (stolen `PerfLog`; `.main` suffix = ran on the main
thread; `SLOW` marks at 100 ms). `HangWatch` samples the main thread into
`~/.genesis-tools/logs/hangs/` after 1 s. Summary: `bun scripts/perf-report.ts --tail 5000`.
Watch it while you click: `tail -f ~/.genesis-tools/logs/app-perf.log | rg 'SLOW|stall|main '`.

## Look

- Palette: `ReviewPalette` (Review/ReviewWindow.swift) for hub and review; `SessionPalette` inside the stolen session screen. Dark only, near-black background, white-alpha hairlines, green/red/orange/blue status colours.
- Group and project names keep their own case. No uppercase section titles except tiny kickers ("AGENT ANALYSIS").
- Dense rows (24–28 pt), monospaced numbers with `Text(verbatim:)` (locale grouping turned "+7711" into "+7 711").

## Stolen code (Hub/Stolen/)

Files copied from GenesisPlayground/Genesis carry a `// Copied from <path> at <time> at commit hash <sha>` header.
Keep them verbatim so `/steal-code --reconcile` can three-way merge upstream changes. Any local change is a
marked adaptation (`// GenesisTools adaptation: …`). Missing Genesis types go in `Hub/StolenShims.swift` or
`Hub/MarkdownShim.swift`, not into the stolen files.

## Verify without a screen

- `GenesisTools --review --repo <path> [--scope branch] [--proposal <file>] --snapshot /tmp/x.png`
- `GenesisTools --hub [--mode worktrees] [--session <id>] [--tab transcript|changes|decisions] --snapshot /tmp/x.png`
- Read the PNG. The web diff is composited from WKWebView's own snapshot, so it needs no Screen Recording grant.
- A `--snapshot` run uses the `.prohibited` activation policy and an alpha-0 window (`orderInForSnapshot`): it never
  shows on screen and never takes the keyboard. Martin's typing once landed in the hub search field because a
  snapshot run became the active app.
- After a rebuild, restart a running hub without stealing focus: `pkill -f 'MacOS/GenesisTools --hub'` then relaunch
  `GenesisTools --hub --no-activate` detached.
