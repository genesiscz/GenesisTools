# tools artifact

Turn a single `.tsx`, `.html` or `.md` file, or a whole folder of them, into a live local dashboard with clean
URLs, and build self-contained single-file HTML artifacts that open from `file://`. The artifact needs no
`node_modules`, no config and no tsconfig: React, Tailwind v4 and a component kit of more than 60 components come
from GenesisTools.

## Quick start

```bash
tools artifact init dashboard.tsx               # scaffold a kit dashboard (never hand-write the shell)
tools artifact serve dashboard.tsx              # live server with HMR, opens /dashboard
tools artifact build dashboard.tsx              # dist/dashboard.html, works from file://
tools artifact serve ~/Projects/app/reports     # serve a folder: catalog at /, every file at a clean URL
tools artifact library up                       # one server for every registered folder
tools artifact gallery gantt                    # the kit gallery, at the Gantt page
```

## Commands

Every command has `--help`. The global flags are `-v, --verbose` and `--readme`.

### Make and view an artifact

| Command | What it does |
|---|---|
| `init <file>` | Scaffold a starter page. Refuses to overwrite an existing file. |
| `serve [target]` | Start a Vite dev server with HMR for a file, a folder or a registered name. |
| `open <target> [page]` | Open a page in the browser, starting its server first when none runs. |
| `build [target]` | Write one self-contained HTML file that works from `file://`. |

A `target` is a registered name, a folder, or a single artifact file. With no target, `serve` and `build` use the
current folder.

`init` picks the starter from the file extension: `<name>.tsx` gets the kit dashboard, `<name>.html` gets the report
shape and a sample `data.json` beside it (the page fetches that file, so edits to it are live at once).
`--starter <name>` picks one of `dashboard`, `report` or `roadmap` (a project roadmap: KPIs, a Gantt chart, capacity
and a sync log). The starter's extension must match the file name:

```bash
tools artifact init plan.tsx --starter roadmap
```

`serve` flags:

| Flag | Default | Meaning |
|---|---|---|
| `--port <port>` | `3076` | First port to try. A busy port moves to the next free one. |
| `--host <host>` | `127.0.0.1` | Bind address. |
| `--template <nameOrDir>` | graphite | Theme: a shipped name or a folder. |
| `--no-open` | | Do not open the browser. |
| `--no-register` | | Do not add the folder to the registry. |
| `--detach` | | Start the server in the background and return. |

`--host 0.0.0.0` publishes the server with no auth. Anyone on the network can then read the served folder and the
repo's `src/` and `node_modules/` through `/@fs/`. Keep the default `127.0.0.1` unless you need that. The same holds
for `library up --host`.

A folder target registers itself in the registry. A single-file target does not register its parent folder, because
that folder may be `~/Downloads` or a vault root. You can run `serve` several times: each server takes the next free
port. Ctrl-C stops a foreground server.

`--detach` starts the server in its own session (setsid), waits up to 30 seconds for the line the server prints once
it listens, and then prints the real URL, the pid and the log path. The log is a new
`$TMPDIR/artifact-serve-*/server.log` for every launch. Use the printed URL, never a guessed 3076: on 2026-10-16 an
agent handed out a 3076 URL while its server listened on 3088, and 3076 was another folder's server (a 404). When the
server is still starting after 30 seconds, the command prints the log tail and returns with exit code 0 and no URL.
Check `ps` before you retry. The detached server always runs with `--no-open`, so it never opens the browser.

`open` waits up to `--timeout <seconds>` (default `20`) for the server. A file target opens its own page (`open
hello.tsx` opens `/hello`), and a registered name with a default entry opens that entry. A folder target, or a name
with no default entry, opens the catalog. A second `open` of the same folder waits on a lock and then uses the
server the first one started, instead of starting another one. The server that `open` starts is a background
`serve <target> --no-open`, so a folder target registers the same way as with `serve`. Its log is
`$TMPDIR/artifact-open-<target>.log`. The browser is your preferred browser in GenesisTools (Brave when none is set).

`build` flags:

| Flag | Default | Meaning |
|---|---|---|
| `-e, --entry <file>` | see below | Entry file, relative to the folder. |
| `-o, --out <file>` | `<dir>/dist/<name>.html` | Output path. |
| `--max-embed <mb>` | `5` | Cap for one embedded data file. |
| `--max-embed-total <mb>` | `32` | Cap for all embedded data files together. |
| `--embed <scope>` | see below | `referenced` or `tree`. |
| `-t, --template <name>` | graphite | Theme for a `.md` page or a `.tsx` build. |
| `--watch` | | Stay running and rebuild on every change. |

- The entry is `--entry`, the file target, the registry entry, `index.html`, or the only `.html` file in the folder,
  in that order. So `build page.tsx --entry other.html` builds `other.html`. A folder with several `.html` files and
  no entry is an error that lists the candidates.
- An entry may be `.html`, `.tsx`, `.jsx` or `.md`. Auto-detect never picks a `.tsx`, `.jsx` or `.md` file: a folder
  of those needs a file target, `--entry` or a registry entry, or the build fails with `No .html entry`.
- `<name>` in the default output path is the entry's file name without its folder. A `.tsx`, `.jsx` or `.md` name
  becomes `.html`, and an `.html` name stays as it is (`index.html` writes `dist/index.html`).
- An `.html` entry gets its local scripts, stylesheets and media bundled into the file. A `.tsx` entry is bundled
  through a generated wrapper. A `.md` entry renders into the template's themed page.
- Sibling text data files are embedded behind a `fetch()` shim, so `fetch("./data.json")` works from `file://`.
- Any explicitly named entry (a file target, `--entry` or a registry entry) embeds only the files it references,
  never the folder around it, which may be a whole vault. A bare folder embeds every sibling data file. `--embed`
  overrides both.
- A file over a cap is not embedded, and the build prints a `NOT embedded` warning for it.
- The build is idempotent: run it again and it overwrites the same output file.

### The library and the kit gallery

| Command | What it does |
|---|---|
| `library up` | One server for every registered folder (`library` alone runs `up`). |
| `gallery [component...]` | Open the kit gallery, starting the library first when none runs. |

`library up` serves a page at `/` that lists every registered folder with its file counts, age and default entry.
Each folder mounts at `/a/<name>/` through its own Vite server, which starts on the first request. At most 8 mounts
stay live at once. On overflow the least recently used mount closes, because every mount holds compiled modules and
file watchers. Clean URLs work under every mount.

| Flag | Default | Meaning |
|---|---|---|
| `--port <port>` | `3096` | Library port. It does not move to another port when busy. `0` takes any free port. |
| `--host <host>` | `127.0.0.1` | Bind address. |
| `--template <nameOrDir>` | graphite | Theme for the library and every mount. |
| `--no-open` | | Do not open the browser. |

The kit gallery is the built-in `kit-gallery` entry of the library. It shows every kit component, one page per
family or per larger component, grouped by family, with a search box. `gallery` options:

- A name opens one page, fuzzy and case-insensitive: `gantt`, `time series`, `datatable`.
- `--list` prints the pages by family and exits.
- `--no-open` starts the server when needed and prints the URL only.
- `--port <port>` uses or starts the library on that port (default: a running library, else 3096). `0` is not
  accepted here. Use `library up --port 0`.
- `--timeout <seconds>` waits that long for a starting server (default `20`).

### The registry

| Command | What it does |
|---|---|
| `list [--json]` | List registered folders, and any running server outside the registry. |
| `add <dir>` | Register a folder. `--name <name>` (default: the folder name), `--entry <file>`. |
| `remove <name>` (`rm`) | Remove a folder from the registry. The folder itself is not touched. |

An automatic name that is taken gets a suffix (`reports-2`). An explicit `--name` that is taken is an error.
`add` on a folder that is already registered updates its name or entry.

### Running servers

| Command | What it does |
|---|---|
| `ps [--json]` | List running artifact and library servers: name, port, pid, folder. |
| `stop <target>` | Stop a server by name, port, or the folder path that `ps` prints. |

