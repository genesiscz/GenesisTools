# browser-router

`browser-router` manages the routing rules that GenesisTools.app uses when it acts as this
Mac's http(s) handler. It also does the actual routing: GenesisTools.app calls straight into
the same logic this CLI exposes (`explain`, `open`, `ensure`, `token open`, `tabs open`), and a
Swift copy of the matcher (`native/Router.swift`) mirrors it for speed. There is no separate
router app, and nothing listens on a port for it. GenesisTools.app is the router.

A route turns a matched URL into an action: open it with a rewritten target, forward it to a
named browser, run a program, start a local server and open it, or record a tool.
`tools browser-router explain <url>` prints what a click on a URL would do, without doing it.
`tools browser-router open <url>` does it for real.

## Two ways a link reaches you: clicked elsewhere, or typed in a browser

**A link clicked in another app** (Mail, Slack, a terminal's `open https://...`, a PDF) goes
through macOS Launch Services. Once `tools browser-router install` made GenesisTools.app the
http and https handler, macOS delivers the URL to it as an Apple Event (`kAEGetURL`, handled by
`installBrowserURLHandler` in `src/macos/GenesisTools/Sources/BrowserURL.swift`). The app reads
its config, decides, shows a card in the bottom-left corner, and runs the action. Nothing else is needed.

**A URL typed into a browser's address bar, or a link clicked inside a web page, never reaches
GenesisTools.app that way.** A browser handles its own navigation and never asks macOS who owns
https. For that case the GenesisTools browser extension (`src/browser-extension`) is needed. It
redirects navigation to the router's hosts (the link host, alias hosts, dashboard names) to an
internal confirmation page before any request leaves the browser. That page asks the router
(`explain`, through a native messaging host) what the link would do, and hands it to
GenesisTools.app with `open -b com.genesiscz.genesistools <url>`. A bare word such as `dashboard`
is a search, not an address, so the extension also catches a search whose whole query is one of
those hosts.

`tools browser-router status` ends with an `extension:` line: not built, not loaded, loaded, or
`OLDER BUILD` (a Reload is due). `links --convert` warns when it prints links and the extension
is not loaded.

## Setup on a new Mac

After `git clone`, `bun install` and `./install.sh` (then open a new shell so `tools` is on PATH):

1. `tools browser-router install`. It builds, signs and installs `~/Applications/GenesisTools.app`,
   writes `~/.genesis-tools/browser-router/config.json`, and asks macOS to make GenesisTools.app
   the http and https handler (macOS shows its own "change your default browser?" dialog). Links
   no route claims open in the config's `defaultBrowser` (Brave if installed, else Chrome, else
   Safari). `tools browser-router uninstall` gives https back to the previous handler.
2. In a terminal, `install` asks for a **link host**; see below. Later:
   `tools browser-router link-host <host>`.
3. Switch on the presets you want: `tools browser-router presets`, then
   `tools browser-router presets enable <id>`. None is on by default except `core`.
4. `tools browser-router status` must show `https=` with GenesisTools.app.
5. Optional, for links typed in a browser: the extension.
   - `tools browser-extension build` writes `dist/browser-extension`, with host permissions for
     the router's hosts in the current config.
   - `tools browser-extension install-host` registers the native messaging host for Brave, Chrome
     and Chromium.
   - In `brave://extensions` (or `chrome://extensions`), turn on Developer mode, Load unpacked, and
     pick `dist/browser-extension`.
   - After a rebuild (a new link host, alias or preset changes the hosts), click Reload on the
     GenesisTools card.

## The link host

Every link GenesisTools prints is built on one host from the config, `linkHost`:
`https://<linkHost>/t/<id>` (minted links), `/tabs/<name>` (bundles), `/link/<url>` (wrapped
local links), and the preset paths below. Without a link host no link is printed, and the
presets built on it are unavailable.

A link the router does not catch (opened on a phone, on another computer, or in a browser
without the extension) goes to whoever serves that host, path and all, and a minted link's path
is a one-use token. So `link-host` asks for confirmation (or `--accept-risk` without a terminal).
Pick a host you control when you can.

