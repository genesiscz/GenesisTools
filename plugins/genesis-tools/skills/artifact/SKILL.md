---
name: artifact
description: Create, serve, and build LOCAL dashboards and HTML artifacts via `tools artifact` — a single .tsx or .html file anywhere (no folder, no node_modules, no tsconfig) becomes a live page with clean URLs, React, Tailwind and a 30-component kit (Tabs, Router, MdViewer, Timeline, Simulator, ParametricSimulator, DataTable, Claim, …), or a self-contained single-file HTML. Use this WHENEVER the user says "create me an html artifact", "make a dashboard for/from this", "visualize this analysis as a page", "serve this folder", "single-file report", "incident dashboard", "artifact library", "turn these notes/json/md into a dashboard", or wants an interactive local page over some data — even when they don't say "artifact". Also use it PROACTIVELY when an analysis produces data (json/md/csv) that reads better as an interactive page than as chat text.
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
| Evidence | `CodeBlock` (copy, `highlightLines`/`badLines`) `FileMark` `Claim` ([NN%] badge) `Quote` `Callout` `Badge` `Chips` `Note` `Superseded` |
| Markdown | `Md` `MdInline` `MdViewer` (`src="../doc.md"` fetches LIVE — TOC + section filter; replaces build-time inlining) |
| Interactive | `Simulator` (step player) `ParametricSimulator` (sliders/segments/toggles + pure `generate(params)` + presets) `SegmentedControl` |

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
