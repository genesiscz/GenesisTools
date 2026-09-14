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
holds credentials, so it keeps Chrome's network protections like the real profile does.

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
| `follow` | The live view. Renders chosen channels as human lines, prints Monitor-ready commands. Rotation-aware — the only sanctioned way to tail the buffer. |
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

## Scripting

- `scaffold <name> --recipe <r>` creates a CDP scratch script **in the `tools scripts`
  store** (versioned, `tools scripts run <name>`). Recipes: `redirect-chain`,
  `cookie-diff`, `storage-snapshot`, `body-fetch`, `console-trap`, `blank`. The store's
  tsconfig maps `@gt/chrome-devtools/*` to this tool's `lib/`.
- `cheatsheet` prints the CDP scripting cheatsheet (also in the plugin skill's references).
- `mcp [tool] [json]` calls the real chrome-devtools-mcp tools against any port, no session
  config edit.

## Do not

- Do not pipe `record`, `follow`, or `trace` to `head`/`tail` — they are long-running and
  print pid + paths first.
- Do not `tail -f` segment files — use `follow`.
- Do not `pkill -f chrome-devtools` — that can hit MCP servers and the CLI you are typing.
  `status` shows pids; `cleanup --kill` verifies before killing.
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
