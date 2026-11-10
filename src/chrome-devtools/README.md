# tools chrome-devtools

Drive a real, running Chrome, Brave or other Chromium browser over the Chrome DevTools Protocol (CDP), for the bugs
that exist only in the user's own browser: auth and SSO redirect loops, cookie or session poison, "works in incognito
but not for me", stuck single-page apps, CORS and Local Network Access blocks. It also measures front-end performance,
reads app state (IndexedDB, Web Storage, React, Redux, TanStack Query) and clicks or fills a page by label, all without
chrome-devtools-mcp.

## Quick start

```bash
tools chrome-devtools attach                          # find every CDP endpoint, start the recorder, print next steps
tools chrome-devtools har --last 30m -o /tmp/cdp.har  # what happened in the last 30 minutes, as a HAR
tools chrome-devtools follow --channels nav,redirect,error --match idp.example.com   # live view
tools chrome-devtools cookies --domain example.com    # every cookie, httpOnly ones included
tools chrome-devtools snapshot --match app.example.com   # the tab's controls, as a person sees them
tools chrome-devtools status                          # who records what, at what CPU cost
```

A browser reads `--remote-debugging-port` only at startup. When `attach` finds no endpoint, the commands that
relaunch it or start one beside it are in [Connect and launch](#connect-and-launch).

## Commands

Every command has `--help`, and a wrong call prints the right one. The groups below follow the jobs: connect, capture
the network, inspect and drive a tab, measure, read app state, keep the tool healthy, and script beyond the verbs.

### Picking the port and the tab

- `attach` scans ports 9222 to 9230, plus every port a Chromium browser listens on (`lsof`) and every
  `DevToolsActivePort` file. With two or more Chromium browsers open and no `--port`, it exits 1 and lists each app
  with its restart command.
- An `attach` that settles on one endpoint writes its port to `last-port` under the capture root. Every verb that picks
  a tab or reads the browser (`har`, `net-panel`, `targets`, `trace`, the commands under
  [Inspect and drive a tab](#inspect-and-drive-a-tab), `perf`, `storage`, `react`, `emulate`, `intercept`, `grant`,
  `mcp`) then resolves the port in this order when `--port` is not on the command line: the
  remembered port while it is live, the single live endpoint, the one endpoint with a tab that matches `--match`.
  Otherwise it exits 1 and names the live ports. Nothing is guessed. Their `--help` shows `(default: "9222")`, but
  that default is not used when you leave `--port` out.
- `record`, `follow`, `resume`, `open`, `close` and `restart` take `--port` literally, default 9222.
- `--match <substr|/regex/>` picks a tab by URL first and by title only when no URL matches. It exits 1 within a second
  when nothing matches (it lists the closest open tabs) or when several tabs match (it prints anchored regexes that
  separate them). It never grabs a random tab. With no `--match`, a page verb takes the first page in `/json/list`
  order, which is the most recently active tab. No tab to reuse? `nav <url> --new` opens one.

⚠️ **The title fallback can land on DevTools itself.** An open inspector's title is `DevTools - <host><path>`. When the
page you meant is gone or your pattern misses its URL, a pattern such as `/auth-callback\?cs=true$/` can match the
inspector by title, and `eval` runs against the DevTools frontend. The giveaway is an answer full of
`No throttling Fast 4G Slow 4G`, the Network panel's own DOM. Anchor on the scheme, which no DevTools title starts
with, so a miss fails loudly:

```bash
# can fall back to the inspector's title when the page is gone
tools chrome-devtools eval --match '/auth-callback\?cs=true$/' '() => location.href'

# can only ever match a page URL
tools chrome-devtools eval --match '/^https:\/\/app\.example\.com\/auth-callback\?cs=true$/' '() => location.href'
```

Two tabs where one URL is a prefix of the other (`/app?cs=true` and `/app?cs=true&debug=1`) cannot be told apart by a
substring. Only an anchored regex picks the shorter one.

### Connect and launch

The first fact, before any plan: `--remote-debugging-port` is read at browser **startup**. It cannot be turned on in
a running browser. A plan that says "just attach to their open Brave" is wrong until the browser is relaunched with
the flag. `attach` prints the exact commands when nothing listens. **Ask before you quit anyone's browser**: their
open tabs are at stake.

```bash
# reuse the real profile: quit, wait for the exit, relaunch with the flag (ask the user first)
tools chrome-devtools restart --browser brave --port 9222

# or a throwaway profile beside their browser: nothing of theirs is touched, but they log in again
tools chrome-devtools open --browser chrome --port 9223 --fresh https://app.example.com

# quit a browser that `open` started (never kill it)
tools chrome-devtools close --port 9223
```

| Command | What it does |
|---|---|
| `attach [--port <n>]` | Lists every CDP endpoint, starts the background recorder for each, prints the next commands |
| `open [url] --browser <id> --port <n>` | Launches a browser with the debug flag; on the real profile it refuses when that app already runs |
| `open --fresh` | A throwaway profile in a new directory every run |
| `open --user-data-dir <dir>` | A persistent separate profile: logins survive between runs |
| `open --extension <dist-dir>` | Loads an unpacked extension (implies its own profile) |
| `close [--port <n>] [--main-profile]` | Quits the browser on that port through `Browser.close`; never kills |
| `restart [url] --browser <id> [--profile-directory <dir>] [--force]` | Quits the app, waits until it is gone, relaunches with the flag |
| `targets [--match <p>] [--all] [--json]` | One line per tab (id, title, URL); `--all` adds workers, iframes and extension pages |

`--browser` takes `chrome-canary`, `chrome-beta`, `chrome-dev`, `chrome`, `brave-beta`, `brave-nightly`, `brave`,
`edge-canary`, `edge-dev`, `edge-beta`, `edge`, `chromium`, `arc`, `vivaldi`, `opera-gx`, `opera`, `dia` or `comet`.
For `open` the default is the browser already running (the same detection as `attach`), else the first one installed.
For `restart` the default is `chrome`, so name the browser.

`open` refuses only on the real profile: `--fresh`, `--user-data-dir` and `--extension` start beside a running copy of
the same app. It also exits 1 when `--fresh` and `--user-data-dir` are both given, when the browser is not installed,
and when the port does not answer in time (it prints `launched but no CDP on <port> yet` and the `attach` command to
run next).

`targets` prints the same page count `restart` checks. Use it to find a tab id, or with `--match` to filter the list
instead of reading one 40 KB JSON blob. `--json` prints the `/json/list` entries after `--all` and `--match`.

#### `restart`, end to end

- **A slow quit is not a failed quit.** A page with a `beforeunload` handler makes the browser ask the user before it
  closes, which can hold it for tens of seconds. `restart` polls for the real exit for 45 s and says why it waits. Only
  past that does it mention `--force` (`kill -KILL`), which costs the session restore that was the reason to choose a
  restart. If it still waits, answer the prompt in the browser.
- **No profile picker.** `restart` reads `profile.last_used` from the browser's own `Local State` and passes it as
  `--profile-directory`, so a multi-profile browser does not stop at "Who's using ...?" and no Accessibility grant is
  needed. Override it with `--profile-directory 'Profile 1'`. A name that is not on disk is refused, because the
  browser would silently create a new, empty, logged-out profile.
- **It verifies its own end state.** Every run ends with a block like this:

  ```
  up: Chrome/152.0.7000.10 on 9222 (3 pages)
  verify: port 9222 answers (Chrome/152.0.7000.10) · 3 page target(s)
  verify: no profile picker is open.
  ```

  `/json/version` answers `Chrome/<version>` for every Chromium browser, so for any other browser the `up:` line puts
  the app name first: `up: Brave Browser (Chrome/152.0.7000.10) on 9222 (3 pages)`. A picker that is still open
  (reported with a dismissal command), or a tab list that did not answer, exits non-zero. An unverified restart is not
  a successful one.
- **It waits for an update-on-quit (macOS).** A browser can install a staged update the moment it quits. On
  2026-11-02 a Brave restart relaunched in the same second the update replaced its framework folder, and the new
  process died about a second later. So after the quit, `restart` waits until the app bundle has not changed for 3 s
  and no updater of that vendor runs, for at most 60 s. It prints a line only when the bundle changed or the wait hit
  the cap; past the cap it relaunches anyway.
- **It checks the relaunch twice.** The end-state check runs again 3 s after the port first answers. When the port
  answered and then stopped, `restart` exits 1 and prints the newest crash report (or the folder macOS writes it to)
  and a relaunch command.
- The quit is graceful on every platform (`osascript quit` on macOS, `pkill -TERM` on Linux, `taskkill` without `/F`
  on Windows), so session restore keeps the tabs. Do not use `osascript quit` plus `open -a` by hand: `open -a` reuses
  the live process and ignores the flag.

#### `close`, the way back from `open`

`close --port <n>` quits the browser on that port through `Browser.close` and waits up to 10 s for its process to exit.
It never kills. On macOS, Chrome and Brave copy their app bundle for every launch
(`/var/folders/<user>/X/<bundle id>.code_sign_clone/`, about 1.4 GB) and delete the copy only on a clean quit, so a
`kill <pid>` leaks 1.4 GB each time. One session on 2026-10-09 left three copies that way, and 102 of them filled the
disk on 2026-10-08. `close` refuses:

- a browser on the user's own profile (no `--user-data-dir`), unless `--main-profile` is given (ask the user first);
- a port two processes listen on (one on 127.0.0.1, one on `[::1]`), because CDP reaches only one of them;
- a listener that is not a browser (judged by its executable alone, not its arguments), and an empty port.

It also exits 1 in two more cases, and kills nothing in either:

- a pid listens but does not answer CDP: quit it from its own window (Cmd-Q);
- `Browser.close` went out, but the process still runs 10 s later: a page asks to confirm leaving, so answer it in the
  browser.

`open` prints the matching `close` line after it starts a browser. The library side is `closeBrowserOnPort` in
`lib/launch.ts`. A browser that this process spawned itself goes through `quitOwnedBrowser`, which sends
`Browser.close` only when that browser is the one process on the port. It kills the browser in three cases: another
process also listens on the port, the browser does not answer CDP, or `Browser.close` did not end it within 3 s.

#### Profiles and launch flags

- ⚠️ **Chrome 136 and later refuse to open the CDP port on the default profile directory** (an anti-automation
  measure). Chromium builds are not affected, and Brave can differ per version. `restart` detects the failure and
  suggests two fallbacks: `open --fresh` (throwaway, log in every time) and `open --user-data-dir <dir>` (a persistent
  separate profile, the only way to keep sessions on Chrome 136 and later). Use one directory per browser, for example
  `~/.genesis-tools/chrome-devtools/chrome/profile`: two browsers cannot share a user-data-dir.
- Only the throwaway profiles (`--fresh`, and `--extension` without `--user-data-dir`) get
  `--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks`, so their pages reach local dev servers. A
  persistent profile holds credentials, so it keeps Chrome's network protections like the real profile does. To let
  one page through there, use [`grant`](#local-network-access-and-grant).
- Every launch adds `MacAppCodeSignClone` to that same flag, because Chrome reads only the last `--disable-features`.
  Without it, branded Chrome on macOS copies its 1.4 GB app into the temp folder per launch and leaves the copy when it
  does not exit cleanly (Chromium issue 379125944).
- A `--fresh` directory is `/tmp/cdp-profile-<port>-<uuid>`, new for every run. Old ones stay in `/tmp` until it is
  cleared, because the tool cannot prove that no process still holds one open.
- **Focus.** On macOS, when an idle display can be selected, a separate profile (`open --fresh`, `--extension`,
  `--user-data-dir`, and the library's recording browser) starts with `--no-startup-window`. Its first window is opened
  over CDP with `Target.createTarget({ background: true })`, which Chrome shows inactive, on a display that does not
  hold the frontmost app's window (`src/utils/chrome-devtools/window-placement.ts`). `open` uses Launch Services with
  `open -g` so the app does not come forward. The recording browser (`lib/recording-browser.ts`) spawns the
  executable directly to capture its log and own its process, so its focus protection comes only from the suppressed
  startup window and the inactive first window. If inactive creation fails, a normal window is tried; when both fail,
  the launch fails. With one display, off macOS, or when the display probe fails, launches keep their normal startup
  window and the URL on argv. The real profile (plain `open`, `restart`) also launches as before, because
  `--no-startup-window` skips its session restore.

### Capture the network

One engine, two views:

| Piece | What it is |
|---|---|
| `record` | The only capture engine: one recorder per port, HAR-grade metadata into a rolling 4 h buffer |
| `follow` | The live view: chosen channels as lines; the only sanctioned way to tail the buffer |
| `har` | The retroactive view: a DevTools-grade HAR 1.2 from the buffer, or a live window on one tab |

A recorder is browser-wide or `--match`-scoped, and `attach` starts one for you. `follow` is rotation-aware and
prints Monitor-ready commands before it streams.

The old skill's `watch` verb is gone; running `watch` explains the split and exits 1. `arm` is a hidden alias of
`record`, the old skill's name for it.

| Command | What it does |
|---|---|
| `record --match <substr>` or `--all-tabs` | Runs a recorder in the foreground; one of the two scopes is required |
| `record --seconds <n>` | Default 600; `0` runs until CDP dies, at most 24 h |
| `record --channels +ws,body,storage` | Adds capture channels to the default `net,console` |
| `record --port <n> --stop` | Stops the recorder for that port; the buffer stays dumpable |
| `follow --channels <list> --match <p>` | Live lines; default channels `nav,doc,redirect,error` |
| `follow --last 10m --seconds <n> --out <file>` | Replays the buffer first, stops after N seconds, mirrors lines into a file |
| `follow --loops [n] --loop-window <s>` | Prints a `LOOP` line when one page is visited n times (default 3) within the window (default 60 s) |
| `har -o <file> --last 30m` | HAR from the buffer (default output `/tmp/cdp.har`; a bare number is minutes) |
| `har --now [--reload] [--seconds <n>] [--no-bodies]` | HAR of a live window on one tab, with bodies; 8 s with `--reload`, else 15 s |
| `har --port <n> --from-buffer` | Dumps a leftover buffer although its recorder already exited; name the port |
| `har --sanitize --analyze --summary` | Redacts secrets, runs `tools har-analyzer load`, prints one line per entry |
| `trace --match <p> --seconds 90 --out <file>` | One tab's document and redirect chain to a log (default `/tmp/cdp-trace.log`) |
| `net-panel --match <p>` | Dumps the user's open DevTools Network panel log (see below) |

`attach` starts its recorder as `record --all-tabs --seconds 0` with the default channels, detached. A manual `record`
runs in the foreground and refuses to start a second recorder on a port that has one: stop the first to change scope
or channels. `trace` logs the Location and Set-Cookie of every hop; for several tabs or channels, use `record` plus
`follow`.

- **A leftover buffer needs `--port`.** `har` resolves the port before it reads the buffer, the same way as the page
  verbs. A recorder usually exits because its browser died, so a bare `har --from-buffer` then exits 1 with
  `No live CDP endpoint`, or picks the port of the one other browser that is live. Name the dead port:
  `har --port 9222 --from-buffer -o x.har`, as `doctor` prints it.
- **In buffer mode `har --match` is a substring filter.** It keeps the entries whose URL or redirect target contains
  the text. A `/regex/` there is taken literally and drops every entry.
- **`trace --match` filters the log too.** Besides picking the tab, it keeps only the requests and redirect hops whose
  URL contains the `--match` text (for a hop, the URL it leads to), as a plain substring. So
  `trace --match app.example.com` on an SSO flow drops the hops into `idp.example.com`, and a `/regex/` drops every
  `DOC` and `REDIR` line. For a chain that crosses hosts, use `record` plus `follow --channels nav,redirect`.

#### Capture channels (`record --channels`)

| Channel | What it captures |
|---|---|
| `net` | HAR-grade network and page metadata: requests, redirects, headers, timings. Always on. |
| `console` | Console messages, thrown exceptions, browser log entries. On by default. |
| `ws` | WebSocket frames. High rate: scope with `--match`, it adds CPU. |
| `body` | Response bodies up to about 2 KB, fetched at `loadingFinished` (active CDP calls). |
| `storage` | A localStorage and sessionStorage snapshot on every navigation (active JS evaluation). |

A `+` prefix adds to the default (`+ws,body`); a list without it replaces the default (`net` stays on).

#### Render channels (`follow --channels`)

`nav doc redirect xhr ws console error cookie body storage`. They are all derived from the buffer, so picking them
costs nothing. `net` is shorthand for `nav,doc,redirect,xhr,cookie`. `body` and `storage` show data only when the
recorder captures that channel; `follow` prints the exact restart command when it does not.

`--loops` watches every document navigation and redirect hop (iframes too, whatever `--channels` shows), keyed by
origin, path and query parameter **names**, since `code`, `state` and `nonce` values change on every lap of an auth
loop. A `LOOP` line names the page, how often and how fast, and the cycle of pages between the last two visits. A
Monitor on `^[0-9:.]+ LOOP` fires once per loop and again while it keeps going.

Run long follows in the background with `--out`, then watch the printed command:

```bash
tools chrome-devtools follow --channels xhr,error --out /tmp/api.log --seconds 120
tools chrome-devtools follow --channels nav,redirect --loops --out /tmp/api.log
```

#### The buffer

`/tmp/GenesisTools/ChromeDevtools/<port>/` holds 30-minute jsonl segments, pruned past 4 h at rotation (one inline
unlink, no timer process), with a safety cap of about 500 MB per port. Segments are **internal**: never `tail -f`
them, because rotation silently breaks the file descriptor. `/tmp` clears on reboot. On Windows the root is
`%TEMP%\GenesisTools\ChromeDevtools`.

An empty `har` means the recorder started after the action, not that nothing happened.

#### HAR details

- Buffer dumps carry metadata and headers. Response bodies are physically gone once a tab navigates (Chrome discards
  them, Chromium bug 141129). For bodies use `har --now --reload`, or start the recorder with `--channels +body`.
  The `attach` guidance says "bodies are OFF" when that is the case: a field session once spent an hour
  fingerprinting OAuth grants by Content-Length because nothing said so.
- 🛑 A HAR of a login flow contains the plaintext password and live session tokens. `--sanitize` redacts `Cookie`,
  `Set-Cookie` and `Authorization` headers, cookie values, and password, token and code POST parameters. Use it
  before a HAR leaves the machine. For a HAR you already wrote, `tools har-analyzer load` it, then
  `tools har-analyzer export --sanitize --strip-bodies -o clean.har`. Do not paste secrets into shell commands: they land in shell history and agent transcripts.
- Read a HAR with `tools har-analyzer load <file>`, never with `cat` or `jq`.

#### The third network log: `net-panel`

A request lives in whichever log was already collecting when it happened, and nothing backfills: a second
`Network.enable` does not replay history. The recorder buffer and the MCP attach log are both ours. The third belongs
to the user's own open Network tab, and neither of the other two can reach it.

| Log | Verb | Covers | Blind to |
|---|---|---|---|
| Recorder buffer | `har --last 30m` | since **this tool's** recorder started; all tabs; 4 h | anything before `attach` ran |
| MCP attach log | `list_network_requests` | since **that MCP session** attached, in its own browser | the user's browser |
| Panel `NetworkLog` | `net-panel` | the user's **own open Network tab**, since they opened it | DevTools closed; headers, bodies |

The panel log reaches back to when the user opened DevTools with Preserve log on. The MCP log is also blind to
anything before its own attach.

The symptom that names the third one: their Network tab lists hundreds of rows while the MCP list returns empty, or
`har` dumps only the last minute. Observed live at **631** rows.

```bash
tools chrome-devtools net-panel --match app.example.com                 # histograms and document hops
tools chrome-devtools net-panel --match app.example.com -o /tmp/panel.har
```

Flags: `--json` (the summary as JSON), `-o <file.har>` (a HAR of the panel rows), `--full-urls` (keep query strings,
sanitized), `--documents <n>` (document hops to print, default 40), `--summary` (accepted, already the default view).

- `--match` names the **inspected tab**, or the inspector itself (`--match 'DevTools - <host><path>'`). Every open
  inspector reports the same `devtools://` URL, so the window **title** is the only discriminator (on Brave these
  targets report `type: "page"`, so the type cannot classify them either). An ambiguous match refuses and lists the
  candidates with a `--match` that names one, on either side: several matching tabs, or one tab that several
  inspectors tie to.
- One inspector on a **shorter** path is accepted with a warning, because DevTools truncates a long title. An
  inspector on the site root looks identical, so a warning `'DevTools - <host>' does not name <url> exactly` means
  the panel may belong to another tab.
- It is read-only: one `Runtime.evaluate` against the DevTools frontend. No reload, no navigate, no `Network.enable`,
  no panel switch. Do not reload their tab to "get a proper capture": that destroys the history you came for.
- Summary URLs are cut to origin plus pathname, so an OIDC `?code=` or an `#access_token=` never reaches stdout. The
  `-o` HAR carries no headers, cookies or POST bodies by construction: the eval never collects them. `--full-urls`
  runs query strings through the HAR sanitizer, and `data:` and `javascript:` URLs stay reduced to a scheme marker
  under every flag.

### Inspect and drive a tab

| Command | What it does |
|---|---|
| `cookies [--domain <substr>] [--json]` | Every cookie across all domains, httpOnly included; `--json` to diff two browsers |
| `rm-cookie --name <n> --domain <d> [--path /]` | Deletes one cookie by name, domain (as `cookies` lists it) and path |
| `console --match <p> [--reload] [--wait <s>]` | What the tab already logged plus what it logs while listening (5 s, or 8 s with `--reload`) |
| `eval [fnOrExpr] [--file <path>] [--timeout 30]` | Runs JS in the page and prints the result as JSON |
| `nav <url> [--new] [--spa] [--wait-for <sel>] [--wait-text <t>]` | Navigates a tab, opens a new one, or moves a single-page app in place |
| `shot [path] [--full]` | Screenshot, default `/tmp/shot.png`; refuses an output that is no `.png` |
| `shot <path> --mark <loc> [--label <t>] [--at <side>] [--clip <loc>] [--pad <px>] [--annotate <plan>] [--preset <name>]` | An annotated and a raw image of what the tab shows now, plus the marks (see below) |
| `grid [path] [--region x,y,w,h] [--step 60] [--full]` | Screenshot with a pixel grid burned in (needs ImageMagick) |
| `snapshot [--text] [--json]` | The tab's controls (role, label, value) and, with `--text`, its visible text |
| `click <label> [--nth <n>] [--role <role>] [--json]` | Clicks a control by its label; an option's label picks that option |
| `fill <label> [text] [--stdin] [--nth <n>] [--json]` | Replaces a field's text, then reads it back inside the page |
| `scroll [down or up]` | Scrolls by most of a screen, so controls below the fold come into view |

Every command in this table except `cookies`, `rm-cookie` and `grid` takes `--match`. `grid` shoots the most recently
active tab, with ImageMagick's `magick` (default output `/tmp/grid.png`): read the label, click the pixel, on pages
where accessibility-tree tools see nothing.

- `console` attaches its listener before `Runtime.enable`, which replays every message the tab already logged. The
  MCP `list_console_messages` misses everything before its own attach. The last line counts messages by level.
- `eval --file` reads the function from a file, which avoids shell quoting and hooks that block inline eval strings.
  A typical read: `eval '() => ({url: location.href, ls: {...localStorage}, ss: {...sessionStorage}})'`.
- `nav --spa` uses `history.pushState` plus `popstate`, with no reload, so app state and caches survive (same origin
  only). Give the full path with the app's base: an app under `/app/` needs `/app/billing`, and `/billing` leaves it
  on a blank page (a warning says so when the first path segment changes). It works with routers that listen to
  `popstate` (React Router, TanStack Router, most others). `nav` exits 1 when `--wait-for` or `--wait-text` did not
  hold within `--timeout` (default 15 s). `--new` only opens a tab, so it cannot be combined with `--match`, `--spa`,
  `--wait-for` or `--wait-text`.
- `rm-cookie` is the surgical confirmation step. Never "clear site data" to fix a cookie or session poison: it
  destroys the evidence and the user's logins.
- `fill --stdin` keeps the text out of shell history.

#### The page agent (`snapshot`, `click`, `fill`, `scroll`)

These four commands find a control by its label in a fresh read (`lib/dom/find.ts`: an exact label before a
substring, an option row by its option). Node ids are not accepted on the command line: ids and guards belong to one
isolated world, and every command is a new process with a new one. Several matches refuse and list them; `--nth`
picks one.

```bash
tools chrome-devtools snapshot --match app.example.com
tools chrome-devtools click Save --role button --match app.example.com
tools chrome-devtools click Express --role option --match shop.example.com
tools chrome-devtools fill Search "night owls" --match app.example.com
```

How it reads and acts (`DomPage.attach({ port, target })` in `lib/dom/`, on this tool's own CDP client):

- Every read is ONE `Runtime.evaluate` of `installPageAgent` (`lib/dom/in-page.ts`) in an isolated world, so page
  scripts can neither read nor replace it. A read returns the interactive elements in the viewport (page-scoped node
  ids that survive across reads, accessible names, one row per `<option>`), the visible text (capped), scroll room and
  a change marker.
- Password, one-time-code and payment fields are marked secret, and their values are never read. A read also names
  every shown secret field in the document (`secretFields`), below the fold and past the action cap included, so a
  caller knows a page wants a secret before it presses anything.
- Before any input the agent re-checks the target: still attached, the same guard hash (identity, name, value, state,
  and the text of its nearest row, form or dialog), enabled, shown, and the element under its centre point
  (`elementFromPoint`). Input is real `Input.dispatch*` events or `Input.insertText`, and a fill is read back inside
  the page. A select runs the same checks, then checks the option itself by its label and its disabled flag.
- Every CDP call, input and navigation sends included, has a 5 s deadline. An input whose send runs out is reported as
  `dispatch_uncertain` and never repeated.
- The wait after an act is event driven: a mutation observer resolves it once the page changed and stayed quiet for
  50 ms, or at 300 ms. Focus emulation lets it work in a tab the user is not looking at.
- It reads every OPEN shadow root (web components, extension side panels): candidates, visible text,
  `aria-labelledby` ids scoped to their root, the hit test (through `shadowRoot.elementFromPoint`, with containment
  that crosses shadow boundaries) and the settle observers. A closed shadow root stays invisible, as it is to the
  page.

`bun src/chrome-devtools/scripts/dom-guards.ts` checks all of it against a headless Chrome on a throwaway profile and a
loopback fixture (no model, no network; `CHROME=<binary>` picks the browser). Measured 2026-09-28: a 2000-link page
reads in 11.8 ms median over 10 reads, a click that changes nothing settles at the 300 ms cap, and `back` from a
back-forward-cache page returns in 5 to 11 ms.

### Annotated page shots

Boxes and labels drawn into the page (in its own font, so Czech letters are right), photographed and removed: each
shot is a raw image and an annotated one that differ only under the overlay. Targets are locator strings resolved when
the shot runs, never pixels; a target that matches nothing, or a label with no free spot, fails the shot by name.

```bash
# one quick shot of the tab you look at: annotated, raw (.original) and the marks in image pixels
tools chrome-devtools shot ~/shots/usages.webp \
    --mark testid=usages-button \
    --label "Kde je použitý" \
    --at below
# a shot book: list it, check it (no browser), rehearse it (no images), run it
tools chrome-devtools shots list scripts/app.shots.ts
tools chrome-devtools shots check scripts/app.shots.ts
tools chrome-devtools shots rehearse scripts/app.shots.ts --only 18,08
tools chrome-devtools shots run scripts/app.shots.ts --tag 1110 --out ~/Projects/app/docs/images
```

| Command | What it does |
|---|---|
| `shots run <book> [--only ids] [--out dir] [--tag t] [--base url] [--browser headless\|attach] [--port n] [--json]` | Every shot: `<stem>.<tag>.webp` and `<stem>.<tag>.original.webp`, PNGs under `png/` when the book asks, marks and the run report under `.shots/<tag>/` |
| `shots list <book> [--only ids] [--json]` | id, stem, parts, first URL, note; no browser |
| `shots check <book> [--only ids]` | Parses every locator, mark and part; no browser, changes nothing |
| `shots rehearse <book> [--only ids] [--browser] [--port]` | Visits every part, runs its steps, resolves every locator and places every label; no image |

- **Locators**: `testid=x` (`testid^=` prefix), `css=…`, `text=Exact` (`text~=` contains, `text=/re/`), `role=dialog`,
  `role=heading[name="Zahrada"]`, `label=/^Název/`, chained with ` >> ` (`has-text=…`, `nth=1`); an array is a union
  whose every member must match.
- **A book** is `.ts` (`export default defineShots({...})`, with `id`, `css`, `text`, `union`, `nth`, `within`,
  `hasText`, `role` and `label` imported from `@genesis-tools/shots`; the loader serves that module, so the book's
  folder needs no `node_modules`) or `.json`/`.jsonc`. A mark also takes the words `at: "below"`, `dx`, `dy`,
  `color: "amber"` and `quiet`.
- **Labels** go to the requested side, else to the next side that covers no page text and no other label inside the
  clip; `clip.fit: "labels"` grows the clip instead. The clip defaults to the marks' targets plus 20 px.
- **Browsers**: `headless` (default: a fresh Chrome; login cookies copied in memory from your running browser, only
  those the book's base URL sends, or from `browser.headless.cookies: { from: "command", argv }`) or `attach` (your
  running browser, in a new background tab).
- The marks file is an annotation plan: `tools control draw <image> --annotate <marks.json>` redraws it. A
  `shot --annotate` plan is the same format, where an item may name a `target` instead of a `rect`.
- Code: `src/utils/chrome-devtools/shots/` (vendored: locators, the in-page agent, `capturePart`) and `lib/shots/`
  (book, browsers, runner, quick shot).

### Performance, throttling and overrides

| Command | What it does |
|---|---|
| `perf load [url] --runs <n> --cpu <rate> --network <preset>` | Page loads: long frames and their scripts, long tasks, CLS, lag, marks |
| `perf load --wait 10 --until <sel> --until-text <t>` | How long to observe after the load event, and when to stop |
| `perf load --mark name=sel[@text] --resources <substr>` | Time until an element shows; include resource timings (both repeatable) |
| `perf record --seconds 20 [--cpu] [--network] [--mark]` | Observes the current document while a person interacts: INP, slowest events, long frames, marks |
| `perf ab <spec.json> [-o /tmp/perf-ab.json]` | Interleaved A/B loads from a spec, per-variant p50, p90, min and max |
| `emulate --cpu <rate> --network <preset>` | Throttles a tab while the command runs (until Ctrl-C or `--seconds`) |
| `emulate --latency <ms> --down <kbps> --up <kbps> --offline` | A custom network instead of a preset |
| `intercept --url <glob> --replace 'from=>to'` | Rewrites matching response bodies (from is a regex, to may use `$1`); repeatable |
| `intercept --url <glob> --body-file <file>` or `--block` | Answers with a file, or fails the request (`BlockedByClient`) |
| `intercept --map-dir <dir> [--stage request or response]` | Attaches carried source maps to deployed scripts, so DevTools shows real sources |
| `grant [permissions...] [--origin <url>] [--seconds <n>]` | Grants permissions to the tab's origin while it runs (default `local-network loopback-network`) |

Network presets: `none`, `3g`, `slow-4g`, `fast-4g`, `offline`. `perf load`, `perf record` and `perf ab` also take
`--json` (a result on stdout) and `-o <file>` (the full samples as JSON; `perf ab` rewrites it after every run).
Throttling, observers, rewrites and grants belong to the command's CDP session: they end when the command exits.

```bash
tools chrome-devtools perf load http://localhost:3000/ --runs 5 --cpu 4 --mark 'list=[data-testid=list]'
tools chrome-devtools perf record --match localhost:3000 --seconds 30
tools chrome-devtools emulate --match localhost:3000 --network slow-4g --seconds 120
tools chrome-devtools intercept --match localhost:3000 --url '*/config.js*' --replace 'replay:true=>replay:false'
tools chrome-devtools grant --match app.example.com
```

How it measures:

- With in-page observers installed before the page's own scripts on every run (long-animation-frame with script
  attribution, longtask, layout-shift sources, event timing, a lag sampler, marks), not with a DevTools trace: a trace
  at 6x CPU distorts what it measures. A `worst` line names the invoker (for example `TimerHandler:setTimeout`) and
  the script position. With `--runs` above 1, `perf load` ends with a table of N, P50, P90, MIN and MAX per metric.
- `perf load` brings the tab to the front first, and every summary warns when the page was hidden, because a
  background tab throttles timers and skips frames. Never conclude from one run.
- The logic lives in `@genesiscz/utils/chrome-devtools/` (`src/utils/chrome-devtools/`). Every helper takes a
  `CdpLike` session, so another project can vendor it and drive it with a Playwright `CDPSession`. The verbs here are
  thin.
- The step from a worst frame's `chunk.js:offset` to a source line is `tools ts sourcemaps resolve`
  ([../ts/README.md](../ts/README.md)). The plugin skill's
  [sourcemaps.md](../../plugins/genesis-tools/skills/chrome-devtools/references/sourcemaps.md) orders every strategy by
  cost with its measured hit rate, and
  [perf-investigation.md](../../plugins/genesis-tools/skills/chrome-devtools/references/perf-investigation.md) is the
  playbook. `intercept --map-dir` takes the output of `tools ts sourcemaps carry`.

#### The `perf ab` spec

Each variant runs `rounds` times in ABBA order, so drift over time hits every variant alike. Ctrl-C stops after the
current run and still prints the summary; samples are saved after every run.

```json
{
  "url": "http://localhost:3000/",
  "rounds": 4,
  "cpu": 4,
  "until": { "selector": "[data-testid=list]" },
  "marks": [{ "name": "list", "selector": "[data-testid=list]" }],
  "clearStorage": { "sessionStorage": ["replaySession"] },
  "probe": "() => ({ replay: window.appConfig?.replay })",
  "variants": [
    { "name": "baseline" },
    { "name": "no-replay", "rewrite": [{ "url": "*/config.js*", "replace": [{ "from": "replay:true", "to": "replay:false" }] }] }
  ]
}
```

Optional keys: `order` (`abba` or `same`), `network`, `waitMs` (default 10000), `clearCookies` (names, only the
measured site's cookies), and per variant `url`, `cpu`, `network`, `rewrite`. `rewrite.url` is a glob; `replace.from`
is a regular expression.

- Attribution by sourceURL fails when a library is bundled into the app's chunks: the frames name the chunk. Then the
  A/B diff is the attribution: rewrite the library away in one variant and compare.
- State that survives a reload leaks between runs (a sessionStorage sampling flag, a cached decision). Clear it with
  `clearStorage` and `clearCookies`, or the first run decides for all.
- A replacement count proves the rewrite matched, not that the app changed. `probe` runs after every load, and its
  value is printed and saved per sample, so you can see each variant really ran as intended.

#### Local Network Access and `grant`

Chrome 145 and later block a request from a public page to a private address (`local-network`: 10.x, 192.168.x, a
host that resolves there) or to loopback (`loopback-network`: 127.0.0.1, localhost). The failed request carries
`corsError: LocalNetworkAccessPermissionDenied` or `net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`, and its `follow`
FAIL line ends with `blocked by Local Network Access (LocalNetworkAccessPermissionDenied)` and the grant command.

`grant --match <tab>` holds a grant for the tab's own origin (`--origin` and `--seconds` change that). Measured on
Chrome 154, the mechanism is `Browser.setPermission` with the descriptor name `local-network` or `loopback-network`,
or `Browser.grantPermissions` with `localNetwork` / `loopbackNetwork`. The old `local-network-access` is accepted but
unblocks nothing since Chrome 145. The grant needs an HTTPS origin, and it ends when the CDP session that made it
detaches. With the checks merely disabled (`--fresh`), an HTTPS page still cannot call an HTTP private address (mixed
content); a grant can. Other Permissions API names work too, for example `geolocation` or `notifications`.

### App state

| Command | What it does |
|---|---|
| `storage idb [--db <name>] [--store <name>] [--key <key>]` | Dumps the tab origin's IndexedDB, read-only; never creates a database |
| `storage idb --keys-only --max-value-bytes <n> --json -o <file>` | Keys and counts only, value previews, JSON on stdout or in a file |
| `storage idb --from-profile <dir> --origin <url> [--browser chrome]` | Reads a browser that runs without a debug port |
| `storage web [--keys a,b] [--json] [-o <file>]` | Lists the tab's localStorage and sessionStorage, read-only |
| `react find --function <path> --path <path> --component <name>` | Finds components whose props carry a function or a value, in one walk of every React root |
| `react find ... --expose <slot> [--json]` | Puts the live match on `window[<slot>]` for later `eval` calls |

- `storage idb` lists every store with its row count and data size (a string counts its own text, any other value its
  JSON; `--json` adds `jsonBytes`, which counts quotes and escapes), then the 5 biggest rows. `--key 42` is a number
  key; `--key '"42"'` is a string key.
- ⚠️ The leveldb folder size on disk is **not** the data size, in either direction. Measured: a 2.4 MB folder held
  370 KB of rows (leveldb appends a full copy of every write to its log), and a 19.7 KB folder held 360 KB (leveldb
  compresses). Read the DATA BYTES column, not `du`.
- `--from-profile` copies the origin's IndexedDB folders into a scratch user-data-dir under the capture root's
  `idb-copies/` (the path is printed and kept, see [Where data lives](#where-data-lives); the source is only read), opens the copy in a headless browser on a free port, answers every request to the origin
  with a blank page (no app code runs, no network), and dumps from there. Profile folders on macOS are
  `~/Library/Application Support/BraveSoftware/Brave-Browser/Default` and
  `~/Library/Application Support/Google/Chrome/Default` (or `Profile 1`, ...). When the copy does not open (a newer
  Chromium wrote it), pass `--browser brave` to read a Brave profile with Brave itself.
- `react find` reaches app state that has no global: find the provider that holds it, `--expose` it, read it with
  `eval`. It uses no `eval` or `new Function` in the page, so it works under a strict CSP. It is read-only unless
  `--expose`, which sets that one window property. It exits 1 when a matcher found nothing.

```bash
tools chrome-devtools react find --match app.example.com --function client.getQueryCache --expose __qc
tools chrome-devtools eval --match app.example.com "() => window.__qc.getQueryCache().getAll().length"
```

### Health and cleanup

| Command | What it does |
|---|---|
| `status [--all] [--detailed] [--json]` | Every recorder and recorder-shaped process: pid, CPU, memory, cpu-time, buffer size, endpoint health. Read-only |
| `doctor [--json]` | Read-only diagnosis with one fix command per finding; applies nothing |
| `cleanup` | Applies the fixes: a guided multi-select in a terminal |
| `cleanup --kill <pid...> --stale <port...> --legacy [port...] --dir <port...> --yes` | The same without a terminal, with explicit flags |
| `resume [--match <p>] [--workers] [--debugger] [--timeout-ms 5000] [--json]` | Releases tabs a debugger client left held |

- `status` also lists orphan recorder-shaped processes and legacy `/tmp/cdp-arm-*` files from the old skill.
  `--all` adds leftover capture dirs with no recorder, buffer or endpoint; `--detailed` adds per-port meta, pidfile
  records and segment lists; `--format json` is the long form of `--json`.
- `doctor` finds stale pidfiles, pidfiles that point at a different program, recorders above 25% CPU, leftover
  buffers, buffers over the 500 MB cap, orphan recorders, legacy files, browsers running with an empty
  `--remote-debugging-port=` flag, and blank pages with an opener ("possibly held popup"). It exits 1 when a finding
  is an error.
- `cleanup` kill safety has three layers: the pid must still be recorder-shaped (pid recycling), must not BE a live
  pidfile-owned recorder (use `record --stop` for that), and must not be a launcher ancestor of one (the launch chain
  carries the same argv; a field test caught `doctor` suggesting exactly that kill before this guard existed). Kills
  are never batched: `--yes` applies only the safe fixes and never kills. Files are moved to
  `/tmp/GenesisTools/ChromeDevtools/trash-<date>/`, never destroyed in place, and survive until reboot. `--dir`
  removes a port's buffer from `har` for good, so dump it first.
- `resume`: browser-level `Target.setAutoAttach` makes Chrome hold every `window.open()` popup until
  `Runtime.runIfWaitingForDebugger`. The popup stays blank and its opener shows "Debugger paused in another tab", even
  after that client is gone. `resume` prints one line per target (`released`, `ok`, `debugger-resumed`,
  `timeout <step>`, `error <msg>`) and exits 1 when a target timed out or failed. It sends only resume commands (no
  evaluate, no Network or Page domain, no new tabs), so it is safe on a browser with a live session. `--workers` adds
  workers, service workers and shared workers; `--debugger` also ends a real Debugger pause (it enables Debugger on
  each target for about 300 ms). Unlike the page verbs, it takes `--port` literally.

### Scripting

| Command | What it does |
|---|---|
| `scaffold <name> [--recipe <recipe>]` | Creates a CDP scratch script in the `tools scripts` store; `--recipe` defaults to `blank` |
| `scaffold --list` | Lists the recipes; with no name and no `--list` it lists them and exits 1 |
| `cheatsheet` | Prints the CDP scripting cheatsheet (lib API, recipes, channels, do-not-pipe rules) |
| `mcp [tool] [json] [--port <n>]` | Calls the real chrome-devtools-mcp tools against this port; `mcp list` lists them |

Recipes, each verified against a live CDP browser before it shipped: `perf-load`, `perf-ab`, `spa-steps`,
`interaction`, `idb-dump`, `redirect-chain`, `cookie-diff` (diff two browsers by name, domain and path), `storage-snapshot`,
`body-fetch`, `console-trap` and `blank`. A name is letters, digits, dash and underscore, and starts with a letter.

```bash
tools chrome-devtools scaffold loginRedirects --recipe redirect-chain
tools scripts run loginRedirects -- --port 9222 --match idp.example.com
tools scripts show loginRedirects
```

- The store's tsconfig maps `@gt/chrome-devtools/*` to this tool's `lib/` and `@gt/utils/*` to `src/utils/`. The
  script is versioned, listable and runnable there.
- `cheatsheet` prints `plugins/genesis-tools/skills/chrome-devtools/references/cdp-cheatsheet.md` from this checkout.
- `mcp` is an explicit pass-through. It starts the `chrome-devtools-mcp` binary from `PATH` with
  `--browserUrl http://127.0.0.1:<port>`, needs no session config edit and no restart, and prints the first 4000
  characters of the result. No other tool in this repo drives a browser through chrome-devtools-mcp any more: jev,
  spotify, waze, the node-repl `browser` toolset and the youtube extension harness use this tool's own CDP client in
  `lib/` (`cdp.ts`, `dom/`, `tab-driver.ts`, `tabs.ts`, `extensions.ts`).

## How it works

### Where data lives

| Path | What it holds |
|---|---|
| `/tmp/GenesisTools/ChromeDevtools/<port>/` | The capture buffer: `seg-*.jsonl` segments, `meta.json`, `recorder.pid` |
| `/tmp/GenesisTools/ChromeDevtools/last-port` | The port `attach` last settled on |
| `/tmp/GenesisTools/ChromeDevtools/trash-<date>/` | What `cleanup` moved aside |
| `/tmp/cdp-profile-<port>-<uuid>/` | One `open --fresh` or `--extension` profile per run, kept |
| `/tmp/cdp.har`, `/tmp/shot.png`, `/tmp/grid.png`, `/tmp/cdp-trace.log`, `/tmp/perf-ab.json` | Default outputs |
| `~/.genesis-tools/chrome-devtools/<browser>/profile` | The suggested persistent profile for `open --user-data-dir` |
| `/tmp/GenesisTools/ChromeDevtools/idb-copies/<origin>-<stamp>/` | One `storage idb --from-profile` copy per run, kept, mode 0700; it can hold session tokens |
| `~/.genesis-tools/chrome-devtools/recording-browsers/<id>/` | A library recording browser's profile and `browser.log` |
| `/tmp/cdp-arm-<port>.jsonl`, `.pid` | Legacy files of the old skill; `doctor` finds them, `cleanup --legacy` moves them |

The capture root is `/tmp` on purpose: captures hold live cookies and tokens, `/tmp` clears on reboot, and the root
and each port directory are set to mode 0700. On Windows every `/tmp` path above is under `%TEMP%`, and the legacy
files do not exist. Every command the tool prints (attach guidance, doctor fixes, `--help` examples) already carries
the right path for the platform.

### What it talks to

- The browser's own CDP endpoint on 127.0.0.1: HTTP (`/json/version`, `/json/list`, `PUT /json/new`) and WebSocket.
  Each command opens its own connection, so it holds no session to lose.
- `mcp`: the `chrome-devtools-mcp` binary. `grid`: ImageMagick's `magick`. `har --analyze`: `tools har-analyzer`.
  `scaffold`: the `tools scripts` store.
- Process and socket reads go through the shared process layer in `src/utils/process/`: libproc on macOS, `/proc` on
  Linux, PowerShell CIM and one `netstat -ano` on Windows, and `lsof` as the fallback.
- No permissions, no accounts, no network calls of its own, and nothing that costs money.

### Recorder lifecycle (the incident, encoded)

The tool replaced an earlier agent skill after the CPU-leak incident of 2026-08-25, when an unbounded recorder pinned
a core for hours and left duplicate processes behind. These rules encode that incident.

- Pid-recycling-safe pidfiles (`@genesiscz/utils/process/pidfile`) are claimed **before** the child connects, so
  concurrent `attach` calls from many agent sessions yield exactly one recorder per port. A raced duplicate is killed
  by the parent, and it also checks itself at boot.
- High-rate packets are never `JSON.parse`d. WebSocket frames are dropped before parsing (unless the `ws` channel is
  on), and `Network.dataReceived` goes through a regex fast path that adds up byte counts in memory and emits one
  summary event per request.
- One open file descriptor per segment and `writeSync` per event, never `appendFileSync`.
- It dies when CDP dies: a `/json/version` probe every 2 s, and 3 failures mean exit. It also exits on WebSocket
  close, SIGTERM, `record --stop`, `--seconds`, and a hard 24 h lifetime cap.

### HAR pipeline

`lib/har/` is a TypeScript port of chrome-har v1.3.1 (sitespeedio/chrome-har, MIT), the converter that browsertime,
puppeteer-har and playwright-har all wrap. The header of `lib/har/build.ts` documents five deviations. The important
one keys entries by session (`sessionId` plus `requestId`), so multi-tab captures cannot corrupt each other. Another
gives a redirect hop the raw headers of its own `responseReceivedExtraInfo`, so a 302 that set or cleared a cookie
shows its Set-Cookie. Parity is pinned by `lib/har/build.parity.test.ts` against goldens generated once from the
upstream package over its own real-Chrome perflogs (upstream clone: `../_Playgrounds/chrome-har`, outside the repo).
There is no chrome-har npm dependency; `tough-cookie` remains for Set-Cookie parsing fidelity.

No native CDP, MCP or Playwright export exists for an attached user browser. The research that showed this is a local
note dated 2026-08-26, not published in the repo.

### Platform support

darwin, linux and win32, factored through `lib/platform.ts` (injectable primitives with per-platform parser tests).
Browser launch is `open -na` on macOS (`open -gna` for a background launch), the browser binary on `PATH` on Linux,
and known install paths (Program Files, LOCALAPPDATA) on Windows. On Linux and Windows, `status` reports %CPU as the
lifetime average (cpu-time over the process's age); macOS shows recent usage. On Windows `grid` needs ImageMagick on
`PATH`. macOS and Linux are exercised end to end; Windows support is parser-tested but not yet run against a live
Windows browser.

### Benchmark

The `attach` auto-record default was validated on the real browser before it shipped. The numbers live in a dated
section of the tool's design notes, which are not published. If the recorder ever looks hot in `status`, re-measure
with interleaved runs (at least 5 per arm).

## Configuration

There is no config file and no account. Choices are flags. The state that carries between commands is the remembered
port (`last-port`) and the recorder per port. The only environment variable is `CHROME`, which picks the browser
binary for the `dom-guards.ts` check script.

## For agents

- **Start with `attach`, every time.** Then use the bare verbs: they reuse its port while it is live.
- **JSON output:** `status --json`, `doctor --json`, `targets --json`, `cookies --json`, `net-panel --json`,
  `resume --json`, `snapshot`, `click` and `fill --json`, `perf load|record|ab --json`, `storage idb|web --json`,
  `react find --json`. `har --summary` prints a one-shot table (time, method, status, request and response bytes,
  auth scheme, URL) for assertions.
- **Exit codes:** 1 for a usage error, a `--match` that hits nothing or several tabs, several live endpoints with no
  `--port`, an `attach` with two browsers and no `--port`, a `doctor` error finding, a `resume` target that timed out
  or failed, a `nav` wait that did not hold, a `react find` matcher with no match, a `close` that refused or could not
  close the browser, and a `restart` that could not verify its end state. Also 1: a `har` with no recorder and no
  buffer, a `har` on a leftover buffer without `--from-buffer`, a `record` without `--match` or `--all-tabs`, an `open`
  whose port did not come up, and a `scaffold` with no name.
- **Long-running verbs** (`record`, `follow`, `trace`, `emulate`, `intercept`, `grant`): run them in the background
  with `--out` where they have it, then watch the file. Never pipe them to `head` or `tail`: they print their pid and
  paths first and keep running.
- **The plugin skill** [`chrome-devtools`](../../plugins/genesis-tools/skills/chrome-devtools/SKILL.md) holds the
  method that finds auth and cookie bugs, the auth-loop playbook, the Network panel symptom index and the net-export
  recipes in its `references/` folder.
- **node-repl:** the `browser` toolset (`tabs`, `open`, `evaluate`, `navigate`, `close`, `screenshot`) is built on
  `lib/tab-driver.ts`; see [../node-repl/README.md](../node-repl/README.md).
- **Library for other tools:**
  - `lib/dom/` is the page agent (`DomPage`).
  - `lib/tab-driver.ts` drives the page's MAIN world by tab id, for code that needs the page's own globals (spotify's
    player): `evaluate` with a deadline, `navigate` and `open` that wait for the load event, and `waitForRequest` over
    `Network.requestWillBeSent` (headers lower-cased; `cause` reloads or navigates once it listens). A closed tab
    raises `TabGoneError`.
  - `lib/tabs.ts` has `listTabs`, `currentTab({ port, title })`, `activateTab`, `closeTab` and `tabTarget`. CDP has no
    "active tab" call, so `currentTab` matches the window title, and otherwise takes the most recently active page
    (`/json/list` order).
  - `src/utils/chrome-devtools/` is vendored by another repository: it uses only `node:` APIs and imports nothing from
    outside `src/utils/`.
- **Never build new browser automation on chrome-devtools-mcp.** It was slow and fragile: a 26 s accessibility
  snapshot on a 60-tab browser, and a page selection that followed the user from tab to tab.
- **Two browsers can listen on one CDP port.** A Chrome started while another one holds `127.0.0.1:<port>` binds only
  `[::1]:<port>`, with no error, and the tools connect to 127.0.0.1. Before a live test,
  `lsof -nP -iTCP:<port> -sTCP:LISTEN` must show exactly one pid, and `ps -o command= -p <pid>` must show your
  `--user-data-dir`. Start a test browser with `--remote-debugging-address=127.0.0.1` on a port nobody listens on.

## Troubleshooting

Habits that cause most of the failures below:

- Do not pipe `record`, `follow` or `trace` to `head` or `tail`.
- Do not `tail -f` segment files. Use `follow`.
- Do not `pkill -f chrome-devtools`: that can hit MCP servers and the CLI you are typing. `status` shows pids, and
  `cleanup --kill` verifies before it kills.
- Do not `kill` a browser that `open` started: it leaks a 1.4 GB app copy on macOS. Use `close`.
- Do not delete capture dirs or a leftover buffer by hand: that is the retroactive HAR. Dump it, then `cleanup`.
- Do not `cat` or `jq` a `.har`. Use `tools har-analyzer load`.

| Symptom | Cause and fix |
|---|---|
| `attach`: "No CDP endpoint" | The browser started without the flag. `restart` it (ask first) or `open --fresh` beside it. |
| Chrome starts but the port never answers | Chrome 136 and later refuse the flag on the default profile. Use `open --user-data-dir <dir>` or `open --fresh`. |
| `attach` reports "consent mode" | Chrome 144 and later with `chrome://inspect/#remote-debugging` on (see below). |
| `attach` lists a browser with an empty debugging flag | It runs with `--remote-debugging-port=` and no number, so nothing listens. `restart` it. |
| A verb exits 1 naming several ports | Several live endpoints and none remembered. Run `attach --port <n>` once, or pass `--port`. |
| `eval` answers `No throttling Fast 4G Slow 4G ...` | `--match` fell back to a DevTools window title. Anchor the pattern on the scheme. |
| `har` is empty or covers only the last minute | The recorder started after the action. Their open Network tab may still have it: `net-panel`. |
| `har` refuses: "the recorder ... is not running" | The buffer is a leftover. Run `har --port <n> --from-buffer`: without `--port` it resolves a live browser's port, not the dead one. |
| HAR entries have no bodies | Chrome discarded them on navigation. Use `har --now --reload`, or record with `--channels +body`. |
| A `follow` FAIL line says "blocked by Local Network Access" | Chrome 145 and later block public-to-private requests. Run `grant --match <tab>` and reload. |
| A popup stays blank, its opener says "Debugger paused in another tab" | A debugger client left it held. `resume --port <n>` (add `--match`). |
| `restart` keeps waiting | A `beforeunload` prompt holds the quit. Answer it in the browser; use `--force` only if the user agrees. |
| `restart` reports a profile picker | The relaunch hit "Who's using ...?". Run the printed dismissal, or pass `--profile-directory`. |
| `close` refuses | The main profile (add `--main-profile` after asking), two listeners on the port, or not a browser. |
| `close`: "does not answer CDP" | Quit the browser from its own window (Cmd-Q). Never kill it. |
| `close`: "still runs 10 s later" | A page asks to confirm leaving. Answer it in the browser. |
| `restart` pauses after the quit | It waits for an update-on-quit to finish (macOS, at most 60 s). |
| `restart`: "answered, then stopped answering" | The relaunched browser died. Read the printed crash report, then run the printed relaunch. |
| `doctor`: recorder is hot | Above 25% CPU. Stop it with `record --stop`, then scope it with `--match` or fewer channels. |
| `cheatsheet` says the file is missing | The plugin skill folder moved; the command reads it from the checkout. |
| `mcp` fails to start | `chrome-devtools-mcp` is not on `PATH`. |
| `grid` fails | ImageMagick's `magick` is not installed. |

**Consent mode.** With `chrome://inspect/#remote-debugging` turned on, Chrome 144 and later listen on a port and write
`DevToolsActivePort`, but `/json/version` and `/json/list` answer 404. Only the browser WebSocket works there, and the
browser asks "Allow remote debugging?" on every connection. The verbs here need `/json` (targets, cookies, follow,
har), so they cannot drive that endpoint yet. `attach` prints the WebSocket URL and an `open --user-data-dir` command
for a separate profile instead.

The chrome-devtools-mcp tools can vanish in the middle of a Claude Code session. That is normal: the harness tears an
idle stdio server down and starts it again on the next call. The CLI is not affected, because it speaks to the
browser's port on every call. The MCP server drives its own isolated Chrome on an ephemeral port, and its
`DevToolsActivePort` files leave empty capture dirs that `attach` finds later; `cleanup` removes them.

## Related

- [../har-analyzer/README.md](../har-analyzer/README.md): read and sanitize the HARs this tool writes.
- [../ts/README.md](../ts/README.md): `tools ts sourcemaps`, from a minified position to a source line.
- [../scripts/README.md](../scripts/README.md): the store where `scaffold` puts its scripts.
- [../youtube/README.md](../youtube/README.md): `tools youtube extension devtools launch --port 9333` starts a browser
  with the extension loaded; drive it with these verbs and `--port 9333`. Plain extension loading is
  `open --extension <dist-dir>`.
- [../jev/README.md](../jev/README.md), [../spotify/README.md](../spotify/README.md) and
  [../waze/README.md](../waze/README.md): tools built on this tool's CDP library (the page agent, the tab driver).
- [../browser-extension/README.md](../browser-extension/README.md): its `reload`, `dev` and `verify` use
  `lib/extensions.ts`.
- [../video/README.md](../video/README.md): its stream capture uses `lib/page-capture.ts`.
- [../node-repl/README.md](../node-repl/README.md): the `browser` toolset.
- The plugin skill: [SKILL.md](../../plugins/genesis-tools/skills/chrome-devtools/SKILL.md). The repo-local
  `chrome-extension-dev` skill has the full extension flow.
