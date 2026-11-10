# tools browser-router

`tools browser-router` makes GenesisTools.app this Mac's http(s) handler and manages the routes it applies to every
clicked link (rewrite, another browser, start a local server, run a saved command; the rest goes to your browser). Use
it to make `localhost`, `genesis-md://` and command links clickable from notes, chats and agent replies.

## Quick start

```bash
# Build GenesisTools.app, make it the http(s) handler, and pick a link host
tools browser-router install
# Who handles https, the link host, the presets and the browser extension
tools browser-router status
# A click on a registered localhost port starts that server first
tools browser-router presets enable local-services
# What a click on this URL would do, without doing it
tools browser-router explain 'http://localhost:3042/qa'
# Rewrite the local links in a note into links a click routes
tools browser-router links --convert notes.md
# One link that opens several pages at once
tools browser-router tabs mint https://a.example.com https://b.example.com
```

## Commands

`tools browser-router` with no arguments runs `status`. `-v, --verbose` turns on verbose logging, and `--readme`
prints this page.

### Set up and check

- `install`: builds, signs and installs `~/Applications/GenesisTools.app` (the same build as `bun run app`), writes
  `config.json` when it is missing, rewrites the preset routes, and runs `GenesisTools --default-browser set`. macOS
  shows its own "change your default browser?" dialog. In a terminal, `install` then asks for a link host. It ends
  with the state of the browser extension.
- `uninstall`: gives http and https back to the browser recorded in `previous.json` at install time. The app stays.
- `status`: the config path, the app's own `bundle=` and `https=` lines, the route count, the link host, the presets
  whose links work now, each preset's drift with its fix, and one line per GenesisTools browser extension. It starts
  GenesisTools.app once to ask it who handles https.
- `status --json`: the same facts as JSON, read-only and fast (one `plutil` call, the config, each browser profile's
  preferences). Skills call it before they print a link.
- `link-host [host]`: with no argument, prints the link host. With a host, sets it after a confirmation, and
  rewrites the preset routes. `--accept-risk` skips the confirmation and is required without a terminal. `--unset`
  removes the link host, and no links are printed afterwards.
- `browser <url> --json`: names the default browser and the browser a click on that URL really reaches (through
  the routes when the router is the default): `{ defaultBrowser, defaultBrowserEffective, viaRouter }`, each browser
  as `{ name, bundleId, appPath }`. Code calls `resolveDefaultBrowsers(url)`
  (`src/utils/browser-router/default-browser.ts`).

### Presets

- `presets`: a table of every preset with its kind, its state (`on`, `off`, or `needs <what>`) and what a click does.
  It warns about a preset the config switches on that this Mac cannot serve.
- `presets enable <id>`: switches an installable preset on and writes its routes. `--only <keys>` (comma-separated
  registry keys) narrows `local-services` and `dashboard-names`. `--name <name=key>` (repeatable) gives a registry
  dashboard an extra name for `dashboard-names`. Running it again replaces the options.
- `presets disable <id>`: switches an installable preset off and removes its routes.
- `presets sync`: rewrites the saved routes from the presets. Run it after a registry change, a link host change
  made by hand, or a hand edit of a preset route.
- `presets configure`: one checklist of the installable presets in a terminal, then a prompt for each option. A
  preset this Mac cannot serve is listed with what it needs instead of being offered. Without a terminal it exits 1
  and prints one `presets enable` or `presets disable` command per preset.

### Routes

- `routes`: a table of the saved routes: pattern, name, action, preset, and whether the preset can fire on this Mac
  (`yes` or `stale`). `--format json` prints the raw `routes` array.
- `route <pattern>`: saves one route, or replaces the route with the same pattern. The flags are below.
- `explain <url>`: prints what a click on the URL would do, without doing it. `--json` prints the whole decision.
  It never spends a minted link.
- `open <url>`: applies the routes and acts. It spends one use of a minted link. A route that asks first is
  refused here, because only GenesisTools.app shows the Allow card.

`route` takes exactly one action: `--route-to`, `--browser` (alone or with `--route-to`), `--run`, or `--tool`.

