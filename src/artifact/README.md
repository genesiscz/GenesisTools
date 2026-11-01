# tools artifact

Turn a SINGLE `.tsx`/`.html`/`.md` file — or a whole folder — into a live local dashboard with
clean URLs, and build self-contained single-file HTML artifacts for sharing. The artifact needs
no `node_modules`, no config, no tsconfig — React, Tailwind v4 and the component kit come from
GenesisTools.

```bash
tools artifact init dashboard.tsx && tools artifact serve dashboard.tsx   # live + HMR at /dashboard
tools artifact build dashboard.tsx                                        # dist/dashboard.html (file://)
tools artifact library up                                                 # ONE server for everything registered
tools artifact gallery gantt                                              # the kit gallery, at the Gantt page
```

## Commands

| Command | What it does |
|---|---|
| `serve [target]` | Vite dev server (registered name, folder, or a single file). HMR on edit. Folders auto-register; ports auto-bump from 3076, so several serves run side by side. `--template <name>` swaps the theme. |
| `library up` | ONE server: `/` lists every registered artifact folder (counts, age, click to open); each mounts at `/a/<name>/` via a lazily-started sub-server. At most 8 mounts stay live at once; the least recently used one is closed on overflow, because every mount holds compiled modules and file watchers. Clean URLs work under every mount. |
| `gallery [name]` | Open the built-in kit gallery (every kit component, grouped by family, with a search box), starting the library server first when none runs. A name opens one page, fuzzy and case-insensitive: `gantt`, `time series`, `datatable`. `--list` prints the pages by family and exits; `--no-open` prints the URL only; `--port` uses or starts the library on that port. |
| `build [target]` | Self-contained single-file HTML into `<dir>/dist/` (override with `-o/--out`; pick the entry with `-e/--entry`). `.html` entries bundle local refs (scripts, stylesheets and media alike); `.tsx` entries bundle via a generated wrapper; `.md` entries render into the template's themed page chrome (`-t/--template` picks the theme). Sibling text-data files embed behind a `fetch()` shim so `file://` works (`--max-embed` caps one file, `--max-embed-total` caps them together). Any explicitly named entry (file target, `--entry`, or a registry entry) embeds ONLY referenced files (never the surrounding vault); a bare directory embeds every sibling data file (`--embed referenced\|tree` overrides). `--watch` rebuilds on change. Idempotent. |
| `templates` | List the shipped themes: graphite (default), bone, forest, steel, tan, cobalt, auto, paper (warm paper by day, graphite by night; made for design documents). |
| `kit` | Print the kit's generated `.d.ts` API — author against it without reading component source. |
| `types [dir]` | Write an OPTIONAL editor-only `tsconfig.json` (IntelliSense for `@artifact/kit`, repo imports, react). |
| `init <file>` | Scaffold a starter (`.html` report shape, `.tsx` kit dashboard shape). |
| `list` / `add` / `remove` | Folder registry at `~/.genesis-tools/artifact/registry.json`. |
| `ps` / `stop <target>` | List / stop running artifact servers. |

## Clean URLs

Extension-less paths resolve to the longest artifact prefix (`.tsx` > `.jsx` > `.html` > `.md`):
`/demo` serves `demo.tsx`, `/Analysis/remake/postdeploy` works nested, `/notes` renders
markdown, `/report` serves `report.html`, and a bare directory shows a scoped catalog. Anything
after a `.tsx` prefix is a client-side ROUTE (`/app/item/42`) — the server falls back to the
shell so deep links reload. Raw file paths keep working; `/__catalog` always lists everything.

## Imports that just work

```tsx
import { Page, Hero, Tabs } from "@artifact/kit";        // the component kit
import { formatBytes } from "@genesiscz/utils/format";    // GenesisTools shared utils
import { x } from "@genesistools/src/<path>";             // any repo file
import { useState } from "react";                         // npm deps from the repo
```

Core CJS deps (react, marked) are aliased to the repo's node_modules AND prebundled
(`optimizeDeps`) — raw CJS served over `/@fs` has no ESM named exports, so both halves matter.

## The component kit (`@artifact/kit`)

`tools artifact kit` prints the full typed API. Highlights (every `Tone` is
`ok | warn | err | info | neutral`; string bodies render as markdown):