`stop` sends SIGTERM only when the pid is alive and still runs the command that was recorded at start. A dead or
recycled pid does not match any server, so `stop` says `No running server matches` and exits 1. Its record stays in
`running.json` until the next server start rewrites the file. If `stop` cannot verify a record (an older record
without a command, or a process whose command the OS hides), it drops the record and sends no signal. `ps` only
reads.

### Authoring help

| Command | What it does |
|---|---|
| `kit [names...]` (`api`) | Print the kit's generated `.d.ts`. Names filter it: `kit Tabs DayChart QA`. |
| `types [dir]` | Write an optional, editor-only `tsconfig.json` (see below). |
| `templates` | List the shipped themes with a one-line personality each. |

Read `kit` output for props and types instead of the component source. `types` gives IntelliSense for
`@artifact/kit`, `@genesiscz/utils`, `@genesistools/*` repo imports, react, chart.js and recharts. It leaves an
existing `tsconfig.json` untouched; the runtime never needs the file, so it is safe to delete or gitignore. Its paths
point into this checkout, so run `types` again after you move the checkout or switch to another one.

## How it works

### Clean URLs

Extension-less paths resolve to the longest artifact prefix, in the order `.tsx`, `.jsx`, `.html`, `.md`:

- `/demo` serves `demo.tsx`, `/notes` renders `notes.md`, `/report` serves `report.html`.
- Nested paths work: `/analysis/remake/postdeploy`.
- Anything after a `.tsx` prefix is a client-side route (`/app/item/42`). The server answers with the page shell, so
  a deep link survives a reload.
- A folder path shows a catalog of that folder. Raw file paths keep working, and `/__catalog` always lists
  everything.

### Imports that just work

```tsx
import { Page, Hero, Tabs } from "@artifact/kit";        // the component kit
import { formatBytes } from "@genesiscz/utils/format";    // GenesisTools shared utils
import { x } from "@genesistools/src/<path>";             // any repo file
import { useState } from "react";                         // npm deps from the repo
```

Vite may read only the served folder, the repo's `src/` and the repo's `node_modules`. An import that points
anywhere else fails instead of being served. This list is also what a remote client can read when `--host`
publishes the server (see `serve` above). The core CommonJS dependencies (react, marked) are aliased to the
repo's `node_modules` and also prebundled (`optimizeDeps`). Both halves matter: raw CommonJS served over `/@fs` has
no ESM named exports.

### Data

Small data goes inline in the file. Larger data goes in a sibling `data.json` that the page reads with
`fetch("./data.json")`: live when served, embedded by `build` for `file://`. A static
`import data from "./data.json"` also works and is bundled. Files named `<entry>.data*.json` are embedded in a
single-file build automatically.

### Where things live

| Path | Holds |
|---|---|
| `~/.genesis-tools/artifact/registry.json` | Registered folders: name, folder, default entry, date. |
| `~/.genesis-tools/artifact/running.json` | Running servers: pid, port, folder, name, start time. |
| `<repo>/node_modules/.vite-cache/artifact-<hash>/` | The Vite cache of each served folder. |
| `<repo>/node_modules/.vite-cache/artifact-kit-dts/` | The generated kit `.d.ts` behind `kit`. |
| `<dir>/dist/` | `build` output. |

The served folder never gets a `node_modules` or `.vite` folder of its own, because it is often user content such
as a vault folder. `GENESIS_TOOLS_HOME` moves the `~/.genesis-tools` root.

### What it calls

- Vite, React and Tailwind v4 from the GenesisTools checkout. No network is needed, with one exception: mermaid
  (below).
- The browser, through `open` on macOS (`serve`, `library up`) or your preferred browser (`open`, `gallery`).
- GenesisTools.app lists two services: "Artifact Server" (port 3076) runs
  `tools artifact serve kit-gallery --no-open --no-register`, and "Artifact Library" (port 3096) runs
  `tools artifact library up`.
- The `artifact` route of `tools browser-router` turns `https://<linkHost>/artifact/<name>/<page>` into a call of
  `open`.

Nothing here costs money.

### Mermaid is not installed

