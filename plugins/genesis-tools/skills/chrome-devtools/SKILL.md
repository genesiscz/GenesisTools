---
name: chrome-devtools
description: Drive a REAL running browser (Brave/Chrome) over the Chrome DevTools Protocol via `tools chrome-devtools` to debug things that only break in the user's own browser — auth/SSO redirect loops, OAuth and OIDC failures, "works in incognito but not for me", cookie/session corruption, stuck SPAs, CORS errors, and captured .har files. Use this WHENEVER the user says "hook into my browser", "use chrome devtools", "attach to my brave", "why does this loop", "I get redirected forever", "login fails only for me", "unknown_error", "check my cookies/localStorage/session", "trace the redirects", "read this HAR", "download the HAR", or shares a URL that misbehaves while logged in. Also use it when the user's OWN Network tab shows requests no other log has — "my network tab has 600 rows but you see nothing", "read what's already in my devtools", "I had devtools open the whole time" — that history lives only in the panel's NetworkLog and `net-panel` is the only way to read it. Also use it PROACTIVELY when a bug reproduces for the user but not on a clean profile — the differential (broken browser vs fresh profile) is the fastest root cause there is. Covers launching a CDP endpoint, retroactive HAR capture, live channel following, CDP scripting, and HAR analysis via tools har-analyzer.
---

# Chrome DevTools debugging harness

Attach to the browser where the bug actually lives. Read the raw redirect chain, all
cookies (including httpOnly ones page JS can never see), and storage. Then diff a broken
browser against a working fresh profile. Everything runs through **`tools chrome-devtools`**;
`--readme` prints the full docs, every verb has `--help`, and wrong invocations print the
right one.

## Non-negotiable first fact

`--remote-debugging-port` is parsed at browser STARTUP. It cannot be enabled on a running
browser. Any plan that assumes "just attach to their open Brave" is wrong until the browser
is relaunched with the flag.

```bash
# A) reuse the real profile — restart quits, waits for exit, then relaunches with the flag
tools chrome-devtools restart --browser brave --port 9222

# B) throwaway profile alongside their browser — nothing of theirs touched, but they must log in again
tools chrome-devtools open --browser chrome --port 9223 --fresh <url>
```

### 🛑 A slow quit is NOT a failed quit

A page with a `beforeunload` handler (a live streaming/testing session is the classic one)
makes the browser ask the user to confirm before it closes. That prompt can hold the process
for tens of seconds. `restart` polls for real exit for **45s** and reports why the wait is
happening; only past that deadline does it mention `--force`.

If you see it still waiting, **look at the browser and answer the prompt**. That is the fix.
`--force` is `kill -KILL` on a browser that is already shutting down cleanly, and it costs
the session restore that was the whole reason for choosing option A.

### The profile picker, which used to eat the other half of the restart

On a multi-profile browser a plain relaunch opens **"Who's using Brave?"** beside the real
window, so `restart` handed back a browser the user still had to finish launching by hand.
`restart` now reads `profile.last_used` from the browser's own `Local State` and passes
`--profile-directory=<dir>`, so no picker appears and no Accessibility grant is needed.
Override with `--profile-directory 'Profile 1'`. A `last_used` naming a profile that is not
on disk is refused rather than passed on, because an unknown name makes the browser create a
brand new empty profile — which looks exactly like the logged-out browser you were avoiding.

### What a verified-good restart looks like

Every run now ends with its own end-state block, so nobody has to reach for `curl` or an
AppleScript window walk:

```
up: Brave/152.1.94.117 on 9222 (3 pages)
verify: port 9222 answers (Brave/152.1.94.117) · 3 page target(s)
verify: no profile picker is open.
```

A picker still open is reported as such, with a copy-pasteable dismissal, and the verb exits
non-zero — a browser behind a picker is not ready to drive, and must never be reported as a
success. A tab list that did not answer exits non-zero too: the picker check never ran on
that path, so "no picker" would be a claim nothing checked.

Ask which before quitting anything. Losing their tab set without warning is the one thing
they will be annoyed about. Do not `osascript quit` + `open -a`: `open -a` reuses the live
process and ignores the flag. ⚠️ Chrome ≥136 refuses the flag on the DEFAULT profile dir;
`restart` detects that and suggests two fallbacks: `open --fresh` (throwaway, log in every
time) and `open --user-data-dir ~/.genesis-tools/chrome-devtools/<browser>/profile` (a persistent
separate profile, one directory per browser, logins survive between runs; the only way to keep
sessions on Chrome ≥136). The persistent profile keeps Chrome's local-network checks; only
`--fresh` and `--extension` run with them disabled.

