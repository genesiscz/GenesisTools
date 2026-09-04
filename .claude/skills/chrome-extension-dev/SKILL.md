---
name: chrome-extension-dev
description: Drive a real, extension-loaded Chrome/Brave browser for the GenesisTools YouTube extension via chrome-devtools-mcp as a standalone MCP client — no Claude Code config edits, no restart. Use whenever the user wants to test, debug, screenshot, or click through the YouTube extension's UI (side panel tabs, popup, content script), asks to "load the extension and click X", wants a screenshot of the extension mid-interaction, or needs to find exact pixel coordinates to click something inside a web page (not a native macOS app — for that, use the screen-capture skill instead). Also use this whenever chrome-devtools-mcp's own tools are attempted and fail with "no browser" or launch a blank vanilla browser with no extension loaded — that means the server wasn't wired to a real browser, and this skill is the fix.
---

# chrome-extension-dev

Repo-local (this skill lives in `.claude/skills/`, not the portable `~/.agents/skills/`). It carries no scripts of its own: every mechanic it describes is a real module in this repo's shipped source tree, and this file points at them.

## The problem this solves

Claude Code's MCP servers (like `chrome-devtools-mcp`) spawn once at session start with a fixed argv read from `~/.claude.json`. There is no tool call that redirects an already-running MCP server to a different browser, adds `--browserUrl`, or loads an extension — that requires editing the config and **restarting the whole Claude Code session**, which is disruptive mid-task.

Separately: peekaboo's AX-tree tools (`see`, `find`) are near-useless on **web page content** — Chromium doesn't expose its web accessibility tree to them in the tested build. They only see browser chrome (tabs, bookmarks), never the page itself. So finding a click target inside a web page by AX inspection doesn't work; pixel coordinates are the only reliable path in.

This skill fixes both: it spawns `chrome-devtools-mcp` **directly, as its own MCP client**, with whatever argv it needs (a real `--browserUrl`) — bypassing Claude Code's server config entirely — and it bakes a labeled coordinate grid onto screenshots so pixel targets can be read off an image instead of guessed and iterated.

## Quick start (the YouTube extension)

```bash
cd /path/to/GenesisTools   # or a worktree of it

# 1. Build the extension and launch Brave/Chrome with it loaded + a CDP port open
bun --bun src/youtube/index.ts extension devtools launch
# → prints: Chrome up (pid NNNN), CDP endpoint: http://127.0.0.1:9333

# 2. Drive it — list every chrome-devtools-mcp tool
bun --bun src/youtube/index.ts extension devtools list-tools

# 3. Call any tool directly
bun --bun src/youtube/index.ts extension devtools call navigate_page \
  '{"type":"url","url":"https://www.youtube.com/watch?v=VIDEO_ID"}'

# 4. Screenshot + labeled coordinate grid, for locating a click target
bun --bun src/youtube/index.ts extension devtools get-frame-grid /tmp/grid.png --step 60
# → Read the PNG; every gridline is labeled with its real page pixel coordinate.
#   Feed that x,y straight into a `click` tool call — no iteration, no guessing.
```

**Use the `bun --bun src/youtube/index.ts extension ...` form, not `tools youtube extension ...`.** The `tools` shim resolves to the *main* GenesisTools checkout regardless of which worktree you're actually in — a documented gotcha. If you're working in a worktree, `tools` silently builds/launches from the wrong checkout. Invoking the entrypoint directly always uses the code you're standing in.

**Kill the browser when done**: the `launch` output prints a `kill <pid>` command. Leaving it running is fine short-term, but a stale extension-loaded Chrome from a previous session's temp profile has caused real confusion before (macOS Dock/app-activation can route clicks to the wrong instance when two Brave profiles are alive at once) — clean up rather than accumulate them.

## Any browser, no extension: `tools chrome-devtools`

The same mechanics are a first-class CLI when the target is not the YouTube extension:

```bash
tools chrome-devtools open --browser brave --port 9222 --fresh https://example.com
tools chrome-devtools open --port 9333 --extension /path/to/dist/extension   # unpacked extension, own profile
tools chrome-devtools attach                    # what is running, and how to talk to it
tools chrome-devtools targets --port 9333       # one line per tab: id, title, url
```

`open --extension` is the generic form of the YouTube `devtools launch` above: same flags, same profile isolation, no build step.

## Where the code lives

Nothing here is a script in this directory. Follow the module:

- **Launching a CDP browser — `src/chrome-devtools/lib/launch.ts`.** `launchArgs()` builds the Chromium flags (`--remote-debugging-port`, profile isolation, `--load-extension`); `launchCdpBrowser()` spawns, waits for the port, and throws a `CdpLaunchError` carrying the tail of the browser's own log. Executable lookup, `open -na` vs. direct spawn, and the quit/restart primitives are in `src/chrome-devtools/lib/resolve-attach.ts`.
- **The standalone MCP client — `src/chrome-devtools/lib/mcp.ts`** (thin door) over **`src/utils/devtools/mcp-client.ts`** (the core). It spawns `chrome-devtools-mcp` via `StdioClientTransport` with `--browserUrl <cdpUrl>`. That is the whole trick: a normal MCP client/server pair, spawned by us instead of by Claude Code's launcher.
- **The labeled coordinate grid — `src/chrome-devtools/lib/frame-grid.ts`.** `captureFrameGrid()` screenshots over raw CDP (no MCP server just to take a PNG), optionally crops to a region via `magick`, then overlays a red grid. Every label sits on a solid black backing chip: a bare-text label was confirmed illegible against busy page content — don't regress that. Labels show the *real* page pixel coordinate, region-offset-corrected when cropped.
- **The YouTube-extension wrapper — `src/youtube/lib/devtools/browser.ts`.** The only extension-specific part: build via `buildExtension({ devReload: true })`, verify the build is complete, then delegate the launch to `launchCdpBrowser`. Its endpoint default (`$YOUTUBE_EXTENSION_CDP_URL`, else port 9333) lives in `src/youtube/lib/devtools/mcp-client.ts`.
- **The CLI wrappers** are thin commander plumbing over those modules: `src/youtube/commands/extension.ts` for `extension devtools <launch|list-tools|call|get-frame-grid>`, `src/chrome-devtools/commands/browse.ts` for `open|restart|targets`.

## Gotchas already paid for

- **`stdio: ["ignore","ignore","ignore"]` makes Chrome silently stall before opening the CDP port** — confirmed live, repeatedly: the browser process starts, spawns exactly a GPU helper process and nothing else, and never progresses further. Piping stdout/stderr to a real file (not `/dev/null`, not fully ignored) fixes it. This is why `launchCdpBrowser({ logPath })` spawns the browser binary itself rather than going through `open -na`, which cannot own the app's stdio. `defaultSpawnLogged` in `src/chrome-devtools/lib/launch.ts` carries the comment — don't "simplify" it back to `ignore`.
- **A cold profile needs 30s, not 20s.** First run on a new `--user-data-dir` parses the cert store and validates every loaded extension. `launchCdpBrowser` picks `COLD_PROFILE_TIMEOUT_MS` automatically whenever the launch makes its own profile (`--fresh`, `--extension`, or an explicit `userDataDir`).
- **Zombie test-instance processes squat the CDP port.** Every failed/orphaned `launch` leaves a full Chrome process tree (main + gpu + renderer + network + storage + audio/video-capture helpers) alive under its own temp `--user-data-dir`. If port 9333 is already bound by a zombie, a new launch silently never opens a *second* listener on it and just hangs — looks identical to a real launch failure. Check first: `ps aux | rg "remote-debugging-port=9333"` and `pkill -9 -f "genesis-yt-devtools-chrome"` before re-launching if something looks stuck. `tools chrome-devtools attach` also lists every live endpoint.
- **A broken extension build fails with a blocking GUI dialog you'll never see if you're only polling the CDP port.** "Failed to load extension from: ... Could not load javascript 'content-script.js'" is a real macOS alert that requires a click to dismiss — until dismissed, Chrome doesn't finish starting, which looks exactly like a hung CDP port from the outside. The post-build file-existence check in `src/youtube/lib/devtools/browser.ts` exists specifically to catch this *before* Chrome ever launches, rather than after a 30s timeout.
- **`chrome-devtools-mcp`'s own flags (`--browserUrl`, `--chromeArg`, `--categoryExtensions`, etc.) are process-startup-only** — there is no tool call, no runtime option, no "navigate the server itself" mechanism. If you ever consider reconfiguring the *actual* `chrome-devtools-mcp` MCP server Claude Code has wired up instead of using this skill's standalone client, know going in that it requires an edit to `~/.claude.json` and a full session restart — not something to do without asking the user first.
- **`--categoryExtensions` (chrome-devtools-mcp's own native extension-debugging support) is currently incompatible with `--browserUrl`/`--wsEndpoint`/`--autoConnect`** (gated behind a future Chrome version at time of writing) — so attaching to an already-running browser and getting native extension-devtools support are mutually exclusive right now. This skill's approach (attach via `--browserUrl`, treat the extension as just another loaded thing in the page) is the one that actually works today.

## When NOT to use this

- Screenshotting/recording a **native macOS app** (not a web page) — use the `screen-capture` skill (peekaboo-based) instead.
- Finding a click target inside **browser chrome** (tabs, bookmarks, extension icons in the toolbar) rather than page content — peekaboo's `see --annotate` actually works there; no need for the grid trick.
- Anything that isn't this specific repo's YouTube extension — only the `extension devtools launch` step is hardwired to `buildExtension()` from `src/youtube/commands/extension.ts`. For another project's already-built extension use `tools chrome-devtools open --extension <dist>`; for a different pattern entirely, reuse `src/chrome-devtools/lib/launch.ts` and `src/chrome-devtools/lib/mcp.ts` rather than copying them.