mermaid 11 is more than 60 MB of `node_modules`, so it is not a dependency of this repo. The browser loads the
pinned ES module from jsdelivr on first use (`MERMAID_ESM_URL` in `runtime/kit/mermaid-core.ts`) and caches it. The
first render needs the network, and a single-file build renders its diagrams online and shows the fence source
offline. `configureMermaid({ url })` points at another copy. The same loader renders ```` ```mermaid ```` fences in
served and built `.md` pages: `page.html` inlines the transpiled `mermaid-core.ts` when the body has a fence.
Diagrams run with `securityLevel: "strict"` and take their colors from the active theme's tokens.

## The component kit (`@artifact/kit`)

`tools artifact kit` prints the full typed API. Every `Tone` is `ok | warn | err | info | neutral`, and string
bodies render as markdown.

- Layout: `Page`, `Hero`, `Section`, `Card`/`CardGrid`, `Collapse` (styled details/summary), `Tabs` (hash-synced,
  sticky bar, per-tab status `badge`), `Router`/`RouterLink`/`useParams`/`useNavigate` (history API, base-aware,
  hash fallback on `file://`).
- Design documents: `Page look="document"` switches every kit component inside to the document scale (display
  headings, 16 px prose in `--text-2`, roomier cards). `Page nav` takes a `TopNav` (sticky blurred bar: brand,
  section links, theme button), `backdrop="glow"` adds two soft accent glows, and `footer` closes the page.
  `Hero highlight` paints a phrase with the accent gradient. `Section id`/`number`/`intro` make numbered anchor
  sections. `Card` builds rich cards (`color` + `edge`, `kicker`, `number`, `subtitle`, `mono`, `dashed`, `tilt`,
  `lift`, `highlight`, `muted`, `fields`, `lines`, `note`, `footer`). `CardGrid min`/`fill` auto-fits columns,
  `Legend` keys the marks, `Badge tag` is a lowercase mono label, `Callout bar` is a rule note, `Compare plain`
  (with `hint`, `weights`) is an open before/after, and `HUE` names seven categorical colours. Demo:
  `src/artifact/gallery/document-look.tsx`. For a full page, build any `.tsx` with `-t paper`.
- Data: `StatGrid` (`delta` against a baseline, `edge` accent, auto-fit `min`), `EditableTable` (input cells with
  drafts, add/remove, validation, totals), `ChangeLedger` + `FieldDiff` + `diffFields` (sync history with added,
  removed and changed fields), `DataTable` (filter, `rowTone`, toned and markdown cells), `SeriesTable`, `Timeline`,
  `Bullets`, `QA` (per-item `open`/`featured`/`meta`).
- Charts: `DayChart` (bars, lines and stacks over labeled points, log scales, reference markers) and `DonutChart`,
  both backed by recharts and colored by theme tones. `ChartJs` renders a raw Chart.js v4 `config` for anything
  they do not cover.
- Evidence: `CodeBlock` (copy button, `lang` syntax highlighting, `highlightLines`/`badLines`), `FileMark`, `Claim`
  (`[NN%]` badge), `Quote`, `Callout`, `Badge`, `Chips`, `Note`, `Superseded`.
