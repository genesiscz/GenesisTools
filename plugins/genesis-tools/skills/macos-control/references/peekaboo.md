# Peekaboo as a separate provider

Use this only when Peekaboo is the chosen provider, or when you need recording. It is not
Sky, and it does not use GenesisTools snapshot tokens. Opaque Peekaboo element IDs and
GenesisTools integer indexes are different things; never mix them.

## Version, and why that matters here

Everything below was checked against **Peekaboo 4.3.0** (`main/44eff916c`, built
2026-09-02) on 2026-09-11. Peekaboo changes its CLI grammar across majors, and this file has
been wrong twice before by being pinned to an older one. **Run `peekaboo --version` and the
relevant `--help` before trusting any line here.**

```bash
peekaboo --version
peekaboo see --help
peekaboo click --help
peekaboo window list --help
peekaboo capture live --help
```

## 🛑 What version 4 removed

- **`peekaboo list` is gone.** `peekaboo list screens` now answers
  `Command 'peekaboo list' was removed in v4. Use 'peekaboo screen list'.` The replacements
  are `peekaboo app list`, `peekaboo window list` and `peekaboo screen list`.
- **`window list --include-details` is gone.** Bounds are returned by default.
- Global runtime flags (`--json`, `--verbose`, `--no-remote`, `--log-level`,
  `--bridge-socket`, `--input-strategy`) go **after the leaf command**, not after `peekaboo`.

GenesisTools still calls the removed form in two places, which is why recording is currently
broken. See the breakage note at the top of [capture.md](capture.md).

## Command surface, 4.3.0

```text
Core         bridge  capture  clean  completions  config  daemon  learn  permissions  screen  tools
Interaction  action  click  drag  move  paste  press  scroll  set-value  type
System       app  clipboard  dialog  dock  menu  menubar  space  visualizer  window
Vision       see  verify
AI           agent
MCP          browser  mcp
```

`peekaboo learn` prints Peekaboo's own agent guide. `peekaboo tools` lists its MCP catalogue.

## Inspect, then act

```bash
peekaboo window list --app Calculator --json
peekaboo see --app Calculator --window-id WINDOW_ID --path /tmp/peekaboo-calculator.png --json
```

Read the returned snapshot and opaque element IDs exactly as provided. Do not infer an
element's role from the shape of its ID, and do not reuse an ID from an earlier inspection.

```bash
peekaboo click --snapshot SNAPSHOT --on ELEMENT_ID --json
```

Inspect again and view the screenshot before deciding the next action. If focus fails, or the
returned app or window differs from what you targeted, stop the sequence and re-inspect the
intended target. Do not fall back to a frontmost screenshot.

`see` flags worth knowing: `--window-id`, `--window-title`, `--window-index`, `--mode
screen|window|frontmost|multi|area`, `--region`, `--roi`, `--annotate`, `--retina`, `--tree`,
`--no-screenshot` (requires `--tree`), `--ocr`, `--menubar`, `--depth`, `--max-elements`,
`--capture-engine auto|classic|cg|modern|sckit`.

⚠️ `see --annotate` puts zero boxes on web content, so it is near-useless on a browser window.
Use `tools control capture clickmap --app "<Browser>"` for a coordinate grid instead, or
`tools control screenshot --annotate` on native apps.

## Coordinate semantics — the classic trap

`peekaboo click --at x,y` is **target-relative when `--app` or a `--window-*` selector is
given, and global otherwise**. Pass `--global` to be explicit. Background coordinate clicks
require an explicit fresh exact-window snapshot; Peekaboo will not infer `latest` for them.

🛑 These semantics differ from every other tool in this skill. **Never transpose a
screenshot's pixels straight into another tool's coordinate system.** Prefer observed element
IDs over coordinates, and read `click --help` before any coordinate or foreground input.

`type` takes `--profile linear|human`; linear is the 4.x default, and `human` ignores
`--delay`, which destroys timing inside a recording. `press` takes a chord plus `--count`,
`--delay` and `--hold`. `scroll` takes `--direction` and `--amount` in ticks, optionally
`--on ELEMENT_ID`.

## The daemon and the bridge

Peekaboo routes permission-bound work through a running host process. Two failures seen on
this machine:

- 🛑 `Bridge host PID … predates safe process-lifetime ScreenCaptureKit ownership. No capture
  was dispatched.` The daemon is stale. `--capture-engine classic` works around it; the real
  fix is relaunching the host. **Revalidate and stop the exact PID and generation named in the
  error, never the socket path alone.**
- A `[Visualizer][INFO]` line is written to **stderr** on many commands. Keep stdout and
  stderr separate or it corrupts your JSON parse.

`peekaboo permissions status` and `peekaboo bridge status --verbose --json` are the
diagnostics. `peekaboo clean` prunes snapshot caches (`--older-than`, `--all-snapshots`,
`--dry-run`).

## MCP surface

MCP availability is discovered from the host's actual tool list, and versions differ in what
they expose. Never claim a tool is present or absent from the provider's name alone. There is
no `capture` tool over MCP: recording is CLI only. No AI analysis flag is needed for basic
inspection, and screenshots should not be sent to another model unless the task calls for it.