## Presets

A preset is a set of routes the router writes for you. `default` presets are on whenever they
can be; `installable` presets are off until you switch them on. `tools browser-router presets`
lists them with their state and what each needs.

- `core` (default): minted links, bundles and wrapped links on the link host.
- `local-services`: a click on `localhost:<port>` or `127.0.0.1:<port>` of a registered server
  (`src/utils/ui/dashboards.ts`) runs `tools browser-router ensure <port>` first, which starts
  the server if the port is not listening and waits up to 20 seconds. Option `only`.
- `dashboard-names`: a dashboard's registry key works as a host, `https://jev/x`, and as a path
  on the link host, `https://<linkHost>/jev/x`. Both start the dashboard and open
  `http://localhost:<port>/x`; the port always comes from the registry. Option `only`, and
  `names` for an extra name (`dashboard=artifact-library` makes `https://dashboard` the Artifact
  Library; the Personal Dashboard is `personal-dashboard`).
- `genesis-md`: `https://<linkHost>/md/<path>` opens `genesis-md://<path>` in Genesis Markdown.
- `mail` (macOS): `https://<linkHost>/mail/show/<rowid>` runs `tools macos mail open <rowid>`.
- `decide`: `https://<linkHost>/decide/<session>/<n>/<letter>` types that answer into a live
  Claude session, without an approval card.
- `cmux-claude`: `https://<linkHost>/cmux/claude/run?prompt=...` starts Claude in a new cmux
  surface, after a prompt (a minted link skips the prompt once).
- `artifact`: `https://<linkHost>/artifact/<name>/<page>` opens a registered artifact page.

```bash
tools browser-router presets
tools browser-router presets enable decide
tools browser-router presets enable dashboard-names --only jev,dev-dashboard --name dashboard=artifact-library
tools browser-router presets disable decide
# Rewrite the saved routes from the presets (after a registry change or a hand edit).
tools browser-router presets sync
```

The enabled presets are saved in `config.presets`, and the routes are derived from them: the
default presets' routes first, then your own routes, then the installable presets'. A route of
your own with the same pattern as a preset route replaces it. `status` reports a preset whose
saved routes drifted from what it ships, with the fix.

## Your own routes

A route is `{ pattern, action, name?, toast? }`. `pattern` is a regular expression matched
against the whole URL (anchors are added when you leave them out), routes are tried in order,
and the first match wins. `action` is one of:

- `open`: rewrite the URL and hand it to its app (`{ "to": "genesis-md://$1" }`). An http(s)
  target goes straight to the default browser.
- `forward`: send it to a named browser, optionally rewritten.
- `run`: execute a program (`argv`, never a shell). `$1` is a capture, `{qty}` a query
  parameter, `{ids*}` splits a query parameter on commas into separate arguments. `approval:
  "ask"` (the default) shows Allow/Deny first; `"allow"` runs at once; `touchId: true` adds Touch ID.
- `service`: start a registered server (`port`) and open `to` (`{ "port": 3096, "name":
  "Artifact Library", "to": "http://localhost:3096$1" }`).
- `tool`: record a GenesisTools tool and its arguments; it is shown, never run.
- `unwrap` and `token`: used by the `core` preset.

An **alias** renames a host before anything else matches: `{ "host": "library.test", "base":
"http://localhost:3096" }` sends `https://library.test/a?b=1` to `http://localhost:3096/a?b=1`, and
the `local-services` route for 3096 then starts that server. A base with a path is a prefix. For a
registry dashboard, the `dashboard-names` option `names` does the same and also covers the path
form on the link host.

## Config examples

`~/.genesis-tools/browser-router/config.json`. GenesisTools.app reads it on every click, so it is
always written as a temp file plus rename. Edit it with the commands where you can.

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
    "argv": ["/Users/me/.bun/bin/bun", "/Users/me/scripts/shop.ts", "add", "$1", "--qty", "{qty}"],
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

