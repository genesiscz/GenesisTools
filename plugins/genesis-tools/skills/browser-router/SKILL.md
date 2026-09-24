---
name: gt:browser-router
description: Trigger only on /browser-router. Create routing for any links that are not ordinary web URLs, so a click on this Mac runs the saved route instead of opening a page.
---

# browser-router

When the user says `/browser-router`, or you are about to paste markdown that contains `localhost`, `127.0.0.1`, or a custom scheme:

1. Write the markdown to a file.
2. Run `tools browser-router links --convert <file>`.
3. Paste the command's stdout. Do not paste the original local links.

Ordinary `https://` websites are left unchanged. Local links become `https://genesis.tools/...`, which this Mac treats as `127.0.0.1:6666` while `allowAliases` is true. `--uses 3` makes each of those links work three times; omit it for a stable link.

GenesisTools.app (`~/Applications/GenesisTools.app`) is the http(s) handler and routes every click itself. There is no separate router app. `tools browser-router install` builds GenesisTools.app and runs `GenesisTools --default-browser set`, which makes macOS ask the user to confirm. Never build or install another handler app.

Write a route as a URL with `:name` placeholders, not a regular expression. `{name}` in `--arg` is that placeholder. `--touch-id` asks for Touch ID or the Mac password before the command, for every value of its parameters.

A click shows a card in the middle of the screen: the Genesis Tools mark, then Opening or Running, then a short log. It fades after `toast.seconds` (default 5). Set `toast` on the config to change it for every route, or on one route to override. `"toast": false` hides it. `--no-toast`, `--toast-seconds`, and `--toast-title` set the override when you save a route.

A dead `http://127.0.0.1:<port>` link for a registered dashboard is started with `tools browser-router ensure <port>` before the page opens. Port 6666 is never started that way.

`tools claude decide --session ID --decision 1 --option a` types `DECISION 1: a)` into that cmux session. A clickable link is not built in. Add it yourself, for example `tools browser-router route 'https://genesis.tools/decide/:session/:n/:letter' --run tools --arg claude --arg decide --arg --session --arg '{session}' --arg --decision --arg '{n}' --arg --option --arg '{letter}' --approval allow`. `tools browser-router presets` always lists decide as off: it is opt-in on purpose, because the route answers into a live session with no approval card.

Run `tools browser-router status --json` once per session. If `installed` is false or the preset you need is off, print the plain command instead of a link. `tools cmux launch --account <name> --prompt <text>` prints the quoted command for a new cmux surface, and with `--open` it opens that surface and runs the command (the cmux-claude preset passes `--open`). A link that starts an agent is always ask unless it was minted on this machine.

Several pages, one click: `tools browser-router tabs save <name> <url...>` then share `https://genesis.tools/tabs/<name>`. A click opens every link through the router (a built-in route runs `tabs open`). A bundle of more than 15 links does not open: split it. Tracking parameters and Outlook safelinks are stripped before a normal page is forwarded.

```bash
tools browser-router route 'http://127.0.0.1:8787/add/:id' --run <program> --arg add --arg '{id}' --arg --qty --arg '{qty}' --notify 'Added' --approval allow
tools browser-router route 'https://127.0.0.1:6666/open' --route-to 'genesis-md://open'
tools browser-router links --convert <file> --uses 1
tools browser-router explain <url>
```

`$1` is a capture. `{qty}` is a query parameter. `{ids*}` as its own `--arg` splits on commas. `--approval ask` (the default) shows Allow / Deny. `--approval allow` runs the argv with no shell. Config: `~/.genesis-tools/browser-router/config.json`.

## When a link does the wrong thing

1. Check which app has the links: `~/Applications/GenesisTools.app/Contents/MacOS/GenesisTools --default-browser status`. `https=` must be GenesisTools.app. If it is anything else, run `tools browser-router install` (or `GenesisTools --default-browser set`) and let the user confirm the macOS prompt.
2. Read the last lines of `~/.genesis-tools/browser-router/router.log`. A route the installed app cannot parse is skipped with `router: skipped routes[N]` (the other routes keep working); the rest of the log names the decision for the URL.
3. Prove what the installed app decides with its own validator: `cd src/browser-router/native && swiftc -O Router.swift Cli.swift -o /tmp/router-cli`, then `/tmp/router-cli ~/.genesis-tools/browser-router/config.json <url>`. `tools browser-router explain <url>` runs the TypeScript router, which can be newer than the installed app: compare `stat` of `~/Applications/GenesisTools.app/Contents/MacOS/GenesisTools` with `Router.swift`, and run `bun run app` when the source is newer.
4. A window of GenesisTools.app (`--hub`, `--review`) that is open receives the click first and hands it to a new instance, then gives focus back to the app the link was clicked in. If a link brings the hub to the front instead, the running hub is from an older build: restart it.

Seen 2026-09-24: a `token` route written into routes[0] that an older build could not parse made every link fall back (now skipped instead); later an old standalone router app was rebuilt and took the https handler away from GenesisTools.app (that app no longer exists).
