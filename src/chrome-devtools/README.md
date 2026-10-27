# chrome-devtools

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)

> **Drive a REAL running browser (Brave/Chrome) over the Chrome DevTools Protocol.**

The debugging harness for bugs that only exist in the user's own browser: auth/SSO redirect
loops, cookie/session poison, "works in incognito but not for me", stuck SPAs, CORS errors.
Ported from the `~/.agents/skills/chrome-devtools` skill after the 2026-08-25 CPU-leak
incident (full forensics in the plugin skill's `references/arm-cpu-leak.md`).

---

## Non-negotiable first fact

`--remote-debugging-port` is parsed at browser **STARTUP**. It cannot be enabled on a
running browser. Any plan that assumes "just attach to their open Brave" is wrong until the
browser is relaunched with the flag. `attach` prints the exact commands when nothing
listens. **Ask before quitting anyone's browser** — their open tabs are at stake.

⚠️ Chrome ≥ 136 refuses to open the CDP port when launched with the DEFAULT profile
directory (anti-automation). Chromium builds are unaffected; Brave's stance can differ per
version. `restart` detects the failure and suggests two fallbacks: `open --fresh` (throwaway
profile) and `open --user-data-dir <dir>` (a persistent separate profile whose logins survive
between runs, one directory per browser, e.g. `~/.genesis-tools/chrome-devtools/chrome/profile`).
Only the throwaway `--fresh` and `--extension` profiles get
`--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks`; a persistent profile
holds credentials, so it keeps Chrome's network protections like the real profile does. Every
launch adds `MacAppCodeSignClone` to that one flag (Chrome reads only the last one): without it,
branded Chrome on macOS copies its 1.4 GB app into the temp folder per launch and leaves the copy
when it does not exit cleanly.

On macOS, when an idle display can be selected, a separate profile (`open --fresh`, `--extension`,
`--user-data-dir`, the recording browser) starts with `--no-startup-window`. Its first window is
opened over CDP with `Target.createTarget({ background: true })`, which Chrome shows inactive,
on a display that does not hold the frontmost app's window (`src/utils/chrome-devtools/window-placement.ts`).
The `open` command uses Launch Services with `open -g` to avoid bringing the app forward. The
recording browser spawns the executable directly to capture its log and own its process; it
does not use `open -g`, so its focus protection comes from suppressing the startup window and
creating the first window inactive over CDP. If inactive creation fails, a normal window is
tried; failure of both creation paths fails the launch. With one display, off macOS, or when
the display probe fails, launches keep their normal startup window and URL on argv. The real
profile (plain `open`, `restart`) also launches as before, because `--no-startup-window` skips
its session restore.

To let one public page reach a private or loopback address in a protected profile, hold a grant with
`tools chrome-devtools grant --match <tab>` (default `local-network loopback-network`, for the tab's own
origin; `--origin` and `--seconds` change that). `follow` marks a request this blocks: its FAIL line ends
with `blocked by Local Network Access (LocalNetworkAccessPermissionDenied)` and the grant command. The
mechanism, measured on Chrome 154: `Browser.setPermission` with the descriptor name
`local-network` (private addresses) or `loopback-network` (127.0.0.1, localhost), or
`Browser.grantPermissions` with `localNetwork` / `loopbackNetwork`. The old `local-network-access` is
accepted but unblocks nothing since Chrome 145, the grant needs an HTTPS origin, and it ends when the CDP
session that made it detaches. With the checks disabled, an HTTPS page still cannot call an HTTP private
address (mixed content); a grant can.

## Quick start

```bash
tools chrome-devtools attach            # scan, list endpoints, start the recorder, print next steps
tools chrome-devtools har --last 30m -o /tmp/cdp.har    # what happened in the last 30 minutes
tools chrome-devtools follow --channels nav,redirect,error --match idp.example.com
tools chrome-devtools status            # who records what, at what CPU cost
```

`/tmp/...` output paths in the examples are the POSIX default; on Windows the tool
writes under `%TEMP%` instead, and every command it PRINTS (attach guidance, doctor
fixes, `--help` examples) already carries the right path for the running platform.

## The mental model: one engine, two views, plus a log it does not own

| Piece | What it is |
|---|---|
| `record` | The only capture engine. One detached process per port, attaches browser-wide (or `--match`-scoped), appends HAR-grade metadata to a rolling buffer. `attach` starts it automatically. |
| `follow` | The live view. Renders chosen channels as human lines, prints Monitor-ready commands. Rotation-aware — the only sanctioned way to tail the buffer. `--loops [n]` adds a `LOOP` line when one page (path + query names) is visited n times within `--loop-window` seconds, with the cycle of pages between visits. |
| `har` | The retroactive view. Builds a DevTools-grade HAR 1.2 from the buffer (`--last 30m`), or records a live window on one tab (`--now --reload`, with bodies). |

The old skill's `watch` verb is gone; invoking it explains the split.

### The third network log: `net-panel`

A request lives in whichever log was already collecting when it happened, and nothing
backfills. The recorder buffer and the MCP attach log are both *ours*; the third belongs to
the user's own open Network tab and neither of the other two can reach it.

| Log | Verb | Covers | Blind to |
|---|---|---|---|
| Recorder buffer | `har --last 30m` | since **this tool's** recorder started, all tabs, rolling 4 h | anything before `attach` ran |
| MCP attach log | `mcp <tool>` / `list_network_requests` | since **that MCP session** attached, in its own browser | the user's browser; anything before its attach |
| Panel `NetworkLog` | `net-panel` | what the user's **own open Network tab** is showing, back to when they opened it with Preserve log | anything with DevTools closed; headers and bodies (never collected) |

The symptom that names the third one: their Network tab lists hundreds of rows while the MCP
list returns empty, or `har` dumps only the last minute. Observed live at **631** rows.

```bash
tools chrome-devtools net-panel --match app.example.com            # histograms + document hops
tools chrome-devtools net-panel --match app.example.com -o /tmp/panel.har
```

`--match` names the **inspected tab**, or the inspector itself (`--match 'DevTools - <host><path>'`).
Every open inspector reports the same `devtools://` url, so the window **title** is the only
discriminator; an ambiguous match refuses and lists the candidates with a `--match` that names
one, rather than reading a different tab's log. Read-only: one `Runtime.evaluate` against the
frontend, no reload, no navigate, no `Network.enable`. Summary urls are cut to origin+pathname,
and the `-o` HAR carries no headers, cookies or POST bodies by construction — the eval never
collects them.

### `restart`, end to end

`restart` quits the app, waits for the process to really be gone, then relaunches with the
flag. Three behaviours worth knowing:

- **A slow quit is not a failed quit.** A `beforeunload` handler makes the browser ask the
  user before closing, which can hold it for tens of seconds. The verb polls for real exit for
  45 s and says why it is waiting; only past that does it mention `--force` (`kill -KILL`,
  which costs session restore). If it is still waiting, answer the prompt in the browser.
- **No profile picker.** `profile.last_used` is read from the browser's own `Local State` and
  passed as `--profile-directory`, so a multi-profile browser does not stop at "Who's using …?".
  Override with `--profile-directory 'Profile 1'`. A name that is not on disk is refused, since
  the browser would silently create a new empty profile.
- **It verifies its own end state.** Every run prints CDP reachability, the page-target count
  and picker status. A picker still open, or a tab list that did not answer, exits non-zero —
  an unverified restart is not a successful one.

`targets` lists that same page-target count on demand — one line per tab (id, title, url),
`--match <substr|/regex/>` to narrow it, `--all` to include workers/iframes/extension pages,
`--json` for the raw `/json/list` entries. Useful on its own to find a tab id before `attach`.

### `close`, the way back from `open`

`close --port <n>` quits the browser on that port through `Browser.close` and waits up to
10 s for its process to exit. It never kills. On macOS, Chrome and Brave copy their app bundle
for every launch (`/var/folders/<user>/X/<bundle id>.code_sign_clone/`, about 1.4 GB) and delete
the copy only on a clean quit, so a `kill <pid>` leaks 1.4 GB each time. It refuses:

- a browser on the user's own profile (no `--user-data-dir`), unless `--main-profile`;
- a port two processes listen on (one on 127.0.0.1, one on [::1]), since CDP reaches only one;
- a listener that is not a browser (judged by its executable alone, not its arguments), and an
  empty port.

`open` prints the matching `close` line after it starts a browser. The library side is
`closeBrowserOnPort` in `lib/launch.ts`; a browser this process spawned itself goes through
`quitOwnedBrowser`, which sends `Browser.close` only when that browser is the one process
listening on the port. It kills the browser in three cases: another process also listens on the
port, the browser does not answer CDP, or `Browser.close` did not end it within 3 s.

### The buffer

`/tmp/GenesisTools/ChromeDevtools/<port>/` — 30-minute jsonl segments, pruned past 4 h at
rotation (one inline unlink, no timer process), ~500 MB/port safety cap. Segments are
**internal**: never `tail -f` them (rotation silently breaks the fd). `/tmp` clears on
reboot. On Windows the root is `%TEMP%\GenesisTools\ChromeDevtools` instead.

### Platform support

darwin, linux and win32, factored through `lib/platform.ts` (injectable primitives with
per-platform parser tests). POSIX shares `ps`/`lsof`/`pgrep`; Windows uses PowerShell CIM,
`netstat -ano` and `tasklist`/`taskkill`. Browser launch: `open -na` on macOS, the browser
binary on PATH on Linux, known install paths on Windows. `restart` quits gracefully
everywhere (osascript / `pkill -TERM` / `taskkill` without `/F`) so session restore keeps
the tabs. Windows caveats: `status` shows cpu-time but no instantaneous %CPU, and the
frame-grid verb still needs ImageMagick on PATH. macOS and Linux are exercised end to end;
Windows support is parser-tested but not yet run against a live Windows browser.

### Recorder lifecycle (the incident, encoded)

- Pid-recycling-safe pidfiles (`@genesiscz/utils/process/pidfile`) claimed **before** the
  child connects — concurrent `attach` from many agent sessions yields exactly one recorder
  per port.
- High-rate packets are never `JSON.parse`d: websocket frames are dropped pre-parse
  (unless the `ws` channel is on) and `Network.dataReceived` goes through a regex fast path
  that aggregates byte counts in memory and emits one synthetic summary event per request.
- One open fd per segment, `writeSync` per event. Never `appendFileSync`.
- Dies when CDP dies: `/json/version` probe every 2 s, 3 failures = exit. Also exits on
  websocket close, SIGTERM, `record --stop`, `--seconds`, and a hard 24 h lifetime cap.

### Capture channels (`record --channels`)

`net` (always on — the HAR diet) · `console` (default) · `+ws` frames · `+body` (≤2 KB,
active fetch) · `+storage` (snapshot per navigation). Render channels on `follow` are free:
`nav doc redirect xhr ws console error cookie body storage`.

## HAR pipeline

`lib/har/` is a **TypeScript port of chrome-har v1.3.1** (sitespeedio/chrome-har, MIT) —
the converter browsertime/puppeteer-har/playwright-har all wrap — with four documented
deviations (see `lib/har/build.ts` header), the important one being sessionId-aware entry
keying so multi-tab captures cannot corrupt each other. Parity is pinned by
`lib/har/build.parity.test.ts` against goldens generated from the upstream package over its
own real-Chrome perflogs (upstream clone: `../_Playgrounds/chrome-har`). There is no
chrome-har npm dependency; `tough-cookie` remains for Set-Cookie parsing fidelity.

Research that led here (no native CDP/MCP/Playwright export exists for an attached user
browser): `.claude/work/research/2026-08-26-CdpNativeHarExport.md`.

## Ops

- `status` — recorders with live CPU/mem/cpu-time samples, buffer sizes, endpoints,
  orphan recorder-shaped processes, legacy `/tmp/cdp-arm-*` leftovers. `--detailed`,
  `--format json`.
- `doctor` — read-only diagnosis; prints one fix command per finding. Never mutates.
- `cleanup` — the mutating counterpart. TTY: guided multi-select. Non-TTY: explicit flags
  (`--kill <pid>`, `--stale <port>`, `--legacy [port…]`, `--dir <port>`). Kill safety is
  three-layered: the pid must still be recorder-shaped (pid recycling), must not BE a live
  pidfile-owned recorder (use `record --stop`), and must not be a launcher ANCESTOR of one
  (the launch chain carries the same argv — a field test caught doctor suggesting exactly
  that kill before this guard existed). Kills are never batched: `--yes` applies only the
  safe fixes. Files are MOVED to a /tmp trash dir, never destroyed in place.
- `resume [--match X] [--workers] [--debugger] [--timeout-ms 5000]` — releases tabs a debugger
  client left held. Browser-level `Target.setAutoAttach` makes Chrome hold every `window.open()`
  popup until `Runtime.runIfWaitingForDebugger`; the popup stays blank and its opener shows
  "Debugger paused in another tab", even after that client is gone. One line per target
  (`released`, `ok`, `debugger-resumed`, `timeout <step>`, `error <msg>`), `--json` for records,
  exit 1 when a target timed out. Sends only resume commands (no evaluate, no Network/Page, no new
  tabs), so it is safe on a browser with a live session. `doctor` lists blank pages with an opener
  as "possibly held popup" and suggests it.

## Performance and app state

Measured with in-page observers installed before the page's own scripts (long-animation-frame with
script attribution, longtask, layout-shift sources, event timing, a lag sampler, marks), not with a
DevTools trace: a trace at 6x CPU distorts what it measures. The logic lives in
`@genesiscz/utils/chrome-devtools/` (every helper takes a `CdpLike` session, so another project can
vendor it and drive it with a playwright `CDPSession`); the verbs here are thin.

