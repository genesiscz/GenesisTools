# tools artifact

Turn a SINGLE `.tsx`/`.html`/`.md` file — or a whole folder — into a live local dashboard with
clean URLs, and build self-contained single-file HTML artifacts for sharing. The artifact needs
no `node_modules`, no config, no tsconfig — React, Tailwind v4 and the component kit come from
GenesisTools.

```bash
tools artifact init dashboard.tsx && tools artifact serve dashboard.tsx   # live + HMR at /dashboard
tools artifact build dashboard.tsx                                        # dist/dashboard.html (file://)
tools artifact library up                                                 # ONE server for everything registered
```

## Commands

| Command | What it does |
|---|---|
| `serve [target]` | Vite dev server (registered name, folder, or a single file). HMR on edit. Folders auto-register; ports auto-bump from 3076, so several serves run side by side. `--template <name>` swaps the theme. |
| `library up` | ONE server: `/` lists every registered artifact folder (counts, age, click to open); each mounts at `/a/<name>/` via a lazily-started sub-server. Clean URLs work under every mount. |
| `build [target]` | Self-contained single-file HTML into `<dir>/dist/` (override with `-o/--out`; pick the entry with `-e/--entry`). `.html` entries bundle local refs; `.tsx` entries bundle via a generated wrapper. Sibling text-data files embed behind a `fetch()` shim so `file://` works. Any explicitly named entry (file target, `--entry`, or a registry entry) embeds ONLY referenced files (never the surrounding vault); a bare directory embeds every sibling data file (`--embed referenced\|tree` overrides). `--watch` rebuilds on change. Idempotent. |
| `templates` | List the shipped themes: graphite (default), bone, forest, steel, tan, cobalt. |
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
- Data: `StatGrid`, `DataTable` (filter, `rowTone`, toned/markdown cells), `SeriesTable`,
  `Timeline`, `Bullets`, `QA` (per-item `open`/`featured`/`meta`), `Matrix`-style via cells
- Charts: `DayChart` (bars/lines/stacks over labeled points, log scales, reference markers),
  `DonutChart` — recharts-backed, colored by theme tones; `ChartJs` renders a raw Chart.js v4
  `config` for anything they don't cover
- Evidence: `CodeBlock` (copy button, `highlightLines`/`badLines`), `FileMark`, `Claim`
  (`[NN%]` badge), `Quote`, `Callout`, `Badge`, `Chips`, `Note`, `Superseded`
- Markdown: `Md`, `MdInline`, `MdViewer` (`src` fetches a sibling .md live — TOC + section
  filter; replaces build-time markdown inlining)
- Interactive: `Simulator` (step player), `ParametricSimulator` (sliders/segments/toggles +
  pure `generate(params)` + presets), `SegmentedControl`

## Templates (theme tokens)

Each template is a `theme.css` of CSS custom properties bridged into Tailwind v4 via
`@theme inline`, so ONE kit renders correctly under every theme (`bg-canvas`, `text-ink`,
`text-ok`, `rounded-card`, …). `--template <name|dir>`; a custom dir may override just
`theme.css` or any chrome page (`catalog.html`, `page.html`, `tsx.html`) — missing files fall
back to the default. The kit lives outside the served root, so `runtime/styles.css` carries an
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
