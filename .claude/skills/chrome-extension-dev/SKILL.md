---
name: chrome-extension-dev
description: Drive a real, extension-loaded Chrome/Brave browser for the GenesisTools YouTube extension over our own CDP client (tools chrome-devtools snapshot, click, fill, eval, nav, shot) — no MCP server, no Claude Code config edits, no restart. Use whenever the user wants to test, debug, screenshot, or click through the YouTube extension's UI (side panel tabs, popup, content script), asks to "load the extension and click X", wants a screenshot of the extension mid-interaction, or needs to find exact pixel coordinates to click something inside a web page (not a native macOS app — for that, use the screen-capture skill instead). Also use this whenever chrome-devtools-mcp's own tools fail with "no browser" or launch a blank vanilla browser with no extension loaded.
---

# chrome-extension-dev

Repo-local (this skill lives in `.claude/skills/`, not the portable `~/.agents/skills/`). It carries no scripts of its own: every mechanic it describes is a real module in this repo's shipped source tree, and this file points at them.

## The problem this solves

Claude Code's MCP servers (like `chrome-devtools-mcp`) spawn once at session start with a fixed argv read from `~/.claude.json`. None of them can be pointed at a different browser, or at a browser with an extension loaded, without a config edit and a session restart. This repo no longer drives a browser through chrome-devtools-mcp at all: `tools chrome-devtools` talks CDP directly to any port, so a browser launched a minute ago is one `--port` away.

Separately: peekaboo's AX-tree tools (`see`, `find`) are near-useless on **web page content** — Chromium doesn't expose its web accessibility tree to them in the tested build. The page agent below reads the page from the inside instead, and the labeled coordinate grid covers the rare case where a pixel is still needed.

## Quick start (the YouTube extension)

```bash
cd /path/to/GenesisTools   # or a worktree of it

# 1. Build the extension and launch Brave/Chrome with it loaded + a CDP port open
bun --bun src/youtube/index.ts extension devtools launch
# → prints: Chrome up (pid NNNN), CDP endpoint: http://127.0.0.1:9333

# 2. Read the page the way a person sees it: controls (role, label, value), with --text the visible text.
#    The extension's side panel lives in an open shadow root, and the read includes it.
bun src/chrome-devtools/index.ts snapshot --port 9333 --match youtube.com

# 3. Act by label: a guard and a hit test run right before a real mouse click
bun src/chrome-devtools/index.ts click "Summarize" --port 9333 --match youtube.com
bun src/chrome-devtools/index.ts fill "Ask a question" "what is new" --port 9333 --match youtube.com
bun src/chrome-devtools/index.ts scroll down --port 9333 --match youtube.com

# 4. Everything else a DevTools session gives you
bun src/chrome-devtools/index.ts nav "https://www.youtube.com/watch?v=VIDEO_ID" --port 9333 --match youtube.com
bun src/chrome-devtools/index.ts eval "() => document.title" --port 9333 --match youtube.com
bun src/chrome-devtools/index.ts console --reload --port 9333 --match youtube.com
bun src/chrome-devtools/index.ts shot /tmp/yt.png --port 9333 --match youtube.com

# 5. Screenshot + labeled coordinate grid, when a pixel really is needed
bun --bun src/youtube/index.ts extension devtools get-frame-grid /tmp/grid.png --step 60
```

**Use the `bun src/<tool>/index.ts ...` form, not `tools <tool> ...`, from a worktree.** The `tools` shim resolves to the *main* GenesisTools checkout regardless of which worktree you're actually in. Invoking the entrypoint directly always uses the code you're standing in.

**Labels, not ids.** `click` and `fill` find the control by its label in a fresh read. Two controls with the same label refuse and list both; pick one with `--nth 2` or narrow with `--role button`. Node ids are not accepted: each command is a new process, and ids belong to one read's isolated world.

**Kill the browser when done**: the `launch` output prints a `kill <pid>` command. A stale extension-loaded Chrome from a previous session's temp profile has caused real confusion before (macOS Dock/app-activation can route clicks to the wrong instance when two Brave profiles are alive at once) — clean up rather than accumulate them.

`extension devtools list-tools` and `call` are gone (they spawned chrome-devtools-mcp); calling them prints the CDP verbs above. A real MCP tool is still one explicit call away when you need something the verbs lack: `tools chrome-devtools mcp <tool> '<json>' --port 9333`.

## Any browser, no extension: `tools chrome-devtools`