## Start here, every time

```bash
tools chrome-devtools attach     # scans 9222-9230 + lsof + DevToolsActivePort
```

If two or more Chromium browsers are open, `attach` exits 1 and lists each app with its
exact restart command; pass `--port` to pick. Once `attach --port N` succeeds, later verbs
need no `--port` — they reuse that endpoint while it is live. With several live endpoints
and nothing remembered, a verb exits 1 naming the ports rather than guessing. `attach` also
starts the **background recorder** for each listed endpoint (one per port, pidfile-deduped across concurrent agent
sessions, dies when the browser's CDP endpoint dies) and prints a guidance block with the
next commands. That recorder is what makes retroactive HAR possible.

## One engine, two views

- **`record`** — the capture engine. Background process, browser-wide (`--all-tabs`) or
  scoped (`--match <substr>`), HAR-grade metadata into a rolling 4-hour buffer. Extra
  capture channels: `--channels +ws,body,storage`. Stop: `record --port N --stop`.
- **`follow`** — the live view. `--channels nav,doc,redirect,xhr,ws,console,error,cookie,body,storage`,
  `--match substr|/regex/`, `--last 10m` to replay first. Prints Monitor-ready commands
  before streaming, so you can arm a Monitor and THEN reproduce.
- **`har`** — the retroactive view. `har --last 30m -o /tmp/cdp.har` dumps what already
  happened; `har --now --reload` records a fresh load of one tab WITH bodies;
  `--sanitize` redacts secrets; `--analyze` chains into `tools har-analyzer load`.

The old `watch` verb is gone; running it explains this split.

## 🛑 THREE network logs exist. Pick by what you need to SEE, not by habit

A request lives in whichever log was already collecting when it happened. Nothing
backfills: a second `Network.enable` does not replay history, and rows the panel holds never
existed as events in the other two. Reach for the wrong one and you conclude "there is no
traffic" about a browser that recorded 600 requests.

| Log | Verb | Covers | Blind to |
|---|---|---|---|
| Recorder buffer | `har --last 30m` | everything since **this tool's** recorder started, all tabs, rolling 4h | anything before `attach` ran |
| MCP attach log | `mcp__chrome-devtools-mcp__list_network_requests` | everything since **that MCP session** attached, in its own browser | the user's browser; anything before its attach |
| Panel `NetworkLog` | `net-panel` | what the user's **own open Network tab** is showing, back to when they opened it with Preserve log | anything with DevTools closed; headers and bodies (never collected) |

**The symptom that names the third one:** the user's Network tab visibly lists hundreds of
rows, and `list_network_requests` comes back empty, or `har` dumps only the last minute.
Observed live: the panel held **631** rows while the MCP list returned nothing. Only
`net-panel` can read those, because DevTools collected them into its own frontend and no
CDP client was attached at the time.

```bash
# --match names the INSPECTED tab; the DevTools window is then resolved by TITLE
tools chrome-devtools net-panel --match app.example.com --summary
tools chrome-devtools net-panel --match app.example.com -o /tmp/panel.har
```

Use it when the user already had DevTools open through the bug and you arrived afterwards.
Do NOT reload their tab to "get a proper capture": the reload destroys exactly the history
you came for. If DevTools was never open, this log does not exist — say so and start a
recorder for the next reproduction instead.

⚠️ **The title-match trap.** Every open inspector reports the same URL,
`devtools://devtools/bundled/devtools_app.html`, so picking by URL grabs whichever happens
to be first and silently dumps a DIFFERENT tab's log. The window title (`DevTools - <host><path>`)
is the only discriminator, and on Brave these targets report `type: "page"`, so type cannot
classify them either. `--match` on a page substring walks to that page's inspector by title;
`--match 'DevTools - app.example.com'` names the inspector outright. When the match is
ambiguous the verb refuses and lists the candidates rather than guessing — on either side
of the walk: several matching TABS, or one tab that several inspectors tie to. The `--match`
it prints names the candidate that resolves, not merely the first one, because one candidate
is routinely a substring of another.

⚠️ **One inspector on a SHORTER path is accepted, with a warning.** DevTools truncates a long
title, and a truncated title is a prefix of the page subject — so a lone prefix candidate has
to stay usable. An inspector open on the site ROOT looks identical, though, so if you see
`'DevTools - <host>' does not name <url> exactly`, the panel you are about to read may belong
to a different tab. Check the inspector named in the output, and open DevTools on the tab you
actually want rather than trusting the fallback.

**Sanitized by default, and it cannot leak headers.** Summary URLs are cut to
origin+pathname, so an OIDC `?code=` or an implicit-flow `#access_token=` never reaches
stdout. `-o file.har` carries no headers, no cookies and no POST bodies at all — the eval
never collects them, so no flag can make them appear. `--full-urls` keeps query strings and
runs them through the shared HAR sanitizer instead. It does NOT widen `data:` or
`javascript:` urls: those are their own payload, the sanitizer only redacts `?name=value`
pairs and the fragment, so they stay reduced to a scheme marker under every flag.

It is read-only: one `Runtime.evaluate` against the DevTools frontend. No reload, no
navigate, no `Network.enable`, no panel switching. Running it cannot change what the user
is looking at.

> Not to be confused with `references/net-panel-symptoms.md`, which is about reading the
> panel's columns BY EYE. This verb dumps the same panel's log programmatically.

`/tmp/...` paths in the examples here are the POSIX default. On Windows the tool uses
`%TEMP%` — trust the paths the tool itself prints (guidance, doctor, `--help`) over
the literal examples.

## 🛑 `--match` sees TITLES too, so a DevTools window can win

The trap the `net-panel` section describes is not confined to `net-panel`: **every** page verb
matches on url OR title, and an open inspector's title is `DevTools - <host><path>`. So a pattern
anchored on the end of a page url, `/auth-callback\?customerService=true$/`, matches the INSPECTOR
whose title ends the same way, and `eval` runs against the DevTools frontend instead of the app.
The giveaway is an answer full of `No throttling Fast 4G Slow 4G ...`: that is the Network panel's
own DOM.

Anchor on the scheme, which no DevTools title starts with:

```bash
# grabs the inspector when DevTools is open on that tab
tools chrome-devtools eval --match '/auth-callback\?cs=true$/' '() => location.href'

# grabs the page
tools chrome-devtools eval --match '/^https:\/\/app\.example\.com\/auth-callback\?cs=true$/' '() => location.href'
```

Two open tabs on the same host where one url is a PREFIX of the other (`/col?cs=true` and
`/col?cs=true&simulatedPartner=…`) cannot be told apart by substring at all — only an anchored
regex picks the shorter one.

## 🛑 Do not pipe, do not tail raw

| Never | Why | Instead |
|---|---|---|
| `record`/`follow`/`trace` piped to `head`, `tail`, or anything that closes stdout | long-running; the pid and paths print FIRST | run_in_background + `--out` + Monitor |
| `tail -f` on `/tmp/GenesisTools/ChromeDevtools/<port>/seg-*.jsonl` | segments rotate every 30 min; your fd goes silently quiet and you conclude "no traffic" | `tools chrome-devtools follow` |
| `pkill -f chrome-devtools` | kills MCP servers and the CLI you are typing | `status` then `cleanup --kill <pid>` |
| `rm` capture dirs or the leftover buffer | that IS the retroactive HAR | `cleanup` (moves to trash), after dumping |
| `cat`/`jq` a `.har` | token bonfire | `tools har-analyzer load x.har` |

## When `mcp__chrome-devtools-mcp__*` goes away mid-session

That is normal harness behaviour, not a crash of anything here. Claude Code tears the idle
stdio server down and re-spawns it on the next tool call: its log shows
`STDIO connection closed after 126s (cleanly)` then `Cleared connection cache for
reconnection`, with no stderr beyond the npm banner and no non-zero exit
(`~/Library/Caches/claude-cli-nodejs/<project>/mcp-logs-chrome-devtools-mcp/*.jsonl`,
verified 2026-08-27 for session a6b9435f). Two consequences:

- **The CLI is unaffected and is the fallback.** `tools chrome-devtools` speaks HTTP and
  WebSocket to the browser's own port each time, so it holds no session to lose.
- **The MCP server drives its OWN isolated Chrome on an ephemeral port.** When it goes, that
  browser goes too, and its `DevToolsActivePort` files leave empty capture dirs that
  `attach` discovers later. `cleanup` removes them.

One real failure in that session was NOT a disconnect: `take_screenshot` into the session
scratchpad returned `Access denied: path … is not within any of the configured workspace
roots`. chrome-devtools-mcp 1.6.0 only writes inside a workspace root, so write MCP
screenshots into the repo, or take them with `tools chrome-devtools shot`.

Health at any time: `tools chrome-devtools status` (CPU, memory, buffer sizes) ·
`doctor` (read-only findings + fix commands) · `cleanup` (applies them, interactively in a
terminal). These rules exist because an unbounded recorder once pinned a core for hours
and left duplicate processes behind; the recorder is bounded and pid-verified now.
The tool runs on macOS, Linux and Windows; on Windows the capture root is
`%TEMP%\GenesisTools\ChromeDevtools` and `status` shows cpu-time without a live %CPU.

## Then the verbs

| Need | Command |
|---|---|
| All cookies incl. httpOnly, all domains | `cookies --domain <substr>` (`--json` to diff two browsers) |
| Raw redirect chain with `Location` + `Set-Cookie` | `follow --channels redirect,cookie --match <substr>` (live) or `har --last 10m` (retroactive) |
| Quick one-tab docs+redirect trace to a file | `trace --seconds 90 --match <substr> --out /tmp/t.log` |
| HAR of what already happened | `har --last 30m -o /tmp/cdp.har` |
| Their Network tab shows hundreds of rows that no other log has | `net-panel --match <substr> --summary` (see the three-logs table above) |
| HAR of a fresh load + bodies | `har --now --reload -o /tmp/cdp.har` |
| One-shot per-request assertion table (method/status/sizes/auth scheme) | `har --last 10m --match token --summary` |
| Read page state | `eval '() => ({url: location.href, ls: {...localStorage}, ss: {...sessionStorage}})'` — quoting trouble or a hook blocking inline eval? write the JS to a file and use `eval --file <path>` |
| Console messages incl. load-time ones | `console --match <substr> --reload` (attaches first — the MCP `list_console_messages` misses everything before ITS attach) |
| Navigate / screenshot | `nav <url>` (reuses a tab) · `nav <url> --new` (opens one) · `shot /tmp/x.png [--full]` |
| Surgical cookie delete | `rm-cookie --name X --domain Y --path /cas` |
| Pixel-coordinate grid over a screenshot | `grid /tmp/g.png [--region x,y,w,h] [--step 60]` |
| The real MCP tools, against ANY port | `mcp list` · `mcp navigate_page '{"url":"…"}'` |
| CDP scratch script | `scaffold <name> --recipe redirect-chain\|cookie-diff\|storage-snapshot\|body-fetch\|console-trap\|blank` |
| The scripting API | `cheatsheet` (or `references/cdp-cheatsheet.md`) |

Page verbs take `--match <substr|/regex/>` to pick a tab by URL or title, and ERROR within
a second when nothing matches, listing the closest open tabs; they never grab a random tab.
No tab to reuse? `nav <url> --new` opens one. `targets --match <substr>` filters the tab
list instead of printing one 40 KB JSON blob (`--json` gives the same list as JSON).

## The method that actually finds these bugs

For SSO/OIDC specifically, `references/auth-loop-playbook.md` has the federation chain
shape, the which-bad-`Location`-means-which-symptom table, and the cookie-scope regression
fingerprint.

1. **Reproduce while a recorder runs.** `attach` starts one; the buffer holds the last 4
   hours. An empty `har` means the recorder started after the action, not that nothing
   happened.
2. **Read the raw 302 chain, not the MCP request list.** `redirectResponse` carries the
   `Location` and `Set-Cookie` that a flat list hides. The bug is usually one hop whose
   `Location` is wrong (missing `?code=`/`?state=`, or pointing back at the app instead of
   the IdP callback).
3. **Diff broken vs working.** Launch a fresh-profile browser on another port
   (`open --fresh --port 9223`), have the user do the same flow there. If it works, the
   poison is in their browser state, and `cookies --json` on both ports is the whole answer.
4. **Compare by (name, domain, path), never by name.** Duplicate cookie names on different
   paths are the classic killer: RFC 6265 sends the longer path FIRST, servers that read
   the first value bind to a stale session. A host-only `path=/cas` leftover next to a
   current `domain=.x.cz path=/` cookie is exactly this.
5. **Confirm by surgical deletion.** `rm-cookie` only the suspects, re-run the flow.
   Working = proof, and it fixes the user's browser. Never "clear site data" — that
   destroys the evidence and their logins.
6. **Know what you cannot forge.** Injecting fake stale cookies usually does NOT reproduce
   a session bug: servers tolerate unknown session ids, and signed artifacts (CAS `TGC`,
   delegation JWTs) cannot be minted client-side. Reliable repro of those is server-side.
   Say so rather than claiming a failed injection exonerates anything.

## When the trace is not enough — network and wire forensics

Read the file named, jumping to the section given. The table below is
the full symptom index.

| You see | Read |
|---|---|
| `(unknown)` Type · `(canceled)` · `(blocked:other)` · `(failed)` · XHR status 0 | `net-panel-symptoms.md` 1.2 |
| Response body missing/empty even with Preserve log on | `net-panel-symptoms.md` 2.1 |
| **Token/OAuth POST whose body vanished** — a navigation aborted it mid-flight | `net-panel-symptoms.md` 2.6 |
| Opaque / CORB-stripped cross-origin response | `net-panel-symptoms.md` 2.5 |
| Live panel and exported HAR disagree | `net-panel-symptoms.md` 1.5 |
| Need more capture: settings, columns, experiments, starting a raw log | `net-capture-settings.md` 3.1-3.7 |
| Brave Shields / fingerprinting may be altering requests | `net-capture-settings.md` 3.9 |
| `(unknown)` Type with an odd Size or Initiator | `net-panel-symptoms.md` 1.3-1.4 |
| What HAR cannot capture at all (below HTTP) | `net-export-recipes.md` 4 |
| Grep a net-export log for one URL's whole lifecycle | `net-export-recipes.md` 5.2-5.3 |
| Find the numeric net error behind a `(canceled)` | `net-export-recipes.md` 5.4 |
| Need what panel AND HAR cannot see: socket bytes, DNS, TLS, preflight verdict, the numeric net error behind a cancel | `net-export-recipes.md` 4, 5.2-5.4 |
| OAuth token endpoint, end to end | `net-export-recipes.md` 5.6 |
| When did this start / how often did the user loop | `recipes.md` "Browsing history" — 🛑 `strftime('%s')` returns TEXT, so an epoch `BETWEEN` is silently always false (0 rows, no error) |

Two facts that change conclusions, so carry them always: Chrome does not stream body bytes
to DevTools until you view them and a navigation destroys the in-memory copy (a missing
body is usually THIS, not the server); and a HAR is a DevTools-level artifact, so
everything below HTTP exists only in a net-export log.

Two facts to carry into every investigation:

- Chrome withholds body bytes from DevTools until viewed; a navigation destroys the copy.
- Anything below HTTP is invisible to both the panel and HAR — only net-export has it.

## HAR files

Never `cat`/`jq` a .har. Use `tools har-analyzer` (the `analyze-har` skill has the full
command set):

```bash
tools har-analyzer load capture.har        # dashboard first, always
tools har-analyzer errors                  # 4xx/5xx
tools har-analyzer redirects               # chains (may under-report; cross-check Location headers)
tools har-analyzer search "<pattern>" --scope url|body
tools har-analyzer show e638 --raw | rg -o 'location: [^\n]*'   # THE money line for auth bugs
```

🛑 A HAR of a login flow contains the plaintext password in the POST body and live session
tokens. Before it leaves the machine: `tools chrome-devtools har --sanitize`, or
`tools har-analyzer export --sanitize --strip-bodies -o clean.har`. Warn the user
explicitly; do not paste secrets into shell commands (they land in shell history and agent
transcripts).

## Extension debugging

The YouTube extension has its own harness (`src/youtube/lib/devtools/`), which adds
watch-and-reload on top of what this tool does:

```bash
tools youtube extension dev                            # rebuild + chrome.runtime.reload on change
tools youtube extension devtools launch --port 9333    # browser WITH the extension loaded
```

Use `tools chrome-devtools open --extension <dist>` for plain extension loading.
Plain extension loading: `tools chrome-devtools open --extension <dist-dir>`.

## Writing it up

Reports for a third party (an IdP team, another vendor) need: the numbered hop-by-hop chain
with real URLs, the exact hop that misbehaves and what it SHOULD have returned, the
cookie-diff table (working vs broken), the mechanism in two sentences, a concrete
server-side fix, and the client-side workaround. Attach the sanitized HAR only.
