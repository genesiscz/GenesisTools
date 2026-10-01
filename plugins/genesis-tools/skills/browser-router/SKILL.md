---
name: gt:browser-router
description: Trigger only on /browser-router. Create routing for any links that are not ordinary web URLs, so a click on this Mac runs the saved route instead of opening a page.
---

# browser-router

When the user says `/browser-router`, or you are about to paste markdown that contains `localhost`, `127.0.0.1`, or a custom scheme:

1. Write the markdown to a file.
2. Run `tools browser-router links --convert <file>`.
3. Paste the command's stdout. Do not paste the original local links.

Ordinary `https://` websites are left unchanged. Local links become links on the config's link host (`https://<linkHost>/...`, set with `tools browser-router link-host <host>`); without a link host the command refuses and names that command. `--uses 3` makes each of those links work three times; omit it for a stable link.

GenesisTools.app (`~/Applications/GenesisTools.app`) is the http(s) handler and routes every click itself. There is no separate router app. `tools browser-router install` builds GenesisTools.app and runs `GenesisTools --default-browser set`, which makes macOS ask the user to confirm. Never build or install another handler app.

## Before you print a clickable link

Run `tools browser-router status --json` once per session. A link works only when `linkHost` is set, `installed` and `defaultHandler` are both true, and the preset you need is in `enabledPresets`. Build the link on `linkHost`, never on a hardcoded host. Otherwise print the plain command instead of the link, with this sentence: "GenesisTools.app does not route this link on this Mac yet, so run this instead:". `extension` false means the link works when clicked in another app but not typed or clicked inside a browser. A preset row with a non-empty `drift` list still routes, with an older action; `tools browser-router presets sync` restores it. TypeScript callers use `linkFor()` from `@genesiscz/utils/browser-router/links`, which applies the same check and returns null.

## Routes

Write a route as a URL with `:name` placeholders, not a regular expression. `{name}` in `--arg` is that placeholder. `--touch-id` asks for Touch ID or the Mac password before the command, for every value of its parameters.

A click shows a card in the bottom-left corner of the screen: the Genesis Tools mark, then Opening or Running, then a short log. It fades after `toast.seconds` (default 5). Set `toast` on the config to change it for every route, or on one route to override. `"toast": false` hides it. `--no-toast`, `--toast-seconds`, and `--toast-title` set the override when you save a route.

`tools browser-router presets` lists the presets. `core` (minted links, bundles, wrapped links) is a default preset and always on when a link host is set. Every other preset is installable and off until the user runs `tools browser-router presets enable <id>` (`--only a,b` for `local-services` and `dashboard-names`); `presets disable <id>` switches it off. Never enable a preset for the user without being asked.

## Local servers start themselves

With the `local-services` preset, a click on `http://localhost:<port>/...` or `http://127.0.0.1:<port>/...` for a port in the dashboard registry (`src/utils/ui/dashboards.ts`) runs `tools browser-router ensure <port>` first. A running server opens at once. A stopped one is started, the card says "Starting <name>" until the port listens (20 s at most), then "Opening", and the page opens. On a timeout the card shows the error and the log path, and the dead page is not opened. These `service` routes run without a prompt, because they only start a known local server. With `dashboard-names`, `https://<key>/...` and `https://<linkHost>/<key>/...` do the same for a dashboard's registry key. An alias in the config (`{ "host": "dashboard", "base": "http://localhost:3096" }`) renames a host first.

Example: an old note links `http://localhost:3042/qa`. The click starts the dev-dashboard and then opens the page.

## Many links, one click

- `tools browser-router tabs save <name> <url...>` saves a named bundle and prints `https://<linkHost>/tabs/<name>`. `--from-md <file>` adds every http(s) link in a note (not those in code fences).
- `tools browser-router tabs mint <url...> [--uses N]` prints one minted link, `https://<linkHost>/t/<id>`, that opens every URL. Each click spends one use.
- A click opens the plain pages in one new window of the default browser (Brave, Chrome, Edge and Vivaldi; Safari opens them as tabs). A link that has its own route (an action on the link host) is routed as if it was clicked. A bundle link inside a bundle is skipped, so a bundle cannot open itself.
- Above 15 links a dialog asks before anything opens.

