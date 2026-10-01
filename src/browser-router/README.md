# browser-router

`browser-router` manages the routing rules that GenesisTools.app uses when it acts as this
Mac's http(s) handler. It also does the actual routing: GenesisTools.app calls straight into
the same logic this CLI exposes (`explain`, `open`, `ensure`, `token open`, `tabs open`), and a
Swift copy of the matcher (`native/Router.swift`) mirrors it for speed. There is no separate
router app. GenesisTools.app is the router.

A route turns a matched URL into an action: open it with a rewritten target, forward it to a
named browser, run a program, or hand it to a recorded tool. `tools browser-router explain <url>`
prints what a click on a URL would do, without doing it. `tools browser-router open <url>` does it
for real.

## Two ways a link reaches you: clicked elsewhere, or typed in a browser

These are different mechanisms, and only one of them needs anything installed in your browser.

**A link clicked in another app** (Mail, Slack, a terminal's `open https://...`, a PDF) goes
through normal macOS Launch Services. Since `tools browser-router install` made GenesisTools.app
the https and http handler, macOS delivers the URL to it directly as an Apple Event
(`kAEGetURL`). `installBrowserURLHandler` in `src/macos/GenesisTools/Sources/BrowserURL.swift`
is the event handler. GenesisTools.app reads its own config, decides what to do, shows the
center-screen card, and runs the action. This is the common case: almost every clickable link
outside a browser reaches GenesisTools.app this way, with nothing extra needed.

**A URL typed into a browser's address bar, or a link clicked inside a web page, never reaches
GenesisTools.app this way.** A browser handles its own navigation. It does not ask macOS "who
owns https" for a URL you type into it or click inside it, so the default-handler registration
above never fires for that case. `genesis.tools` also does not really resolve to a server
anywhere: there is nothing listening on the network for it.

For that case, a separate companion tool is needed: the GenesisTools browser extension
(`src/browser-extension`, `tools browser-extension`). Installed in a browser, it watches for
navigation to `https://genesis.tools/...` with a `declarativeNetRequest` rule and redirects the
tab to an internal confirmation page before the request ever leaves the browser. That page asks
`tools browser-router explain` (through a native messaging host) what the link would do, shows
you a short summary, and on your click runs `open -b com.genesiscz.genesistools <url>`, the same
`open` command any other app could run. That handoff is what finally reaches Launch Services and
fires the same Apple Event path as the first case. So a typed or in-page `genesis.tools` link only
works with the extension installed; this README is about the router, not the extension, so see
`src/browser-extension` for that side.

A registered local dashboard's own `http://localhost:<port>/...` or `http://127.0.0.1:<port>/...`
link is a third, simpler case: see "Local servers start themselves" below. That one does not need
genesis.tools at all.

## How a click is decided

A route is `{ pattern, action, name?, toast?, preset? }`. `pattern` is matched against the whole
URL, routes are tried in order, and the first match wins. Anchors are added automatically when a
pattern does not start with `^` or end with `$`, so most patterns only need the part that
differs. `action` is one of:

- `open`: rewrite the URL and hand it to Launch Services (`{ to: "genesis-md://$1" }`).
- `forward`: send it to a named browser, optionally after rewriting it.
- `run`: execute a program (`argv`, never a shell). `$1` is a regex capture, `{qty}` reads a
  query parameter, `{ids*}` splits a query parameter on commas into separate arguments.
- `tool`: record a GenesisTools tool and its arguments. Never executed; it only appears on the
  card and in `explain`.
- `unwrap` and `token`: internal, used by `links --convert` and minted links.

A `run` action defaults to `approval: "ask"`, which shows an Allow/Deny card before it runs.
`approval: "allow"` runs it straight away. `--touch-id` adds a Touch ID (or password) prompt in
front of that, for every value the route's parameters can take, since the parameters themselves
are not fixed.

Every route can carry a `name` (the card's headline; without it the card names the command) and a
`toast` override (`{ seconds, title }`, or `false` to hide the card for that one route). The
top-level `toast` setting in the config is the default every route inherits.

## Local servers start themselves

Config also carries `services`: a list of `{ port, name }` pulled automatically from the
dashboard/web-service registry (`src/utils/ui/dashboards.ts`) every time `ensureBuiltinRoutes`
runs. A click on `http://localhost:<port>/...` or `http://127.0.0.1:<port>/...` for a
registered port first runs `tools browser-router ensure <port>`, which checks whether the port
is already listening and, if not, starts the registered launch command and waits up to 20
seconds. The card reads "Starting <name>" while it waits, then "Opening" once the port answers,
and the page only opens on success. Run it by hand the same way: `tools browser-router ensure
3042`. An unregistered port, and port 6666 itself (the router's own symbolic host), are never
auto-started; they route as a normal URL.

## Presets vs. an ad-hoc `route`

A **preset** is a built-in route for one companion tool: `genesis-md` (the Genesis Markdown
app), `mail`, `decide` (types an answer into a live Claude session), `cmux-claude` (launches
Claude in a new cmux surface), `artifact`, and `rohlik`. Each one lists the capabilities it
needs (an installed app, a script on disk, `claude` on `PATH`, ...). `tools browser-router
install` (through `ensureBuiltinRoutes`) writes the routes for every preset whose capabilities
currently hold, and tags each one with `preset: "<id>"`. Run it again later and a preset whose
app disappeared has its routes removed, while one that now qualifies gets added. `tools
browser-router presets` lists them with their state: `on` (installed), `opt` (available but not
switched on), or `off` (a capability is missing).

`decide` is opt-in on purpose: its route types an answer into a live session with
`approval: "allow"` and no confirmation card, so it is never turned on silently. Switch it on
with `tools browser-router presets enable decide`.

An **ad-hoc route**, the kind `tools browser-router route` adds, carries no `preset` tag. It is
entirely yours: `install` and `ensureBuiltinRoutes` never touch, drift-check, or remove it. Two
routes can share a pattern only as a replacement, saving the same pattern again overwrites the
older one; `--delete` removes it.

`tools browser-router status` (or `status --json` for a fast, side-effect-free check) shows
which presets are routed on this Mac right now, and which have drifted, meaning their saved
action no longer matches what the current preset would write (an older `install`, or a hand
edit). A drifted preset still routes, just with the older action; `status` prints the exact fix
command.

## Where config lives

Everything is under `~/.genesis-tools/browser-router/`:

- `config.json`: the routes, the default browser, aliases, toast defaults, and the local
  `services` list. GenesisTools.app reads this file on every click, so it is always written as
  a temp file plus rename, never in place.
- `tokens.json`: minted one-use (or N-use) links from `links --convert --uses` and `tabs mint`.
  Mode `0600`, owner-only, since a token is a bearer credential.
- `bundles.json`: named tab bundles from `tabs save`.
- `previous.json`: the browser that had https before `install` took it over, so `uninstall` can
  give it back.

## Commands

```bash
# Build GenesisTools.app, write the default routes, and become the https/http handler.
# macOS shows its own "change your default browser?" prompt.
tools browser-router install

# Give https/http back to the browser recorded before install. The app stays installed.
tools browser-router uninstall

# Config path, handler status, and any drifted preset. --json is fast and side-effect-free.
tools browser-router status
tools browser-router status --json

# Saved routes as a table. --format json prints the raw array instead.
tools browser-router routes
tools browser-router routes --format json

# Add or replace one route. --route-to / --run / --tool pick the action; only one at a time.
tools browser-router route 'https://genesis.tools/hello/:name' --route-to 'https://example.com/$1'

# --run's argv is <program> plus every --arg, in order, never a shell.
# $1 is a regex capture, {qty} reads a query parameter.
tools browser-router route 'http://127.0.0.1:8787/add/:id' \
  --run /path/to/script.ts --arg add --arg '$1' --arg --qty --arg '{qty}' \
  --notify 'Added' --approval allow

# Remove a route by its exact saved pattern. A :name template is stored as an escaped regex
# (":name" becomes a capture group), so `routes` or `routes --format json` is the reliable way
# to read back the exact pattern string a route was saved under.
tools browser-router route 'https://genesis\.tools/hello/([^/?#&]+)' --delete

# What a click on this URL would do, without doing it.
tools browser-router explain 'https://genesis.tools/hello/world'
tools browser-router explain 'https://genesis.tools/hello/world' --json

# Actually apply the routes and open the result (what a click runs for real).
tools browser-router open 'https://genesis.tools/hello/world'

# Start a registered local server if it is not already listening.
tools browser-router ensure 3042

# List built-in presets and their state (on / opt / off).
tools browser-router presets

# Turn on an opt-in preset, writing its routes into the saved config.
tools browser-router presets enable decide

# Rewrite local links in a markdown file into genesis.tools links a click can route.
# --uses mints one-use tokens; omit it for stable, reusable links.
tools browser-router links --convert notes.md
tools browser-router links --convert notes.md --uses 3

# Save a bundle of links under a name, or mint a one-off bundle link.
tools browser-router tabs save morning https://a.example https://b.example
tools browser-router tabs mint https://a.example https://b.example --uses 1
tools browser-router tabs list
```

## Troubleshooting

**A genesis.tools link does nothing, or opens in the wrong browser.** Check who owns https:
`~/Applications/GenesisTools.app/Contents/MacOS/GenesisTools --default-browser status`. The
`https=` line must name GenesisTools.app. If it names anything else, run `tools browser-router
install` again and confirm the macOS prompt.

**A link was clicked but you are not sure what it did.** Read the last lines of
`~/.genesis-tools/browser-router/router.log`. A route the installed app could not parse is
skipped by name (`router: skipped routes[N]`); the rest of the log explains the decision for
that URL.

**The installed app might be out of date.** `tools browser-router explain <url>` always runs the
current TypeScript router, which can be newer than the compiled app. Compare the modification
time of `~/Applications/GenesisTools.app/Contents/MacOS/GenesisTools` against
`native/Router.swift`, and run `bun run app` if the source is newer. To check the installed
app's own decision directly: `cd src/browser-router/native && swiftc -O Router.swift Cli.swift -o
/tmp/router-cli`, then `/tmp/router-cli ~/.genesis-tools/browser-router/config.json <url>`.

**A typed or in-page `genesis.tools` link does nothing at all.** That is expected without the
browser extension installed; see "Two ways a link reaches you" above. A click from another app
does not need it.

**A hub or review window steals focus when you click a link.** GenesisTools.app's own windows
(`--hub`, `--review`) receive the click first and forward it to a fresh process
(`BrowserURLForwarder` in `Sources/BrowserURL.swift`), then hand focus back to whatever app the
link was clicked in. If a window jumps to the front instead, it is likely a stale running build;
restart it.

**A route that runs something failed.** `tools browser-router route <pattern> --run ...` builds
an argv, never a shell, so quoting and globs do not apply the way they would on a command line.
Check `explain <url>` first: it prints the exact argv the click would run, before it runs it.