- Layout: `Page`, `Hero`, `Section`, `Card`/`CardGrid`, `Collapse` (styled details/summary),
  `Tabs` (hash-synced, sticky bar, per-tab status `badge`), `Router`/
  `RouterLink`/`useParams`/`useNavigate` (history API, base-aware, hash fallback on `file://`)
- Design documents: `Page look="document"` switches every kit component inside to the document
  scale (display headings, 16 px prose in `--text-2`, roomier cards); `Page nav` takes a `TopNav`
  (sticky blurred bar: brand, section links, theme button), `backdrop="glow"` adds two soft accent
  glows, `footer` closes the page. `Hero highlight` paints a phrase with the accent gradient,
  `Section id`/`number`/`intro` make numbered anchor sections, `Card` builds rich cards (`color` +
  `edge`, `kicker`, `number`, `subtitle`, `mono`, `dashed`, `tilt`, `lift`, `highlight`, `muted`,
  `fields`, `lines`, `note`, `footer`), `CardGrid min`/`fill` auto-fits columns, `Legend` keys the
  marks, `Badge tag` is a lowercase mono label, `Callout bar` is a rule note, `Compare plain`
  (with `hint`, `weights`) is an open before/after, `HUE` names seven categorical colours. Demo:
  `src/artifact/gallery/document-look.tsx`; a full page: build any `.tsx` with `-t paper`.
- Data: `StatGrid` (`delta` against a baseline, `edge` accent, auto-fit `min`), `EditableTable`
  (input cells with drafts, add/remove, validation, totals), `ChangeLedger` + `FieldDiff` +
  `diffFields` (sync history with added, removed and changed fields), `DataTable` (filter, `rowTone`, toned/markdown cells), `SeriesTable`,
  `Timeline`, `Bullets`, `QA` (per-item `open`/`featured`/`meta`), `Matrix`-style via cells
- Charts: `DayChart` (bars/lines/stacks over labeled points, log scales, reference markers),
  `DonutChart` — recharts-backed, colored by theme tones; `ChartJs` renders a raw Chart.js v4
  `config` for anything they don't cover
- Evidence: `CodeBlock` (copy button, `lang` syntax highlighting, `highlightLines`/`badLines`),
  `FileMark`, `Claim` (`[NN%]` badge), `Quote`, `Callout`, `Badge`, `Chips`, `Note`, `Superseded`
