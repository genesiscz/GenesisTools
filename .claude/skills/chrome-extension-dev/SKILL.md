---
name: chrome-extension-dev
description: Drive a real, extension-loaded Chrome/Brave browser for the GenesisTools YouTube extension via chrome-devtools-mcp as a standalone MCP client — no Claude Code config edits, no restart. Use whenever the user wants to test, debug, screenshot, or click through the YouTube extension's UI (side panel tabs, popup, content script), asks to "load the extension and click X", wants a screenshot of the extension mid-interaction, or needs to find exact pixel coordinates to click something inside a web page (not a native macOS app — for that, use the screen-capture skill instead). Also use this whenever chrome-devtools-mcp's own tools are attempted and fail with "no browser" or launch a blank vanilla browser with no extension loaded — that means the server wasn't wired to a real browser, and this skill is the fix.
---

# chrome-extension-dev

Repo-local (this skill lives in `.claude/skills/`, not the portable `~/.agents/skills/` — its scripts import this repo's own `@app/*` aliases and build the YouTube extension via this repo's own build pipeline, so it only makes sense inside GenesisTools).

## The problem this solves

Claude Code's MCP servers (like `chrome-devtools-mcp`) spawn once at session start with a fixed argv read from `~/.claude.json`. There is no tool call that redirects an already-running MCP server to a different browser, adds `--browserUrl`, or loads an extension — that requires editing the config and **restarting the whole Claude Code session**, which is disruptive mid-task.

Separately: peekaboo's AX-tree tools (`see`, `find`) are near-useless on **web page content** — Chromium doesn't expose its web accessibility tree to them in the tested build. They only see browser chrome (tabs, bookmarks), never the page itself. So finding a click target inside a web page by AX inspection doesn't work; pixel coordinates are the only reliable path in.

This skill fixes both: it spawns `chrome-devtools-mcp` **directly, as its own MCP client**, with whatever argv it needs (a real `--browserUrl`) — bypassing Claude Code's server config entirely — and it bakes a labeled coordinate grid onto screenshots so pixel targets can be read off an image instead of guessed and iterated.

## Quick start

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

## How it's built (scripts/)

- **`devtools-mcp-client.ts`** — `connectDevtoolsClient()` / `withDevtoolsClient()`. Spawns `chrome-devtools-mcp` via `StdioClientTransport` from `@modelcontextprotocol/sdk` with `--browserUrl <cdpUrl>` (default `http://127.0.0.1:9333`, override via `CDP_URL` env or `--cdp-url` flag). This is the whole trick — it's a normal MCP client/server pair, just spawned by us instead of by Claude Code's own launcher.
- **`devtools-browser.ts`** — `launchDevtoolsBrowser()`. Builds the extension (imports `buildExtension()` from the repo's own `commands/extension.ts` — always resolves to the exact `dist/` path that function itself writes to, never a separately-guessed path), verifies `manifest.json` + `background.js` + `content-script.js` + `popup/popup.html` all actually exist (a broken/partial build produces a *silent* Chrome extension-load-failure dialog that blocks CDP from ever coming up — verified this failure mode live), then launches Chrome/Brave with `--load-extension`, `--disable-extensions-except`, and `--remote-debugging-port` against a fresh temp `--user-data-dir`.
- **`devtools-frame-grid.ts`** — `captureFrameGrid()`. Calls the `take_screenshot` tool (saves straight to a file path, no base64 round-trip), optionally crops to a region via `magick`, then overlays a red grid with a solid black backing chip behind each label (a bare-text label with no backing was confirmed illegible against busy page content — don't regress that) — vertical labels along the top, horizontal along the left, both showing the *real* page pixel coordinate (region-offset-corrected if cropped).

The CLI wrapper (`tools youtube extension devtools <launch|list-tools|call|get-frame-grid>`) lives in the main repo's `src/youtube/commands/extension.ts` — thin commander plumbing calling into these three scripts. Keep logic here, keep the command file thin, same convention as the rest of this repo.

## Gotchas already paid for

- **`stdio: ["ignore","ignore","ignore"]` makes Chrome silently stall before opening the CDP port** — confirmed live, repeatedly: the browser process starts, spawns exactly a GPU helper process and nothing else, and never progresses further. Piping stdout/stderr to a real file (not `/dev/null`, not fully ignored) fixes it. `devtools-browser.ts` already does this — don't "simplify" it back to `ignore`.
- **Zombie test-instance processes squat the CDP port.** Every failed/orphaned `launch` leaves a full Chrome process tree (main + gpu + renderer + network + storage + audio/video-capture helpers) alive under its own temp `--user-data-dir`. If port 9333 is already bound by a zombie, a new launch silently never opens a *second* listener on it and just hangs — looks identical to a real launch failure. Check first: `ps aux | rg "remote-debugging-port=9333"` and `pkill -9 -f "genesis-yt-devtools-chrome"` before re-launching if something looks stuck.
- **A broken extension build fails with a blocking GUI dialog you'll never see if you're only polling the CDP port.** "Failed to load extension from: ... Could not load javascript 'content-script.js'" is a real macOS alert that requires a click to dismiss — until dismissed, Chrome doesn't finish starting, which looks exactly like a hung CDP port from the outside. `devtools-browser.ts`'s post-build file-existence check exists specifically to catch this *before* Chrome ever launches, rather than after a 30s timeout.
- **`chrome-devtools-mcp`'s own flags (`--browserUrl`, `--chromeArg`, `--categoryExtensions`, etc.) are process-startup-only** — there is no tool call, no runtime option, no "navigate the server itself" mechanism. If you ever consider reconfiguring the *actual* `chrome-devtools-mcp` MCP server Claude Code has wired up instead of using this skill's standalone client, know going in that it requires an edit to `~/.claude.json` and a full session restart — not something to do without asking the user first.
- **`--categoryExtensions` (chrome-devtools-mcp's own native extension-debugging support) is currently incompatible with `--browserUrl`/`--wsEndpoint`/`--autoConnect`** (gated behind a future Chrome version at time of writing) — so attaching to an already-running browser and getting native extension-devtools support are mutually exclusive right now. This skill's approach (attach via `--browserUrl`, treat the extension as just another loaded thing in the page) is the one that actually works today.

## When NOT to use this

- Screenshotting/recording a **native macOS app** (not a web page) — use the `screen-capture` skill (peekaboo-based) instead.
- Finding a click target inside **browser chrome** (tabs, bookmarks, extension icons in the toolbar) rather than page content — peekaboo's `see --annotate` actually works there; no need for the grid trick.
- Anything that isn't this specific repo's YouTube extension — this skill's `launch` step is hardwired to `buildExtension()` from `src/youtube/commands/extension.ts`. For a different project's browser automation, adapt the pattern (an MCP client spawned with the right `--browserUrl`/`--chromeArg`) rather than reusing these exact scripts.