| Verb | What it does |
|---|---|
| `perf load [url]` | Load N times (`--cpu`, `--network`, `--mark name=sel[@text]`, `--until`); blocking by invoker, worst frames with script position, CLS, lag, marks, p50/p90 |
| `perf record` | Observe the current document while a person interacts: INP, slowest events |
| `perf ab <spec.json>` | Interleaved A/B (ABBA), per-variant response rewrites, storage reset before each load, samples saved after every run |
| `emulate` / `intercept` | Hold a CPU/network override, or rewrite/replace/block responses, until Ctrl-C (overrides end with the CDP session); `intercept --map-dir <dir>` attaches carried source maps so DevTools shows real sources |
| `storage idb` / `storage web` | IndexedDB (read-only, never creates a database) and Web Storage; `--from-profile` reads a browser that has no debug port |
| `react find` | Structured matchers over every React root; `--expose` keeps the live object on `window` |
| `nav --spa` | `pushState` + `popstate`, no reload |

The step from a worst frame's `chunk.js:offset` to a source line is `tools ts sourcemaps resolve`
(src/ts/README.md; the full guide with every strategy, cost and measured hit rate is the plugin skill's
`references/sourcemaps.md`). The plugin skill's `references/perf-investigation.md` is the playbook.
`perf load` brings the tab to the front first and every summary warns when the page was hidden,
because a background tab throttles timers and skips frames.

