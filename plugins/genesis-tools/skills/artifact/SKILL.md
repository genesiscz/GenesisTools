---
name: artifact
description: Create, serve, and build LOCAL dashboards and HTML artifacts via `tools artifact` — a single .tsx or .html file anywhere (no folder, no node_modules, no tsconfig) becomes a live page with clean URLs, React, Tailwind and a 40+ component kit (Tabs, Router, MdViewer, Mermaid diagrams, DiffView, TreeView, Steps, Heatmap, Timeline, Simulator, ParametricSimulator, DataTable, Claim, …), or a self-contained single-file HTML. Use this WHENEVER the user says "create me an html artifact", "make a dashboard for/from this", "visualize this analysis as a page", "serve this folder", "single-file report", "incident dashboard", "artifact library", "turn these notes/json/md into a dashboard", or wants an interactive local page over some data — even when they don't say "artifact". Also use it PROACTIVELY when an analysis produces data (json/md/csv) that reads better as an interactive page than as chat text.
---

# tools artifact — dashboards from a single file

One engine, two outputs: `serve` (live Vite dev server, HMR, clean URLs) and `build`
(self-contained single-file HTML that works from `file://`). Nothing installs next to the
artifact — React, Tailwind v4 and the component kit resolve from GenesisTools.

## The fastest path: one file

```bash
tools artifact init dashboard.tsx      # scaffold — never hand-write the shell
tools artifact serve dashboard.tsx     # serves + opens /dashboard (clean URL); HMR on edit
tools artifact build dashboard.tsx     # → dist/dashboard.html, opens from file://
```

- Clean URLs everywhere: `/dashboard` serves `dashboard.tsx`, `/notes` renders `notes.md`,
  `/report` serves `report.html`, nested paths work, and `/dashboard/item/42` is a client
  route (deep links reload). `/__catalog` lists everything.
- Folders work too (`serve <dir>` = catalog + everything inside); several serves run side by
  side (ports bump from 3076). `ps` / `stop <name|port>` manage them.
- **`tools artifact library up`** = ONE server for every registered folder: `/` is the library
  page (meta + click to open), each folder mounts at `/a/<name>/`.
- `build --watch` keeps the single-file output fresh on every edit. Single-file builds embed
  ONLY data the entry references — never the surrounding folder.

## Imports that just work (no tsconfig)

```tsx
import { Page, Hero, Tabs } from "@artifact/kit";          // the component kit
import { formatBytes } from "@genesiscz/utils/format";      // GenesisTools shared utils
import { something } from "@genesistools/src/<path>";       // any repo file
import { useState } from "react";                           // npm deps from the repo
```

- **`tools artifact kit`** prints the kit's complete generated `.d.ts` — read THAT for props
  and types, never the component source.
- **`tools artifact types [dir]`** writes an optional editor-only tsconfig for a human's
  IntelliSense. The runtime never needs it; skip it in agent sessions.

## The kit, at a glance

All from `@artifact/kit`; every `Tone` is `ok | warn | err | info | neutral`; every string
body renders as markdown. Full API: `tools artifact kit`.

| Group | Components |
|---|---|
| Layout | `Page` `Hero` `Section` `Card`/`CardGrid` `Tabs` (hash-synced) `Router`/`RouterLink`/`useParams`/`useNavigate` (history API; hash fallback on file://) |
| Data | `StatGrid` `DataTable` (filter, `rowTone`, toned/markdown cells) `SeriesTable` `Timeline` `Bullets` `QA` (per-item `open`/`featured`/`meta`) |
| Evidence | `CodeBlock` (copy, `lang="ts"` highlighting, `highlightLines`/`badLines`) `FileMark` `Claim` ([NN%] badge) `Quote` `Callout` `Badge` `Chips` `Note` `Superseded` |
| Markdown | `Md` `MdInline` `MdViewer` (`src="../doc.md"` fetches LIVE — TOC + section filter; replaces build-time inlining). Fenced code is highlighted; a ```` ```mermaid ```` fence renders as a diagram |
| Diagrams | `Mermaid` (`chart` = mermaid source: flowchart, sequence, state, class, ER, gantt, gitGraph, mindmap, timeline; zoom toolbar, copy source, download SVG) `ZoomPane` |
| Diff | `DiffView` (`before`/`after` or a unified `patch`; `mode="split"`; `labels`) |
| Structure | `TreeView` + `treeFromPaths(paths)` (file trees) `Steps` (done/active/pending/failed/skipped) `Compare` (A vs B columns) `KeyValue` `JsonView` `Figure` (captioned image, click = full size) |
| Viz | `Sparkline` (inline trend for a cell or stat) `Meter` (bar with `thresholds`) `Heatmap` (rows × cols, one tone) |
| Interactive | `Simulator` (step player) `ParametricSimulator` (sliders/segments/toggles + pure `generate(params)` + presets) `SegmentedControl` |

Show-me rule: a flow, a sequence, a state machine or an architecture is a `Mermaid` (or a
```` ```mermaid ```` fence in an `.md`), never hand-drawn boxes. mermaid itself is NOT installed:
the browser loads it from jsdelivr on first use, so a diagram needs the network once and a
single-file build shows the fence source offline. A served or built `.md` renders its fences
the same way, so `tools artifact serve notes.md` is the shortest path to a diagram.

Data rule: small → inline in the file; larger → sibling `data.json` + `fetch("./data.json")`
(live served, embedded on build) or a static JSON import (bundled). The `<entry>.data*.json`
convention auto-embeds for single-file builds.

## Templates (pick one, the page looks deliberate)

`tools artifact templates` lists them; `serve/library --template <name>`:
graphite (default instrument dark) · bone (editorial light, print) · forest (handbook green) ·
steel (zero-chroma, color = status only) · tan (black+tan presentation, radius 0) · cobalt
(client-facing light). Each is a `theme.css` token set bridged into Tailwind, so the SAME kit
code retints completely. A custom template dir may override just `theme.css`.

## Design rules (inlined — the kit already encodes most)

- Prefer kit components over hand-rolled markup; they carry the palette and radius system.
- One accent per page; tones carry meaning (ok/warn/err), never decoration. No AI-purple, no
  neon glows, no pure black/white.
- Real data over filler: no invented names, no fake-precise numbers, no "Elevate/Seamless"
  copy. Czech content stays Czech. No em-dashes anywhere in visible text.
- Density with breathing room: stats in `StatGrid`, long lists in filterable `DataTable` or
  `QA`/`Bullets`, evidence in `CodeBlock` with the load-bearing lines highlighted.
- Charts: read the `dataviz` skill before writing any chart code. `DayChart` (bars/lines/
  stacks, log scales, markers) and `DonutChart` cover the common shapes and follow the theme
  tones; `ChartJs` takes a raw Chart.js v4 config when you need something they don't cover;
  `SeriesTable` renders any series as a plain table.

## Verify with curl, not a browser

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3076/dashboard
curl -s http://127.0.0.1:3076/__catalog | rg dashboard
```

A browser/screenshot pass is only for visual sign-off when the user asks to see it.
`tools artifact --readme` prints the full docs; every verb has `--help`.