| Flag | What it does |
|---|---|
| `--route-to <template>` | Rewrite to this URL. `$1` is the first capture, `$$` a dollar. |
| `--browser <app>` | Open in this app: a name, a bundle id or a path. |
| `--run <program>` | Run this program with the `--arg` values. Never a shell. |
| `--tool <name>` | Record a GenesisTools tool. It is shown, never run. |
| `--arg <template>` | One argument for `--run` or `--tool` (repeatable). |
| `--approval <mode>` | `ask` (the Allow card, default) or `allow`. |
| `--touch-id` | Touch ID or the Mac password before `--run`. |
| `--open <url>` | After a successful `--run`, open this http(s) URL. |
| `--notify <text>` | After a successful `--run`, show this text. |
| `--name <text>` | The headline on the route's card. |
| `--no-toast` | No card for this route. |
| `--toast-seconds <n>` | How long the card stays. |
| `--toast-title <text>` | Replaces "Opening" or "Running" on the card. |
| `--delete` | Remove the route with exactly this pattern. |

```bash
# A URL with :name placeholders; {name} in a template is that capture
tools browser-router route 'https://links.example.com/hello/:name' --route-to 'https://example.com/{name}'
# A local server's button that runs a script without asking
tools browser-router route 'http://127.0.0.1:8787/add/:id' \
  --run /opt/shop/shop.ts \
  --arg add \
  --arg '{id}' \
  --arg --qty \
  --arg '{qty}' \
  --notify 'Added' \
  --approval allow
# Try the hello route: explain shows the rewrite to https://example.com/world, open follows it
tools browser-router explain 'https://links.example.com/hello/world' --json
tools browser-router open 'https://links.example.com/hello/world'
# Then remove it by the exact saved pattern (read it back with routes --format json)
tools browser-router route 'https://links\.example\.com/hello/([^/?#&]+)' --delete
```

### Links for notes, chats and agents

- `links --convert <file>`: prints the markdown with every local link rewritten into a link on the link host.
  `-` reads stdin. `--uses <count>` mints each local link as a one-use token that works that many times; without
  it, the link is stable. It writes the default config when there is none, and it warns when it changed a link
  while the browser extension is not loaded.
- `tabs save <name> [urls...]`: saves a named bundle and prints `https://<link host>/tabs/<name>`, a stable link
  that opens every page each time. A name starts with a letter or digit, then letters, digits, `_` or `-`. Saving
  under an existing name replaces that bundle.
- `tabs mint [urls...]`: prints one minted link, `https://<link host>/t/<id>`, that opens every URL. `--uses <count>`
  sets how many clicks it survives (default 1).
- `tabs save` and `tabs mint` take `--from-md <file>` (or `-` for stdin): every http(s) link in that note is added,
  in order, without repeats, outside code fences.
- `tabs list`: every saved bundle with its link count and link.
- `tabs open <name>` and `token open <id>`: what GenesisTools.app runs on a click of a bundle link or a minted link.
  You rarely run them by hand.

What `links --convert` rewrites:

- A local link is a `localhost`, `127.0.0.1` or `::1` link, a link to a `.local`, `.localhost` or `.internal` host,
  or a `genesis-md://` link. Ordinary websites, other schemes, links already on the link host, and everything in a
  code fence stay as written.
- Markdown links, `<autolinks>` and bare `genesis-md://` URLs are rewritten. A bare `http://localhost/...` in plain
  text is not, so put it in a markdown link.
- With `--uses`, each local link becomes a minted `/t/<id>` link. Without it, the link becomes the https URL that a
  saved `open` route turns back into it (`genesis-md://a` becomes `https://<linkHost>/md/a` while `genesis-md` is
  on), else a wrapped `https://<linkHost>/link/<encoded link>`.
- A `/link/` URL arrives from any app with no prompt, so it only ever opens an http(s) or `genesis-md` link.

What a click on a bundle link does:

- Above 15 links a dialog asks "Open N tabs?" first. It gives up after two minutes, which counts as Cancel.
- Plain pages open in one new window of their browser. Brave, Chrome, Chromium, Edge and Vivaldi get a real new
  window; Safari and other browsers get the pages as tabs in their front window.
- A link with a route of its own (an action on the link host, a minted link) is routed as if it was clicked.
- A bundle link inside a bundle is skipped, so a bundle cannot open itself. A link a route swallows is skipped too.

```bash
tools browser-router links --convert notes.md
tools browser-router links --convert notes.md --uses 3
tools browser-router tabs save morning https://a.example.com https://b.example.com
tools browser-router tabs mint --from-md standup.md
tools browser-router tabs list
```