When you (Claude, Grok, a bot) would paste more than three links for the user to open together, mint one bundle link instead: `tools browser-router tabs mint --from-md <file>` or `tools browser-router tabs mint <url> <url> ...`, then paste `[Open all N](https://<linkHost>/t/<id>)`. Check `status --json` first; without the router, paste the plain list.

Every clicked page is cleaned before it reaches the browser: Outlook safelinks, Google `/url?q=`, Slack and Teams redirectors are unwrapped, and `utm_*`, `fbclid`, `gclid` and `mc_eid` are removed. Set `"clean": false` in the config to turn it off.

## Answer a DECISION with a click

`tools claude decide --session ID --decision 4 --option b` types the fixed line `DECISION 4: b)` into the cmux pane of that Claude session. The session must exist on this Mac. `--question <formId>` also closes a pending `tools question` form with the same letter.

The `decide` preset answers into a live session with no approval card, so it is only on when the user enabled it: `tools browser-router presets enable decide`. Then `tools claude decide links --decision 4 --options a,b,c --labels "Keep,Drop,Later"` prints one markdown link per option for the session that runs the command:

```markdown
**a)** [Keep](https://<linkHost>/decide/<session>/4/a)
```

A link carries only the session id, the number and one letter. Anything else does not match the route.

## Run Claude in a new cmux surface

`tools cmux launch --prompt <text>` prints the quoted command for a new cmux surface. With `--open` it opens the surface (`--surface new|split|workspace`) and runs the command there. `--account` defaults to the default Claude account. The cmux-claude preset passes `--open`. A raw link that starts an agent always asks; only a link minted on this machine (`handoff_post` adds one as `paste.runLink`) runs without the card, once.

```bash
tools browser-router route 'http://127.0.0.1:8787/add/:id' --run <program> --arg add --arg '{id}' --arg --qty --arg '{qty}' --notify 'Added' --approval allow
tools browser-router route 'https://links.example.com/open' --route-to 'genesis-md://open'
tools browser-router links --convert <file> --uses 1
tools browser-router explain <url>
```

`$1` is a capture. `{qty}` is a query parameter. `{ids*}` as its own `--arg` splits on commas. `--approval ask` (the default) shows Allow / Deny. `--approval allow` runs the argv with no shell. Config: `~/.genesis-tools/browser-router/config.json`.

## When a link does the wrong thing

1. Check which app has the links: `~/Applications/GenesisTools.app/Contents/MacOS/GenesisTools --default-browser status`. `https=` must be GenesisTools.app. If it is anything else, run `tools browser-router install` (or `GenesisTools --default-browser set`) and let the user confirm the macOS prompt.
2. Read the last lines of `~/.genesis-tools/browser-router/router.log`. A route the installed app cannot parse is skipped with `router: skipped routes[N]` (the other routes keep working); the rest of the log names the decision for the URL.
3. Prove what the installed app decides with its own validator: `cd src/browser-router/native && swiftc -O Router.swift Cli.swift -o /tmp/router-cli`, then `/tmp/router-cli ~/.genesis-tools/browser-router/config.json <url>`. `tools browser-router explain <url>` runs the TypeScript router (`src/utils/browser-router/route.ts`), which can be newer than the installed app: compare `stat` of `~/Applications/GenesisTools.app/Contents/MacOS/GenesisTools` with `Router.swift`, and run `bun run app` when the source is newer.
4. A window of GenesisTools.app (`--hub`, `--review`) that is open receives the click first and hands it to a new instance, then gives focus back to the app the link was clicked in. If a link brings the hub to the front instead, the running hub is from an older build: restart it.

Seen 2026-09-24: a `token` route written into routes[0] that an older build could not parse made every link fall back (now skipped instead); later an old standalone router app was rebuilt and took the https handler away from GenesisTools.app (that app no longer exists).