Rewrite one site's links onto another (`$1` is the path):

```json
{ "pattern": "https://old-wiki\\.example\\.com/(.*)", "action": { "type": "open", "to": "https://wiki.example.com/$1" } }
```

Start a server and open a page on it:

```json
{
  "name": "Reports",
  "pattern": "https?://reports(/.*)?",
  "action": { "type": "service", "port": 3071, "name": "Clarity Timelog", "to": "http://localhost:3071$1" }
}
```

Card defaults for every route (`toast`), and link cleaning (`clean`, on by default: it unwraps
safelinks and strips tracking parameters):

```json
{ "toast": { "enabled": true, "seconds": 3 }, "clean": true }
```

## Commands

```bash
tools browser-router install
tools browser-router uninstall

# Config path, handler, link host, enabled presets, drift, and the extension line.
# --json is side-effect-free; skills call it before printing a link.
tools browser-router status
tools browser-router status --json

tools browser-router link-host                     # print it
tools browser-router link-host links.example.com   # set it (asks first)
tools browser-router link-host --unset

tools browser-router routes
tools browser-router routes --format json

# Add or replace one route. --route-to / --run / --tool pick the action; only one at a time.
tools browser-router route 'https://links.example.com/hello/:name' --route-to 'https://example.com/$1'
tools browser-router route 'http://127.0.0.1:8787/add/:id' \
  --run /path/to/script.ts --arg add --arg '$1' --arg --qty --arg '{qty}' \
  --notify 'Added' --approval allow
# Remove by the exact saved pattern (read it back with routes --format json).
tools browser-router route 'https://links\.example\.com/hello/([^/?#&]+)' --delete

tools browser-router explain 'https://links.example.com/hello/world' --json
tools browser-router open 'https://links.example.com/hello/world'

# Start a registered local server if it is not already listening.
tools browser-router ensure 3042

# Rewrite local links in markdown into links on the link host; --uses mints one-use links.
tools browser-router links --convert notes.md
tools browser-router links --convert notes.md --uses 3

# Many links, one click.
tools browser-router tabs save morning https://a.example https://b.example
tools browser-router tabs mint https://a.example https://b.example --uses 1
tools browser-router tabs list
```

## Where state lives

Everything is under `~/.genesis-tools/browser-router/`:

- `config.json`: the config above.
- `tokens.json`: minted links from `links --convert --uses` and `tabs mint`. Mode `0600`, since
  a token is a bearer credential.
- `bundles.json`: named bundles from `tabs save`.
- `previous.json`: the handler https had before `install`, for `uninstall`.
- `router.log`: what the installed app decided for each click.

## Troubleshooting

**A link does nothing, or opens in the wrong browser.** Check who owns https:
`~/Applications/GenesisTools.app/Contents/MacOS/GenesisTools --default-browser status`. The
`https=` line must name GenesisTools.app; if not, run `tools browser-router install` again.

**You are not sure what a click did.** Read the end of `~/.genesis-tools/browser-router/router.log`.
A route the installed app could not parse is skipped by index (`router: skipped routes[N]`).

**The installed app might be out of date.** `explain` runs the current TypeScript router. Compare
the modification time of `~/Applications/GenesisTools.app/Contents/MacOS/GenesisTools` with
`native/Router.swift`, and run `bun run app` if the source is newer. To check the installed app's
own decision: `cd src/browser-router/native && swiftc -O Router.swift Cli.swift -o /tmp/router-cli`,
then `/tmp/router-cli ~/.genesis-tools/browser-router/config.json <url>`.

**A typed or in-page link does nothing.** See the `extension:` line of `status`. A click from
another app does not need the extension.

**A hub or review window steals focus when you click a link.** GenesisTools.app's own windows
forward the click to a fresh process (`BrowserURLForwarder` in `Sources/BrowserURL.swift`) and
hand focus back. A window that jumps to the front is likely a stale build; restart it.

**A route that runs something failed.** `--run` builds an argv, never a shell, so quoting and globs
do not apply. `explain <url>` prints the exact argv first.