- Markdown: `Md`, `MdInline`, `MdViewer` (`src` fetches a sibling `.md` live, with a TOC and a section filter; it
  replaces build-time markdown inlining). Fenced code is highlighted (highlight.js core with 19 languages, toned by
  the theme), and a ```` ```mermaid ```` fence renders as a diagram.
- Diagrams: `Mermaid` (`chart` is the mermaid source; zoom toolbar, copy source, download SVG), `ZoomPane` (scroll
  and zoom frame for an oversized SVG or image), `LayerDiagram` (a layered architecture drawn as SVG in the page,
  offline: bands of boxes on a column grid with weights, row and column spans, dashed and tinted boxes, labelled
  arrows, bus lines between bands; `layoutLayerDiagram` is the pure geometry).
- Diff: `DiffView` (`before`/`after` or a unified `patch`; `unified` or `split`; +/- counts).
- Structure: `TreeView` + `treeFromPaths` (file trees; `variant="ascii"` prints a command tree with ├─ guides,
  per-group badge columns and one comment column, `color` inherited), `Steps` (status stepper), `Compare` (A vs B
  columns), `KeyValue` (definition grid), `MappingList` (old name to new name: `arrow` rows with a note, or
  `stacked` rows with the old value struck through), `JsonView` (collapsible JSON), `Figure` (captioned image, click
  for full size).
- Time series: `TimeSeries` (canvas, tens of thousands of points per series with min/max decimation; wheel and pinch
  zoom, drag pan, Shift-drag box zoom, brush strip, presets, keyboard; series chips with Alt-click solo, combined or
  split layout, per-unit log, % of max, table, CSV and PNG export; clustered `markers`; `spans` as Gantt lanes;
  `syncId` shares viewport and crosshair; `id` keeps the view in localStorage and the URL hash; `groups` titles
  split panels, `markerKinds` sets the marker kinds shown at first, and `series={[]}` with `spans` draws an activity
  timeline). Demo: `src/artifact/gallery/time-series.tsx`.
- Viz: `Sparkline` (inline trend), `Meter` (bar with thresholds), `Heatmap` (rows × cols grid), `SegmentBar` (one
  bar cut into weighted segments with labels, captions at both ends), `Gantt` + `GanttTable` (sprint axis, tinted
  lanes, baseline ghosts with a shift label, milestones, today line, drag and keyboard editing), `CapacityGrid`
  (load against capacity).
- Interactive: `Simulator` (step player), `ParametricSimulator` (sliders, segments and toggles, a pure
  `generate(params)` and presets), `SegmentedControl`, `FilterChips` (`single` filters by one category),
  `SortableList`, `Wizard`, `Tooltip`/`useTooltip` (one shared hover card, dark in every theme).
- Forms: `Button`, `Field`, `TextInput`, `NumberInput`, `DateInput`, `Select`, `Textarea`, `FileInput` (dates are
  `YYYY-MM-DD` strings; every control has a 2 px focus ring).
- Theme: `ThemeToggle`/`useTheme` (opt-in override for the `auto` and `paper` templates; `variant="cycle"` is one
  pill button), `SERIES_COLOR` (8 lane colours from the shared `--series-*` tokens),
  `contrastRatio`/`readableTextOn`.

### The gallery source

The gallery lives in `src/artifact/gallery/`. Its index finds pages with a glob, so a new `.tsx` file there shows up
with no other edit, and the page's `meta` names its family and the components it shows. The open page is in
`?page=<id>`, because Tabs and TimeSeries own the hash. A test derives the component list from the kit's exports,
so a new component without a gallery page fails it.

## Configuration

There is no config file. The registry is managed with `add`, `remove` and `serve`, and the ports are flags.

`GENESIS_TOOLS_HOME` moves the `~/.genesis-tools` root, so `registry.json` and `running.json` move with it.

### Templates (themes)

| Name | Personality |
|---|---|
| `graphite` | Default. Cold near-black, one cool mint accent. |
| `bone` | Editorial reader: cool off-white paper, ink black, oxide-red accent. |
| `forest` | Field handbook: deep green ground, bone text, amber accent. |
| `steel` | Near-zero chroma. Color is spent only on status. |
| `tan` | Black and tan presentation. High contrast, sharp corners. |
| `cobalt` | Paper and cobalt, client-facing light. |
| `auto` | Follows the system: cobalt by day, graphite by night. |
| `paper` | Follows the system: warm paper by day, graphite by night. For design documents. |

The shipped folder of `graphite` is named `default`; `templates` prints it as `default (graphite)`, and both names
work. Each template is a `theme.css` of CSS custom properties bridged into Tailwind v4 through `@theme inline`, so one
kit renders correctly under every theme (`bg-canvas`, `text-ink`, `text-ok`, `rounded-card`, and so on).

- `--template <dir>` takes a custom folder. It may override only `theme.css`, or any chrome page (`catalog.html`,
  `page.html`, `tsx.html`). A missing file falls back to the default.
- `auto` and `paper` write every token once with `light-dark()` and follow `prefers-color-scheme`.
  `data-theme="light"` or `"dark"` on the root element overrides it (`ThemeToggle`, plus a pre-paint script in the
  chrome pages). `build -t auto` applies it to a `.tsx` build.
- The kit lives outside the served root, so `runtime/styles.css` carries an explicit `@source "./kit"`. Without it,
  Tailwind never scans the kit's classes.

### Ports

| Server | Default | When busy |
|---|---|---|
| `serve` | 3076 | Moves to the next free port. |
| `library up` | 3096 | Fails. Pick another `--port`, or `0` for any free port. |

## For agents

- From an agent shell (Codex, Claude Bash, Grok), start servers with `serve --detach`. A plain `serve` ties up the
  shell, and an agent shell kills the process group of a backgrounded `nohup … &` child when the command returns
  (2026-10-16: empty log, no server, a 404). Use the URL that `--detach` prints, and stop the server with
  `tools artifact stop <port>`.
- A `--detach` that is still starting after 30 seconds exits 0 with no URL. Read the `Detached server pid … <url>`
  line, not the exit code. A detached server never opens the browser.
- `list --json` and `ps --json` print machine-readable arrays.
- Every error exits 1. Examples: an unknown name in `remove`, `stop` or `gallery`, a bad flag value, a refused folder,
  a missing entry or template, an existing file in `init`, a busy library port, a server that `open` could not reach
  in time, or a detached server that exited before it served.
- Read `tools artifact kit` (or `kit <Name>`) for the kit API. Skip `types` in agent sessions.
- The plugin skill `genesis-tools:artifact` (`plugins/genesis-tools/skills/artifact/SKILL.md`) carries the authoring
  and design rules for agents.

### Smoke-test without a browser

The clean URL (`/name`) returns the page shell only, because the page text renders in the browser. Check the shell
for `__ARTIFACT_BASE__` (exactly one hit means the artifact resolved), and look for your own strings in the
transformed module at `/name.tsx`:

```bash
origin='http://127.0.0.1:3077'    # the origin that serve --detach printed
curl -s "$origin/dashboard" | rg -c __ARTIFACT_BASE__
curl -s "$origin/dashboard.tsx" | rg -c 'sample stat'   # a string from your page
curl -s "$origin/__catalog" | rg dashboard
```

## Troubleshooting

- **"Refusing …: it is the home folder" (or the root of the disk, a top-level folder, a folder that contains the
  home folder).** Every server walks every file under its folder, and serving the disk root once took 8.5 GB and a
  CPU core for half an hour. There is no override. Move the artifacts into a folder of their own and serve that.
  A registry entry like that is skipped with a warning in the log.
- **The page shows a 404 or another folder's content.** The server moved to another port because the first one was
  busy. Read the real port with `tools artifact ps`, or use the URL that `serve --detach` printed.
- **`open` says the artifact "did not answer".** Read the log it names (`$TMPDIR/artifact-open-<target>.log`) and
  `tools artifact ps`. Raise `--timeout` for a large folder.
- **Ctrl-C hangs.** Vite 8.2.2 `close()` could hang for good (vitejs/vite#22934). The server now waits at most
  5 seconds, warns, drops its record and exits anyway.
- **A diagram shows its source text.** mermaid loads from jsdelivr, so the first render needs the network, and an
  offline single-file build shows the fence source. Use `LayerDiagram` for an offline architecture drawing.
- **The build printed `NOT embedded`.** The file is over `--max-embed`, or the total is over `--max-embed-total`.
  Raise the cap, or keep the data smaller.
- **`build` says "Multiple .html files".** Pass `--entry <file>`, or set an entry with `add <dir> --entry <file>`.
- **`build` says "No .html entry".** The folder has no `.html` file, and auto-detect never picks a `.tsx`, `.jsx` or
  `.md` file. Name the file (`build page.tsx`), pass `--entry <file>`, or set an entry with `add <dir> --entry <file>`.
- **`library up` fails at start.** Port 3096 is taken, often by another library. Check `tools artifact ps`, or pass
  another `--port`.

## Related

- [`tools browser-router`](../browser-router/README.md): the `artifact` route opens a registered page from a link.
- [`tools link`](../link/README.md): makes `@genesiscz/utils` resolve for loose files outside the checkout. An
  artifact does not need it, because its Vite server resolves those imports with an alias.
