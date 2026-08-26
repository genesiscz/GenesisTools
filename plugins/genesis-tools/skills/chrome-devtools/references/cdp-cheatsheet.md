# CDP scripting cheatsheet (`tools chrome-devtools`)

Printable any time: `tools chrome-devtools cheatsheet`. Scratch scripts:
`tools chrome-devtools scaffold <name> --recipe <r>` → lands in the `tools scripts` store,
run with `tools scripts run <name> -- --port 9222`.

## Verbs, one line each

```
attach                        scan endpoints, start the background recorder, print next steps
record  --match X|--all-tabs  the capture engine (one per port; --stop; --channels +ws,body,storage)
follow  --channels a,b        live view over the buffer (+ Monitor hints; rotation-aware)
har     [--last 30m|--now]    DevTools-grade HAR from the buffer, or a live window with bodies
status | doctor | cleanup     inventory (CPU/mem) | read-only diagnosis | guided fixes
cookies --domain X [--json]   ALL cookies incl. httpOnly, every domain
console --match X --reload    console messages incl. load-time ones (attaches first)
eval '() => …'                run JS in the tab, JSON out
nav <url> | shot [png]        navigate | screenshot (--full)
grid [png] --step 60          screenshot with pixel-coordinate grid (for clicking into pages)
trace --match X               quick one-tab docs+redirect chain to a file
targets                       raw /json/list
open --fresh | restart        launch/relaunch a browser WITH the debugging flag
mcp <tool> '<json>'           call real chrome-devtools-mcp tools on any port
```

## Channel vocabulary

Capture (`record --channels`, cost real CPU/calls): `net`(always) `console`(default)
`ws`(frames) `body`(≤2 KB fetch) `storage`(snapshot per nav).
Render (`follow --channels`): `nav doc redirect xhr ws console error cookie body storage`.
Rendering is free, but `ws`/`body`/`storage` (and `console`/`error`) only show data the
recorder captured — follow prints the exact `record` restart command when the capture
channel is off. For a one-off live storage read, skip the buffer: use the `eval` verb or
the `storage-snapshot` recipe.

## Do-not-pipe table

| Never do | Why | Instead |
|---|---|---|
| `record … \| head` / `follow … \| tail` | long-running; they print their pid and paths FIRST, then keep going | run with run_in_background, read `--out`, arm a Monitor |
| `tail -f /tmp/GenesisTools/ChromeDevtools/<port>/seg-*.jsonl` | segments rotate every 30 min; the fd goes silently quiet | `tools chrome-devtools follow` |
| `pkill -f chrome-devtools` | hits MCP servers and the CLI you are typing | `status`, then `cleanup --kill <pid>` |
| `cat`/`jq` a `.har` | token bonfire | `tools har-analyzer load x.har` |
| `rm` the capture dir | it is the retroactive HAR | `cleanup --dir <port>` (moves to trash) |

## cdp lib API (`@gt/chrome-devtools/cdp` in scaffolded scripts)

```ts
import { attach, browser, targets } from "@gt/chrome-devtools/cdp";

const page = await attach({ port: 9222, url: "app.example.com" }); // url substring MUST match
page.navigate(url) · page.reload(ignoreCache?) · page.evaluate("() => …")
page.screenshot(path, fullPage?) · page.resize(w, h) · page.onConsole((level, text) => …)
page.recordNetwork(urlFilter?)   // LIVE array; keeps redirectResponse hops (status/from/location/setCookie)
page.responseBody(requestId) · page.waitForText(["Ready"], 15000)

const b = await browser(9222);   // browser-level: cookies across ALL domains incl. httpOnly
b.cookies("idp.example.com") · b.setCookies([...]) · b.deleteCookie(name, domain, path)
b.deleteCookiesMatching(c => c.path === "/legacy")   // returns what was deleted
```

`recordNetwork` event kinds: `request` (type/method/url/postData/requestId) · `redirect`
(status/from/location/setCookie[]) · `response` (status/url/headers/requestId) · `failed` ·
`nav` (main frame only).

## Recipes (scaffold --recipe …)

`redirect-chain` live 302 chain while reproducing · `cookie-diff` broken-vs-fresh browser by
(name,domain,path) with duplicate-name detection · `storage-snapshot` ls/ss dump ·
`body-fetch` bodies of matching responses · `console-trap` console+exceptions around an
action · `blank` empty scratch with targets list.

## Method reminders (from the SKILL — the bugs live here)

- Attach BEFORE the action; CDP starts empty and bodies die on navigation.
- Read the raw 302 chain (`redirect` events), not a flat request list.
- Diff broken vs fresh profile; compare cookies by (name, domain, path), never by name.
- Confirm by surgical deletion (`rm-cookie`), never "clear site data".
- A duplicate cookie name on different paths means the longer path is sent FIRST
  (RFC 6265), so the stale session wins.