## Scripting

- `scaffold <name> --recipe <r>` creates a CDP scratch script **in the `tools scripts`
  store** (versioned, `tools scripts run <name>`). Recipes: `redirect-chain`,
  `cookie-diff`, `storage-snapshot`, `body-fetch`, `console-trap`, `blank`, and the perf
  recipes `perf-load`, `perf-ab`, `spa-steps`, `interaction`, `idb-dump`. The store's
  tsconfig maps `@gt/chrome-devtools/*` to this tool's `lib/` and `@gt/utils/*` to `src/utils/`.
- `cheatsheet` prints the CDP scripting cheatsheet (also in the plugin skill's references).
- `mcp [tool] [json]` calls the real chrome-devtools-mcp tools against any port, no session
  config edit. It is an explicit pass-through: no other tool in this repo drives a browser through
  chrome-devtools-mcp any more (jev, spotify and the youtube extension harness use `lib/dom/` and
  `lib/tab-driver.ts`).

## Page agent (`lib/dom/`) and tabs (`lib/tabs.ts`)

`DomPage.attach({ port, target })` drives one page over this tool's own CDP client, with no
chrome-devtools-mcp. Every read is ONE `Runtime.evaluate` of `installPageAgent` (`lib/dom/in-page.ts`)
in an isolated world, so page scripts can neither read nor replace it. A read returns the
interactive elements in the viewport (page-scoped node ids that survive across reads, accessible
names, one row per `<option>`), the visible text (capped), scroll room and a change marker.
Password, one-time-code and payment fields are marked secret and their values are never read. A
read also names every shown secret field in the document (`secretFields`), below the fold and past
the action cap included, so a caller knows a page wants a secret before it presses anything.

Before any input the agent re-checks the target: still attached, same guard hash (identity, name,
value, state, and the text of its nearest row, form or dialog), enabled, shown, and the element
under its centre point (`elementFromPoint`). Input is real `Input.dispatch*` events or
`Input.insertText`, and a fill is read back inside the page. A select runs the same checks, then
checks the option itself by its label and its disabled flag. Every CDP call, input and navigation
sends included, has a 5 s deadline; an input whose send runs out is reported as
`dispatch_uncertain` and never repeated. The wait after an act is event driven:
a mutation observer resolves it once the page changed and stayed quiet for 50 ms, or at 300 ms.
Focus emulation lets it work in a tab the user is not looking at.

The agent reads every OPEN shadow root too (web components, and extension panels such as the youtube
extension's side panel): candidates, visible text, `aria-labelledby` ids scoped to their root, the hit
test (descending through `shadowRoot.elementFromPoint`, with containment that crosses shadow
boundaries) and the settle observers. A closed shadow root stays invisible, as it is to the page.

CLI: `snapshot`, `click "<label>"`, `fill "<label>" "<text>"` and `scroll [down|up]`. They find the
control by its label in a fresh read (`lib/dom/find.ts`: exact before substring, an option row by
its option). Node ids are not accepted on the command line: ids and guards belong to one isolated
world, and each command is a new process with a new one. Several matches refuse and list them;
`--nth` picks one.

`lib/tab-driver.ts`: the page's MAIN world by tab id, for code that needs the page's own globals
(spotify's player). `evaluate` with a deadline, `navigate` and `open` that wait for the load
event, and `waitForRequest` over `Network.requestWillBeSent` (headers lower-cased; `cause` reloads or
navigates once it listens). A closed tab raises `TabGoneError`.

`lib/tabs.ts`: `listTabs`, `currentTab({ port, title })`, `activateTab`, `closeTab`, `tabTarget`.
CDP has no "active tab" call, so `currentTab` matches the window title and otherwise takes the most
recently active page (`/json/list` order).

`bun src/chrome-devtools/scripts/dom-guards.ts` checks all of it against a HEADLESS Chrome on a
throwaway profile and a loopback fixture (no model, no network). Measured 2026-09-28: a
2000-link page reads in 11.8 ms median over 10 reads; a click that changes nothing settles at the
300 ms cap; `back` from a back-forward-cache page returns in 5 to 11 ms.

## Do not

- Do not pipe `record`, `follow`, or `trace` to `head`/`tail` — they are long-running and
  print pid + paths first.
- Do not `tail -f` segment files — use `follow`.
- Do not `pkill -f chrome-devtools` — that can hit MCP servers and the CLI you are typing.
  `status` shows pids; `cleanup --kill` verifies before killing.
- Do not `kill` a browser that `open` started — it leaks a 1.4 GB app copy on macOS. Use `close`.
- Do not `cat`/`jq` a `.har` — `tools har-analyzer load` it.
- A HAR of a login flow contains the plaintext password and live session tokens. `--sanitize`
  before it leaves the machine.
- Do not "clear site data" to fix a cookie/session poison — it destroys the evidence and the
  user's logins along with it. `rm-cookie --name <n> --domain <d>` deletes the one cookie that
  is actually wrong.

## Benchmark

The `attach` auto-record default was validated on the real browser before shipping; numbers
live in a dated section of the tool's design notes, which are not published. Re-measure with
interleaved runs (≥5 per arm) if the recorder ever looks hot in `status`.