The same verbs work on any browser that was started with a debugging port:

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
- **The page agent — `src/chrome-devtools/lib/dom/`.** `in-page.ts` is ONE script run in an isolated world (page scripts can neither read nor replace it); it reads controls in the document and in every open shadow root, and re-checks a target (guard hash, enabled, shown, `elementFromPoint` through shadow roots) right before input. `page.ts` (`DomPage`) sends real `Input.*` events and waits on a mutation observer instead of a timer. `find.ts` matches a label to a row. The verbs are `src/chrome-devtools/commands/page.ts`.
- **Main-world scripting by tab id — `src/chrome-devtools/lib/tab-driver.ts`.** Evaluate in the page's own world, navigate and open with a load wait, and wait for a request with its headers. Spotify's player driver uses it.
- **The labeled coordinate grid — `src/chrome-devtools/lib/frame-grid.ts`.** `captureFrameGrid()` screenshots over raw CDP, optionally crops to a region via `magick`, then overlays a red grid. Every label sits on a solid black backing chip: a bare-text label was confirmed illegible against busy page content — don't regress that. Labels show the *real* page pixel coordinate, region-offset-corrected when cropped.
- **The YouTube-extension wrapper — `src/youtube/lib/devtools/browser.ts`.** The only extension-specific part: build via `buildExtension({ devReload: true })`, verify the build is complete, then delegate the launch to `launchCdpBrowser`. Its endpoint default (`$YOUTUBE_EXTENSION_CDP_URL`, else port 9333) is `devtoolsCdpUrl()` in the same file.
- **The CLI wrappers** are thin commander plumbing over those modules: `src/youtube/commands/extension.ts` for `extension devtools <launch|get-frame-grid>`, `src/chrome-devtools/commands/browse.ts` for `open|restart|targets`, `commands/inspect.ts` for `eval|nav|shot|console`, `commands/page.ts` for `snapshot|click|fill|scroll`.

## Gotchas already paid for

- **`stdio: ["ignore","ignore","ignore"]` makes Chrome silently stall before opening the CDP port** — confirmed live, repeatedly: the browser process starts, spawns exactly a GPU helper process and nothing else, and never progresses further. Piping stdout/stderr to a real file (not `/dev/null`, not fully ignored) fixes it. This is why `launchCdpBrowser({ logPath })` spawns the browser binary itself rather than going through `open -na`, which cannot own the app's stdio. `defaultSpawnLogged` in `src/chrome-devtools/lib/launch.ts` carries the comment — don't "simplify" it back to `ignore`.
- **A cold profile needs 30s, not 20s.** First run on a new `--user-data-dir` parses the cert store and validates every loaded extension. `launchCdpBrowser` picks `COLD_PROFILE_TIMEOUT_MS` automatically whenever the launch makes its own profile (`--fresh`, `--extension`, or an explicit `userDataDir`).
- **Zombie test-instance processes squat the CDP port.** Every failed/orphaned `launch` leaves a full Chrome process tree (main + gpu + renderer + network + storage + audio/video-capture helpers) alive under its own temp `--user-data-dir`. If port 9333 is already bound by a zombie, a new launch silently never opens a *second* listener on it and just hangs — looks identical to a real launch failure. Check first: `ps aux | rg "remote-debugging-port=9333"` and `pkill -9 -f "genesis-yt-devtools-chrome"` before re-launching if something looks stuck. `tools chrome-devtools attach` also lists every live endpoint.
- **A broken extension build fails with a blocking GUI dialog you'll never see if you're only polling the CDP port.** "Failed to load extension from: ... Could not load javascript 'content-script.js'" is a real macOS alert that requires a click to dismiss — until dismissed, Chrome doesn't finish starting, which looks exactly like a hung CDP port from the outside. The post-build file-existence check in `src/youtube/lib/devtools/browser.ts` exists specifically to catch this *before* Chrome ever launches, rather than after a 30s timeout.
- **A closed shadow root stays invisible.** The page agent reads open shadow roots only, exactly like the page's own scripts. The extension's side panel uses an open one (`content-script.ts`); if a future change makes it closed, `snapshot` stops listing its controls and `eval` cannot reach them either.

## When NOT to use this

- Screenshotting/recording a **native macOS app** (not a web page) — use the `screen-capture` skill (peekaboo-based) instead.
- Finding a click target inside **browser chrome** (tabs, bookmarks, extension icons in the toolbar) rather than page content — peekaboo's `see --annotate` actually works there; the page agent reads only the page.
- Anything that isn't this specific repo's YouTube extension — only the `extension devtools launch` step is hardwired to `buildExtension()` from `src/youtube/commands/extension.ts`. For another project's already-built extension use `tools chrome-devtools open --extension <dist>`; for a different pattern entirely, reuse `src/chrome-devtools/lib/launch.ts`, `lib/dom/` and `lib/tab-driver.ts` rather than copying them.