### Local servers

- `ensure <port>`: starts the registered server on that port (`src/utils/ui/dashboards.ts`) when nothing listens
  there, and waits up to 20 seconds. It prints `started <name>` or `<name> is up`. Exit 0 when the port listens,
  1 on a timeout (the message names the log) or a bad port, 2 when the port is not registered or has no launch
  command.

```bash
tools browser-router ensure 3042
```

## How it works

### GenesisTools.app is the router

There is no separate router app, and nothing listens on a port for it. A click starts a short-lived GenesisTools
process that reads `config.json`, decides, shows a card, acts, and quits after the card fades (at most after 600
seconds). The decision logic is TypeScript (`src/utils/browser-router/route.ts`) for the CLI, and a Swift copy
(`native/Router.swift`) runs inside the app for speed. `lib/swift-parity.test.ts` compiles the Swift copy on macOS
and checks that both decide the same. The standalone "Genesis Router.app" is retired: an old copy of it was rebuilt
on 2026-09-24 and took the https handler from GenesisTools.app. Never build or install another handler app.

### Two ways a link reaches the router

**A link clicked in another app** (Mail, Slack, a terminal's `open https://...`, a PDF) goes through macOS Launch
Services. Once `install` made GenesisTools.app the http and https handler, macOS delivers the URL to it as an Apple
Event (`kAEGetURL`, handled by `installBrowserURLHandler` in `src/macos/GenesisTools/Sources/Host/BrowserURL.swift`).
Nothing else is needed.

**A URL typed into a browser's address bar, or a link clicked inside a web page, never reaches GenesisTools.app that
way.** A browser handles its own navigation and never asks macOS who owns https. For that case the GenesisTools
browser extension (`src/browser-extension`) is needed. It redirects a navigation to the router's hosts (the link
host, alias hosts, dashboard names) to an internal confirmation page before any request leaves the browser. That
page asks the router (`explain`, through a native messaging host) what the link would do, and hands it to
GenesisTools.app with `open -b com.genesiscz.genesistools <url>`. A bare word such as `dashboard` is a search, not an
address, so the extension also catches a search whose whole query is one of those hosts. A typed loopback address or
dashboard name starts a server only for a registry entry flagged safe for that; the
[browser-extension README](../browser-extension/README.md) has the rules.

### What a click does

1. The URL is cleaned (when `clean` is on): Outlook safelinks, Google `/url?q=`, and Slack and Teams redirectors are
   unwrapped, up to five levels deep, and `utm_*`, `fbclid`, `gclid` and `mc_eid` are removed.
2. An alias renames the host, so it wins over any route for the old name.
3. The routes are tried in order, and the first match wins. No match sends the link to `defaultBrowser`.
4. A card appears in the bottom-left corner of the screen under the mouse: the GenesisTools mark, "Opening" or
   "Running", and a short log. It fades after `toast.seconds`.
5. A `run` route with `touchId` asks for Touch ID or the Mac password first. A route that asks shows the Allow / Deny
   card: a click allows, Esc denies, and Return does nothing, because you may still be typing elsewhere. Every
   decision on a `run` route goes to the gate audit file.
6. When the config cannot be read, or the action fails without a card, the app shows a notification and opens the
   link in the browser recorded in `previous.json` (else Brave, else Safari), so a broken config never eats a link.
   A used-up minted link is not opened.

GenesisTools.app looks up a bare program name in a `run` route on the PATH of a login shell, with `~/.bun/bin`,
`/opt/homebrew/bin` and `/usr/local/bin` in front. A script whose first line names `env` and `bun` runs through
`bun`. The argv never meets a shell, so `~`, `$HOME`, quotes and globs are passed as written.

When the hub or a review window is open, a windowless link relay (`GenesisTools --link-relay`) takes each delivery
instead, hands it to a fresh router process (`BrowserURLForwarder` in
`src/macos/GenesisTools/Sources/Host/BrowserURL.swift`), and gives the focus back to the app you clicked in. Launch Services
hands a link to the oldest running instance and raises it, so before the relay a click on a note link raised the hub
over your app (2026-10-07).

### Where state lives

Everything the router keeps is under `~/.genesis-tools/browser-router/`:

- `config.json`: the config. GenesisTools.app reads it on every click, so it is always written as a temp file plus a
  rename, under `config.json.lock`.
- `tokens.json`: minted links from `links --convert --uses` and `tabs mint`. Mode `0600`, because a token is a
  bearer credential (a minted link may skip its Allow card). An id is 72 random bits, and a spent token is deleted.
- `bundles.json`: named bundles from `tabs save`. A malformed file is never overwritten: `tabs save` refuses and
  asks you to fix or move it aside.
- `previous.json`: the handler https had before `install`, for `uninstall` and the fallback browser. When another
  link router held https at install time (Finicky, the retired router app), Brave is recorded instead. A record
  that is already there is kept, so a second `install` does not overwrite it.
- `link-gate.json`: the router facts a printed link needs, cached for hooks. It is reused for 30 minutes, and a
  changed `config.json` makes it stale at once.

Other files it writes or reads:

- `~/.genesis-tools/audit/gates.jsonl`: one line per decision on a run route (Touch ID, the Allow card, or a route
  that runs without asking), with the link, the route index and the argv. The app and the CLI both write it.
- `~/.genesis-tools/app/link-relay.log`: what the link relay did with each delivery.
- `~/.genesis-tools/logs/app-perf.log`: the app's lines about forwarded links and focus.
- `~/.genesis-tools/logs/<date>.log`: the CLI's own log, and the log of a server that `ensure` started.

Older notes name `router.log` here. Nothing in this repository writes that file, so it is not a record of current
clicks.

### What it needs

macOS, and GenesisTools.app built from this checkout. `install` builds the app, so it needs the same Swift toolchain
as `bun run app`. Some presets need more (cmux, the `claude` CLI, Genesis Markdown); `presets` names what is missing.
Nothing here calls a paid service.

### Setup on a new Mac

After `git clone`, `bun install` and `./install.sh` (then open a new shell so `tools` is on PATH):

1. `tools browser-router install`. Confirm the macOS dialog. Links no route claims open in `defaultBrowser`.
   `tools browser-router uninstall` gives https back to the previous handler.