- Markdown: `Md`, `MdInline`, `MdViewer` (`src` fetches a sibling .md live — TOC + section
  filter; replaces build-time markdown inlining). Fenced code is highlighted (highlight.js core
  + 19 languages, theme-toned); a ```` ```mermaid ```` fence renders as a diagram.
- Diagrams: `Mermaid` (`chart` = mermaid source; zoom toolbar, copy source, download SVG),
  `ZoomPane` (scroll + zoom frame for any oversized SVG or image), `LayerDiagram` (a layered
  architecture drawn as SVG in the page, offline: bands of boxes on a column grid with weights,
  row and column spans, dashed and tinted boxes, arrows with labels, bus lines between bands;
  `layoutLayerDiagram` is the pure geometry)
- Diff: `DiffView` (`before`/`after` or a unified `patch`; `unified` or `split`; +/− counts)
- Structure: `TreeView` + `treeFromPaths` (file trees; `variant="ascii"` prints a command tree
  with ├─ guides, per-group badge columns and one comment column, `color` inherited), `Steps`
  (status stepper), `Compare` (A vs B columns), `KeyValue` (definition grid), `MappingList` (old
  name to new name: `arrow` rows with a note, or `stacked` rows with the old value struck
  through), `JsonView` (collapsible JSON), `Figure` (captioned image, click for full size)
- Time series: `TimeSeries` (canvas, tens of thousands of points per series with min/max
  decimation; wheel/pinch zoom, drag pan, Shift-drag box zoom, brush strip, presets, keyboard;
  series chips with Alt-click solo, combined/split layout, per-unit log, % of max, table, CSV and
  PNG export; clustered `markers`; `spans` as Gantt lanes; `syncId` shares viewport and crosshair;
  `id` persists the view in localStorage and the URL hash; `groups` titles split panels,
  `markerKinds` sets the marker kinds shown at first, `series={[]}` with `spans` draws an activity timeline). Demo: `src/artifact/gallery/time-series.tsx`
- Viz: `Sparkline` (inline trend), `Meter` (bar with thresholds), `Heatmap` (rows × cols grid),
  `SegmentBar` (one bar cut into weighted segments with labels, captions at both ends),
  `Gantt` + `GanttTable` (sprint axis, tinted lanes, baseline ghosts with a shift label,
  milestones, today line, drag and keyboard editing), `CapacityGrid` (load against capacity)
- Interactive: `Simulator` (step player), `ParametricSimulator` (sliders/segments/toggles +
  pure `generate(params)` + presets), `SegmentedControl`, `FilterChips` (`single` filters by one
  category), `SortableList`,
  `Wizard`, `Tooltip`/`useTooltip` (one shared hover card, dark in every theme)
- Forms: `Button`, `Field`, `TextInput`, `NumberInput`, `DateInput`, `Select`, `Textarea`,
  `FileInput` (dates are `YYYY-MM-DD` strings; every control has a 2 px focus ring)
- Theme: `ThemeToggle`/`useTheme` (opt-in override for the `auto` and `paper` templates;
  `variant="cycle"` is one pill button), `SERIES_COLOR`
  (8 lane colours from the shared `--series-*` tokens), `contrastRatio`/`readableTextOn`

The kit gallery (`src/artifact/gallery/`) demos every kit component, one page per family or
per larger component, and is the built-in `kit-gallery` entry of `tools artifact library`
(`tools artifact gallery` opens it). Its index finds pages with a glob, so a new `.tsx` file
there shows up with no other edit; its `meta` names the family and the components it shows.
The page opened is `?page=<id>`, because Tabs and TimeSeries own the hash. A test derives the
component list from the kit's exports, so a new component without a gallery page fails it. `tools artifact init <file>.tsx --starter roadmap`
scaffolds a project roadmap page built from these pieces.

### Mermaid is not installed

mermaid 11 is 60+ MB of node_modules, so it is not a dependency of this repo. The browser
loads the pinned ES module from jsdelivr on first use (`MERMAID_ESM_URL` in
`runtime/kit/mermaid-core.ts`) and caches it; the first render needs the network, and a
single-file build renders its diagrams online and shows the fence source offline.
`configureMermaid({ url })` points at another copy. The same loader hydrates ```` ```mermaid ````
fences in served and built `.md` pages: `page.html` inlines the transpiled `mermaid-core.ts`
when the body has a fence. Diagrams run with `securityLevel: "strict"` and take their colors
from the active theme's tokens.

## Templates (theme tokens)

Each template is a `theme.css` of CSS custom properties bridged into Tailwind v4 via
`@theme inline`, so ONE kit renders correctly under every theme (`bg-canvas`, `text-ink`,
`text-ok`, `rounded-card`, …). `--template <name|dir>`; a custom dir may override just
`theme.css` or any chrome page (`catalog.html`, `page.html`, `tsx.html`) — missing files fall
back to the default. The `auto` template writes every token once with `light-dark()` and
follows `prefers-color-scheme`; `data-theme="light"` or `"dark"` on the root overrides it
(ThemeToggle, plus a pre-paint script in the chrome pages). `build -t auto` applies it to a
`.tsx` build. The kit lives outside the served root, so `runtime/styles.css` carries an
explicit `@source "./kit"` — without it Tailwind never scans the kit's classes.

## Data rule

Small data → inline in the file. Larger → sibling `data.json` + `fetch("./data.json")` (live
when served; embedded by `build` for `file://`). Static `import data from "./data.json"` also
works and gets bundled. The `<entry>.data*.json` naming convention is auto-embedded for
single-file builds.

## Headless smoke-testing (curl, CI, agents)

The clean URL (`/name`) returns the SPA shell only — page text renders client-side, so grep
the shell for `__ARTIFACT_BASE__` (exactly 1 hit = the artifact resolved) and grep your own
strings in the transformed module at `/name.tsx` instead. In agent shells that reap
backgrounded children, start the server with `serve --detach` and stop it with
`tools artifact stop <port>`.

## Port

3076 by default, non-strict (auto-bumps); the library defaults to 3096.