2. In a terminal, `install` asks for a link host (see [The link host](#the-link-host)). Later:
   `tools browser-router link-host <host>`.
3. Switch on the presets you want: `tools browser-router presets`, then `tools browser-router presets enable <id>`.
4. `tools browser-router status` must show `https=` with GenesisTools.app.
5. Optional, for links typed in a browser: the extension.
   - `tools browser-extension build` writes `dist/browser-extension`, with host permissions for the router's hosts in
     the current config.
   - `tools browser-extension install-host` registers the native messaging host for Brave, Chrome and Chromium.
   - In `brave://extensions` (or `chrome://extensions`), turn on Developer mode, click Load unpacked, and pick
     `dist/browser-extension`.
   - A new link host, alias or preset changes the hosts, so build again. `build` reloads the extension itself when
     the browser has a DevTools port (`tools browser-extension reload` does only that step); otherwise click Reload
     on the GenesisTools card in the extensions page.

## Configuration

### config.json

`~/.genesis-tools/browser-router/config.json`. Edit it with the commands where you can. A hand edit takes effect on
the next click.

- `defaultBrowser` (required): where a link no route claims goes. A string (an app name, a bundle id or a path, told
  apart by its shape) or `{ "name", "appType", "openInBackground" }`, where `appType` is `appName`, `bundleId`,
  `path` or `none` (`none` swallows the link). A new config picks Brave when `/Applications/Brave Browser.app`
  exists, else Chrome, else Safari.
- `linkHost`: the host every printed link is built on. Unset means no link is printed.
- `presets`: the installable presets switched on, each with its options (`{}` for none).
- `routes`: the routes, tried in order.
- `aliases`: `[{ "host", "base" }]`, host renames applied before the routes. `allowAliases: false` ignores them.
- `toast`: the card for every route, `{ "enabled", "seconds", "title" }` or `false`. Default `enabled: true`,
  `seconds: 5`. A route's own `toast` overrides it, field by field.
- `clean`: unwrap redirectors and strip tracking parameters. Default `true`.

`GENESIS_TOOLS_HOME` moves the whole `~/.genesis-tools` tree (the tests use it). The CLI and the app's router both
read it. GenesisTools.app itself stays in `~/Applications`.

The TypeScript side (`explain`, `routes` and every writer) refuses a config with one invalid route and names
`routes[N]`. GenesisTools.app skips that one route and keeps routing with the others, because failing the whole
config once made every link on the Mac fall back (2026-09-24, a `token` route read by an app built before `token`
existed).

### The link host

Every link GenesisTools prints is built on `linkHost`: `https://<linkHost>/t/<id>` (minted links), `/tabs/<name>`
(bundles), `/link/<url>` (wrapped local links), and the preset paths below. Without a link host no link is printed,
and the presets built on it are unavailable.

A link the router does not catch (opened on a phone, on another computer, or in a browser without the extension)
goes to whoever serves that host, path and all, and a minted link's path is a one-use token. So `link-host` asks for
confirmation (or `--accept-risk` without a terminal). Pick a host you control when you can.

### Presets

A preset is a set of routes the router writes for you. `default` presets are on whenever they can be; `installable`
presets are off until you switch them on. Only `core` is a default preset. `presets` lists every one with its state
and what it needs.

The enabled presets are saved in `config.presets`, and the routes are derived from them: the default presets'
routes first, then your own routes, then the installable presets' routes in the order below. A route of your own
with the same pattern as a preset route replaces it. A route that a preset wrote carries a `preset` tag and is
rewritten on every sync, so do not edit it by hand: `status` reports such a route as drift, with the fix.

- `core` (default, needs the link host): minted links (`/t/`), bundles (`/tabs/`) and wrapped local links (`/link/`).
- `local-services`: a click on `localhost:<port>` or `127.0.0.1:<port>` of a registered server runs `ensure <port>`
  first. A running server opens at once. A stopped one is started, the card says "Starting <name>" until the port
  listens (20 seconds at most), then "Opening". On a timeout the card shows the error and the log path, and the dead
  page is not opened. These routes run without asking, because they only start a known local server. Option `only`.
- `genesis-md`: `https://<linkHost>/md/<path>` opens `genesis-md://<path>` in Genesis Markdown. It needs the app,
  found by Launch Services by its bundle id. A `genesis-md://` link itself opens without this preset.
- `finder` (macOS): `https://<linkHost>/finder/reveal?target=<path>` shows that file or folder in Finder (`open -R`).
- `genesis-hub`: `https://<linkHost>/hub?<query>` opens `genesis-tools://hub?<query>` in the GenesisTools hub: a PR,
  a commit or a range of commits in it, or a session, for example `hub?pr=owner%2Frepo%2342&commit=4e7a3bc`.
- `mail` (macOS): `https://<linkHost>/mail/show/<rowid>` runs `tools macos mail open <rowid>`.
- `meetings-play` (macOS): `https://<linkHost>/meetings/play?meeting=<id>&at=<time>` runs
  `tools meetings play <id> --at <time>`, which plays the meeting's audio from that time.
- `decide` (needs the `claude` CLI): `https://<linkHost>/decide/<session>/<n>/<letter>` types that answer into a
  live Claude session with `tools claude decide`, without an Allow card. `?q=<form id>` also closes a pending
  `tools question` form. The URL carries only a session id, a number and one letter; anything else does not match.
- `claude-find` (needs `claude` and cmux): `https://<linkHost>/claude/find/<session>/decision/<n>` shows where that
  DECISION was first asked: the running widget shows its popup (`tools hub widget show-decision`), and without a
  widget the session's chat scrolls there. `.../claude/find/<session>?q=<text>&at=oldest|newest` finds any text in
  the transcript view (`tools claude cmux find`); it asks first, unless the link was minted on this Mac with
  `tools claude cmux find <session> <text> --link`. Every DECISION section that `question_post` writes carries a
  "show in chat" link while this preset is on.
- `cmux-claude` (needs cmux and GenesisTools.app): `https://<linkHost>/cmux/claude/run?prompt=...` starts Claude in
  a new cmux surface (`tools cmux launch --open`), after the Allow card. The query also takes `agent`, `account`,
  `surface`, `cwd`, `resume`, `name`, `model`, and repeated `arg`, `claude-arg` and `run`. A prompt over 8 KB is
  refused; use a minted link with `--prompt-file`. A link minted on this Mac skips the card once.
- `artifact` (needs the `tools` CLI): `https://<linkHost>/artifact/<name>/<page>` opens a registered artifact page.
- `dashboard-names`: a dashboard's registry key works as a host, `https://jev/x`, and with a link host as a path on
  it, `https://<linkHost>/jev/x`. Both start the dashboard and open `http://localhost:<port>/x`; the port always
  comes from the registry. Option `only`, and `names` for an extra name (`dashboard=artifact-library` makes
  `https://dashboard` the Artifact Library; the Personal Dashboard is `personal-dashboard`). It comes last, so its
  paths never shadow a more specific preset path such as `/artifact/<name>/`.

A preset that the config switches on but this Mac cannot serve writes no routes, and `presets sync` removes its
saved ones.

```bash
tools browser-router presets
tools browser-router presets configure
tools browser-router presets enable decide
tools browser-router presets enable dashboard-names \
    --only jev,dev-dashboard \
    --name dashboard=artifact-library
tools browser-router presets disable decide
tools browser-router presets sync
```

### Your own routes

A route is `{ "pattern", "action", "name"?, "toast"? }`. `pattern` is a regular expression matched against the whole
cleaned URL. When you leave out the anchors, `^` is added, and so is an optional query and fragment at the end:
`https://x\.example\.com/a` also matches `https://x.example.com/a?b=1#c`. A bare host has the path `/`.

`action.type` is one of these:

- `open`: rewrite the URL and hand it to its app (`{ "type": "open", "to": "genesis-md://$1" }`). An http(s) target
  goes straight to `defaultBrowser`, never back into the router.
- `forward`: send the link to a named browser (`browser`), optionally rewritten (`to`). A route that forwards to
  GenesisTools.app (or the retired router app) by bundle id is refused, because it would loop.
- `run`: execute `argv` (never a shell). `approval` is optional: `"ask"` (the default) shows the Allow card first,
  and `"allow"` runs at once. Also optional: `touchId: true`, `open` (an http(s) URL to open after a successful run),
  `notify` (the text after a successful run), and `trustMinted: true` (a link minted on this Mac, `/t/<id>`, skips the
  Allow card; the raw URL still asks).
- `service`: start a registered server and open `to` (`{ "type": "service", "port": 3096, "name": "Artifact
  Library", "to": "http://localhost:3096$1" }`). The port must be in the registry, or `ensure` exits 2. Optional:
  `allowExecuteByPlainBrowserNavigationMightBeDangerous: true` lets a URL typed in a browser start the server (the
  presets copy it from the registry).
- `tool`: record a GenesisTools tool and its `args`. It is shown, never run.
- `unwrap` and `token`: used by the `core` preset.

Templates (`to`, `argv`, `args`, `open`, `notify`) take these:

- `$1`, `$2` ...: a capture of the pattern. `$$` is a dollar.
- `{qty}`: the query parameter `qty`. `{host}`, `{path}` (without the leading `/`), `{pathname}` and `{port}` are
  parts of the URL.
- `{ids*}` as a whole `argv` entry: the query parameter `ids` split on commas into separate arguments.
- With `route` on the command line, a pattern written as a URL with `:name` placeholders becomes a regular
  expression, and `{name}` in the flags binds to that capture.

An **alias** renames a host before anything else matches: `{ "host": "library.test", "base":
"http://localhost:3096" }` sends `https://library.test/a?b=1` to `http://localhost:3096/a?b=1`, and the
`local-services` route for 3096 then starts that server. A base with a path is a prefix. For a registry dashboard,
the `dashboard-names` option `names` does the same and also covers the path form on the link host.

`route` saves a new route last, after the installable presets' routes. The next rewrite (`presets sync`, and every
`install`, `presets enable`, `presets disable`, `link-host` and `links --convert`) moves it in front of them.

### Config examples

A link host, three presets, and `dashboard` pointed at the Artifact Library:

```json
{
  "defaultBrowser": { "name": "com.brave.Browser", "appType": "bundleId" },
  "linkHost": "links.example.com",
  "presets": {
    "local-services": {},
    "dashboard-names": { "only": ["jev", "dev-dashboard"], "names": { "dashboard": "artifact-library" } },
    "decide": {}
  },
  "routes": []
}
```

A local server's buttons (a shop helper on port 8787), asking before it adds, with Touch ID:

```json
{
  "name": "Add to cart",
  "pattern": "https?://(?:127\\.0\\.0\\.1|localhost):8787/add/(\\d+)",
  "action": {
    "type": "run",
    "argv": ["bun", "/opt/shop/shop.ts", "add", "$1", "--qty", "{qty}"],
    "approval": "ask",
    "touchId": true,
    "notify": "Added {qty} of $1"
  }
}
```

Several ids from one query parameter (`?ids=1,2,3`), after `--` so an id can never be a flag:

```json
{
  "pattern": "https?://(?:127\\.0\\.0\\.1|localhost):8787/add-many",
  "action": { "type": "run", "argv": ["/usr/local/bin/shop", "add", "--", "{ids*}"], "approval": "allow" }
}
```

Always open a site in another browser, and hide the card for it:

```json
{
  "pattern": "https://meet\\.example\\.com/.*",
  "action": { "type": "forward", "browser": { "name": "com.google.Chrome", "appType": "bundleId" } },
  "toast": false
}
```

Open a web app's sign-in links in that app (a Safari web app made with "Add to Dock"), or the login cookie lands in
the default browser and the app stays signed out (2026-10-16):

```bash
tools browser-router route 'https://login\.example\.com/.*' --browser 'Example App'
```

Rewrite one site's links onto another (`$1` is the path):

```json
{
  "pattern": "https://old-wiki\\.example\\.com/(.*)",
  "action": { "type": "open", "to": "https://wiki.example.com/$1" }
}
```

Start a server and open a page on it:

```json
{
  "name": "Library",
  "pattern": "https?://library(/.*)?",
  "action": { "type": "service", "port": 3096, "name": "Artifact Library", "to": "http://localhost:3096$1" }
}
```

Card defaults for every route, and link cleaning switched on:

```json
{ "toast": { "enabled": true, "seconds": 3 }, "clean": true }
```

## For agents

- **Before you print a link**, run `tools browser-router status --json` once per session. A link works only when
  `linkHost` is set, `installed` and `defaultHandler` are both true, and the preset you need is in `enabledPresets`.
  Build the link on `linkHost`, never on a hard-coded host. Otherwise print the plain command instead.
  `extension: false` means the link works when clicked in another app, but not typed or clicked inside a browser.
  A non-empty `drift` list means the saved routes differ from what the preset ships; `routed` says whether its
  links still reach it. `tools browser-router presets sync` clears the drift.
- `status --json` fields: `installed`, `defaultHandler`, `httpsHandler`, `appPath`, `configPath`, `configured`,
  `linkHost`, `extension`, `enabledPresets`, and `presets[]` with `id`, `title`, `kind`, `available`, `enabled`,
  `routed`, `drift` and `missing`.
- `explain <url> --json` prints the decision: `kind` (`open`, `forward`, `run` or `tool`), `via` (`route`,
  `default` or `loop-guard`), `routeIndex`, `url`, `original`; `open` and `forward` add `browser` and `openArguments`; a run adds
  `argv`, `approval`, `needsApproval`, `touchId`, `open`, `notify`, `browserArguments`, and `service` or `launch` when
  they apply; a tool adds `tool` and `args`. The text form prints `<kind> via <via>`, the URL, then the argv or the `open` arguments
  (`(swallowed)` for a link that opens nothing).
- `routes --format json` prints the raw routes.
- Paste router links, not local ones: write the markdown to a file, run `links --convert <file>`, and paste its
  output. To give more than three links that belong together, mint one bundle link
  (`tabs mint --from-md <file>`) and paste `[Open all 5](https://<linkHost>/t/<id>)`.
- Never enable a preset for the user without being asked.
- Exit codes: 0 on success, 1 when a command refuses (the message says why: `explain`, `open`, `tabs open` and `token open`
  without a config, a command that needs a link host without one, a bad flag, `link-host` without `--accept-risk` and
  without a terminal). `routes` without a config prints `No config yet` and exits 0. `ensure` exits 2 for a port that
  is not registered or has no launch command.
- TypeScript code builds a link with `routerLink()` (`src/utils/browser-router/router-link.ts`). It returns the
  fallback with a coded reason (`router-missing`, `not-https-handler`, `no-link-host`, `preset-off`, `app-missing`,
  `declined`) when the link would be dead. `linkFor()` in `src/utils/browser-router/links.ts` applies the same check
  and returns null.
- `tools genesis-tools probe md finder hub claude-find` says whether a click on each kind of link opens on this Mac.
- The plugin skill `gt:browser-router` (`plugins/genesis-tools/skills/browser-router/SKILL.md`) carries these rules
  for Claude and other agents.

## Troubleshooting

**A link does nothing, or opens in the wrong browser.** Check who owns https:
`~/Applications/GenesisTools.app/Contents/MacOS/GenesisTools --default-browser status`. The `https=` line must name
GenesisTools.app. If not, run `tools browser-router install` again and confirm the macOS dialog. `install` exits 1
with `https handler is ... (confirm the macOS prompt, then run status)` while the dialog is unanswered.

**You are not sure what a click did.** `tools browser-router explain <url>` prints the decision. The card shows the
log of the click, and a failed command's output. For a route that runs something, read the end of
`~/.genesis-tools/audit/gates.jsonl`.

**The installed app might be out of date.** `explain` runs the current TypeScript router, which can be newer than the
installed app. Compare the modification time of `~/Applications/GenesisTools.app/Contents/MacOS/GenesisTools` with
`native/Router.swift`, and run `bun run app` if the source is newer. To check the installed app's own decision:

```bash
cd src/browser-router/native
swiftc -O Router.swift Cli.swift -o /tmp/router-cli
/tmp/router-cli ~/.genesis-tools/browser-router/config.json 'https://links.example.com/hello/world'
```

A route the Swift router cannot parse is skipped by index, with `router: skipped routes[N] ...` on stderr; the other
routes keep working.

**A typed or in-page link does nothing.** Read the extension lines at the end of `status`: not built, not loaded, an
`OLDER BUILD` (reload it), or a native host that is not registered. Each line names its fix. A click from another
app does not need the extension.

**A hub or review window steals focus when you click a link.** The link relay hands each click to a fresh process and
gives the focus back. A window that jumps to the front is likely from a stale build: restart it. The relay's log is
`~/.genesis-tools/app/link-relay.log`.

**A route that runs something failed.** `--run` builds an argv, never a shell, so quoting, `~` and globs do not apply.
`explain <url>` prints the exact argv first. Use an absolute path, or a program on the login shell's PATH.

**`open` says the link "asks before it runs".** The CLI has no Allow card. Click the link instead, so GenesisTools.app
shows the card.

**"link used up".** A minted link has no uses left, and its token is gone. Mint a new one. `explain` never spends a
use, `open` and a click do. A bundle spends its use only after the "Open N tabs?" question above 15 links, so a
cancel leaves the link for another click. A minted link is routed before its use is spent, so a config error does
not burn it.

**A new route never fires.** An earlier route matches first. `explain <url> --json` shows the `routeIndex` that won.
Remember that `route` saves a new route last until the next rewrite (see [Your own routes](#your-own-routes)).

**`presets` says `needs ...`, or `status` shows drift.** A preset needs an app, a CLI or the link host it names. A
drift line means the saved routes differ from what the preset ships: `tools browser-router presets sync` restores
them.

**A bundle window stays open after a script closes it.** Brave asks "Close all?" before it closes a window with
several tabs, so the window waits for that click.

**`link-host` exits 1 without asking.** There is no terminal. Run it again with `--accept-risk`.

**`ensure` exits 2.** The port is not in the registry (`src/utils/ui/dashboards.ts`), or its entry has no launch
command.

## Related

- [browser-extension](../browser-extension/README.md): the extension that catches typed links, and its native host.
- [macos](../macos/README.md): `tools macos permissions build`, the app build behind `bun run app` and `install`.
- [claude](../claude/README.md): `tools claude decide` and `tools claude cmux find`, behind `decide` and
  `claude-find`.
- [cmux](../cmux/README.md): `tools cmux launch`, behind `cmux-claude`.
- [hub](../hub/README.md): the GenesisTools hub that `genesis-hub` links open.
- [artifact](../artifact/README.md) and [meetings](../meetings/README.md): the tools behind `artifact` and
  `meetings-play`.
- [dev-dashboard](../dev-dashboard/README.md): one of the registered servers that `local-services` starts.
- [genesis-tools](../genesis-tools/README.md): `tools genesis-tools probe`, which checks every kind of link.
