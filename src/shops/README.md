# tools shops

Personal price tracking for Czech grocery, drugstore, pharmacy and general eshops. It keeps a local SQLite catalog of
products and prices from 19 shops, links the same product across shops, watches favorites for price drops, and sends
alerts. It also reads past orders from connected rohlik.cz and kosik.cz accounts. A web dashboard and an MCP server
sit on the same database.

## Quick start

```bash
# The supported shops and what each one can do
tools shops shops

# Ingest one product with its price history (use a real product URL from the shop)
tools shops get https://www.rohlik.cz/1234567-example-chocolate

# Alert when that product gets 15% cheaper (the same real URL)
tools shops watch add https://www.rohlik.cz/1234567-example-chocolate --drop 15

# Register the hourly watchlist check with the GenesisTools scheduler
tools shops daemon enable

# Pending alerts
tools shops notify list

# Start the dashboard and open http://localhost:3073
tools shops ui open
```

The database is created and migrated on first use. `tools shops db migrate` is only needed to run migrations by hand.

`daemon enable` only registers the tasks. They run while the `tools daemon` scheduler runs, so install it once with
`tools daemon install` (it starts now and at every login).

## Commands

Global flags: `-v, --verbose` (verbose logging), `--readme` (print this README), `-V, --version`.

### Products and catalogs

| Command | What it does |
|---|---|
| `get <url>` | Ingest one product URL: history and metadata from Hlídač Shopů, stored locally |
| `crawl --shop <origin>` | Crawl a shop's catalog through its own API into the local DB |
| `sitemap-sync` | Find product URLs in a shop's public sitemap and diff them against the DB |
| `sitemap-crawl --shop <origin>` | Walk a shop's sitemap and ingest every product found |
| `list <shop>` | List products of one shop from the local DB |
| `shops` | Print the shop table: live, history, listing, EAN, search, bot protection |

`get <url>` flags:

- `--json`: print JSON (`source`, `product`, `masterProductId`, `pricesRecorded`) instead of a table.
- `--out <path>`: also write the output to a file. `--save`: also copy it to the clipboard.
- `--full-history`: accepted, but it has no effect. The S3 data source already returns the full series, and the
  `/v2/detail` fallback takes no history length. The help text still says "default: 365 days".
- `--no-cache`: accepted, but a no-op. There is no local response cache yet.
- `--match`: prints a stub line only. Matching runs on every ingest anyway; see `match` below.

When Hlídač Shopů has no name, brand or EAN for the product, `get` asks the shop's own client for them. Without brand
and EAN the matcher cannot link the product to the same item in another shop. Six shop clients cannot read a single
product, so `get` skips this step for them without an error: `albert.cz`, `billa.cz`, `tetadrogerie.cz`, `dm.cz`
and `mojadm.sk` (not implemented), and `alza.cz` (its client gets no browser for one-product reads). For these shops,
brand and EAN come only from a crawl. `mall.cz` is offline; see "Shops" below.

`crawl` flags: `--shop <origin>` (required, for example `rohlik.cz`), `--category <id>` (one shop-side category),
`--limit <n>` (stop after N products). Ctrl+C cancels the run cleanly. A failed run exits 1. Without `--category` the
crawl walks every category the client lists. The `alza.cz` client lists none, so an `alza.cz` crawl needs
`--category <id>` (an Alza category id), or it crawls nothing.

`sitemap-sync` and `sitemap-crawl` support `kosik.cz`, `rohlik.cz` and `lidl.cz` only.

- `sitemap-sync`: `--shop <origin>` or `--all` (all three, one after another), `--max-urls <n>` (loose cap per shop),
  `--print` (print every new URL, not only a sample of 5). It does not ingest products.
- `sitemap-crawl`: `--shop <origin>` (required), `--limit <n>`, `--concurrency <n>` (per-id fan-out for clients
  without a bulk endpoint, kosik), `--refresh` (re-fetch products already in the DB; default skips them).
  After the shop pass it backfills price history from Hlídač Shopů: `--no-hlidac` skips that,
  `--hlidac-force` re-fetches history that is already stored, `--hlidac-concurrency <n>` sets parallel S3 fetches
  (default 10), and `--hlidac-only` skips the shop API and only drains history for products already in the DB.

`list <shop>` flags: `--cat <id>`, `--limit <n>` (default 50), `--search <query>` (full-text, prefix match that
ignores diacritics).

### Watchlist and alerts

| Command | What it does |
|---|---|
| `watch add <url>` | Add a product to the watchlist (ingests it first when it is new) |
| `watch list [--json]` | Active favorites with their current state |
| `watch edit <id>` | Change thresholds, label, cooldown, or `--active on\|off` |
| `watch remove <id>` | Remove a favorite |
| `watch tick` | Run one evaluation pass and print a JSON report (the daemon runs this) |
| `notify list` | Pending notifications |
| `notify ack [id]` | Acknowledge one notification, or `--all` |

`add` is the default subcommand of `watch`, so `tools shops watch <url>` also adds a favorite.

`watch add <url>` flags:

| Flag | Meaning |
|---|---|
| `--target <n>` | Alert when the price is at or below N CZK |
| `--drop <pct>` | Alert when the price falls this share below the reference |
| `--drop-abs <n>` | Alert when the price falls N CZK below the reference |
| `--shop <origin>` | Watch one shop only (default: every linked shop) |
| `--label <text>` | A note shown with the favorite |
| `--cooldown <d>` | Time between alerts of the same reason: `24h`, `2d` or hours (default 24) |
| `--notify-back-in-stock` | Also alert when the product is back in stock |

The reference is the lowest current price when you added the favorite (in the `--shop` shop, when you set one).
`watch edit` does not change it. A favorite added while no shop had a current price has no reference, so its
`--drop` and `--drop-abs` alerts never fire.

`--drop` reads a number above 1 as a percent and a number of 1 or less as a fraction. `15`, `15%` and `0.15` all
mean 15%. The `%` sign is removed first, so `1%` and `1` both mean a 100% drop, which a real price never reaches.
Write 1% as `0.01`.

`watch edit <id>` takes `--target`, `--drop`, `--drop-abs`, `--label`, `--cooldown` and `--active <on|off>`, and
prints the updated favorite as JSON.

An alert has one of four reasons: `target-price`, `drop-percent`, `drop-absolute`, `back-in-stock`.

`notify list` flags: `--all` (include acknowledged), `--reason <reason>`, `--shop <origin>`, `--limit <n>`
(default 100), `--json`.

### Background tasks

| Command | What it does |
|---|---|
| `daemon enable [--overwrite]` | Register the two shops tasks with `tools daemon` |
| `daemon disable` | Unregister them |
| `daemon status` | Show the `shops:*` lines of `tools daemon status` |

The two tasks:

- `shops:watchlist-check` runs `tools shops watch tick` every hour (3 retries, no daemon notification of its own).
- `shops:prune-http-requests` runs `tools shops db prune-http` every day.

The tasks run only while the `tools daemon` scheduler runs. Install it once with `tools daemon install`, and check
it with `tools daemon status`: that command says whether the daemon runs, and `tools shops daemon status` keeps only
the `shops:*` task lines of its output.

### Cross-shop matching

Every ingest links the product to a master product, so one item has one price comparison across shops. Pairs the
matcher is not sure about wait for you.

| Command | What it does |
|---|---|
| `match review` | Pending gray-zone candidate pairs, as JSON |
| `match accept <a> <b>` | Accept a pair and merge the two masters |
| `match reject <a> <b>` | Reject a pair for good |
| `match rematch <input>` | Reset a product to pending; it re-matches on the next crawl flush |
| `match verify [--json]` | Run the golden-pair harness and print F1, precision and recall |

`a`, `b` and `input` are product URLs or product ids.

The matcher tries layers in order:

- Layer 0: the same EAN. It is ground truth, also for duplicates inside one shop.
- Layer 1: the same brand, unit, amount and flavor, with a fuzzy name score of 0.90 or more.
- Layers 2a and 2b: signatures without flavor (0.92) or without size (0.95).
- Layer 3: the same brand. A score of 0.95 links at once. A score from 0.92 to 0.95 becomes a candidate. A cross-shop
  name variant with 0.70 similarity and 0.70 token containment also becomes a candidate, never a link.
- Layer 4: any master with a word similarity of 0.92 or more becomes a candidate.

A multipack guard keeps a multipack from linking to a single item: two pack counts must agree, and an unknown count
matches another unknown count or a count of 1. The thresholds are in `src/shops/lib/matcher-config.ts`.

`match verify` reads `tests/fixtures/matching/golden-pairs.json` relative to the current folder, so run it from the
GenesisTools checkout root.

### Shop accounts and past orders

| Command | What it does |
|---|---|
| `provider-connect rohlik.cz` | Connect a rohlik.cz account with `--email` and `--password` |
| `provider-connect kosik.cz` | Connect a kosik.cz account with `--cookie <sid>` |
| `orders-sync` | Pull past orders from connected accounts and link their items to products |

Without the flags, `provider-connect` prompts in a terminal and fails in a non-interactive run. For kosik.cz, log in
on the site, then copy the `sid` cookie from DevTools (Application, Cookies, www.kosik.cz). Both commands take
`--user <id>` (default 1).

`orders-sync` flags: `--shop <origin>`, `--limit <n>` (orders per account, default 20), `--user <id>` (default 1).
It prints new orders, new items, matched items and auto-added favorites per account. An account with auto-watchlist
on (set on the dashboard's providers page) adds each matched item to the watchlist with a 10% drop and a 24 hour
cooldown, unless the account's watchlist defaults say otherwise.

Run `provider-connect rohlik.cz` in a terminal without `--password` and type the password at its hidden prompt. A
password on the command line stays in your shell history and shows in the process list. Pass `--password` only from
a script that reads it from a secret store.

```bash
tools shops provider-connect rohlik.cz --email alice@example.com   # then type the password at the prompt
tools shops orders-sync --shop rohlik.cz --limit 50
```

### Database

| Command | What it does |
|---|---|
| `db info` | DB path, size and row count per table |
| `db migrate` | Run pending migrations (they also run on every open) |
| `db vacuum` | Run `VACUUM` |
| `db prune-http [--days <n>]` | Delete `http_requests` rows older than N days (default 30) |

### Dashboard

`tools shops ui` (alias `dashboard`) runs the Vite dashboard on port 3073. Without a subcommand it shows a menu, or
does the obvious action; `-i` forces the menu.

| Command | What it does |
|---|---|
| `ui up` | Start in the background |
| `ui down` (`stop`) | Stop it |
| `ui restart` | Stop and start again |
| `ui status` | pid, port, uptime, dependencies, launchd state |
| `ui open` | Start it if needed, print the URL and a QR code, open the browser |
| `ui logs` | The last lines of the background log |
| `ui attach` | Tail the log. Ctrl+C detaches; the server keeps running |
| `ui install` | Register a launchd plist: it survives a reboot and restarts after a crash |
| `ui uninstall` | Remove that plist |

Flags:

- `up` and `restart`: `-f, --foreground` (block until killed), `-p, --port <n>`, `--force` (kill a conflicting
  process first), `--no-open` (keep the browser closed), `-i` (force the menu).
- `down`: `--no-force` (do not escalate to SIGKILL after the grace period).
- `open`: `-p, --port <n>`, `--no-qr`, `--no-open` (print the URL only), `-q, --query <key=value>` (repeatable).
- `logs`: `-n, --lines <n>` (default 200). `attach`: `-n, --lines <n>` (default 50 lines first).
- `install`: `--force`, `-p, --port <n>`.

The pages: watchlist (the default landing page), browse, compare, product and master detail, coverage, live (HTTP
traffic and crawl runs), workspace, notifications, orders, providers, match review, settings. The dashboard asks you to
log in. Register an account on `/register` (password of 6 characters or more); a session lasts 30 days.

### MCP server

`tools shops mcp` runs a stdio MCP server. It always offers 8 read tools. `--allow-write` adds 5 write tools.

- Read tools: `shops_get_product`, `shops_match_product`, `shops_search`, `shops_list_categories`,
  `shops_compare_prices`, `shops_coverage`, `shops_watch_list`, `shops_recent_notifications`.
- Write tools (need `--allow-write`): `shops_ingest`, `shops_accept_match`, `shops_watch_add`, `shops_watch_remove`,
  `shops_notify_ack`.
- Resources: `shops://product/<shop>/<slug>` and `shops://master/<id>` return the JSON the matching tools return.

The logger writes to stderr, so stdout carries only JSON-RPC frames.

Register it in Claude Code:

```bash
claude mcp add shops -- tools shops mcp
```

Or add it to an MCP client's `mcpServers` config:

```json
{
  "mcpServers": {
    "shops": {
      "command": "tools",
      "args": ["shops", "mcp"]
    },
    "shops-write": {
      "command": "tools",
      "args": ["shops", "mcp", "--allow-write"]
    }
  }
}
```

Use the read-only entry by default. Switch to `shops-write` only when the agent must ingest products, accept matches,
or change the watchlist.

### Developer utilities

`dev capture-fixture --shop <origin> --url <url>` records a fixture from a live shop page into
`src/shops/api/shops/__fixtures__/<shop>/`. `--out <dir>` changes the fixtures root. The default root is relative to
the current folder, so run it from the GenesisTools checkout root, or pass an absolute `--out`. For a WebView shop,
`--evaluate <expr>` sets the JavaScript to run in the page (each shop has a default) and writes its result as
`<slug>.evaluate.json` beside the HTML.

## How it works

### Shops

19 shop clients are registered: `rohlik.cz`, `kosik.cz`, `kaufland.cz`, `alza.cz`, `drmax.cz`, `notino.cz`,
`benu.cz`, `mall.cz`, `mountfield.cz`, `itesco.cz`, `pilulka.cz`, `knihydobrovsky.cz`, `hornbach.cz`, `dm.cz`,
`billa.cz`, `lidl.cz`, `tetadrogerie.cz`, `albert.cz`, `mojadm.sk`. Each one has a crawler. `tools shops shops` prints
what each client can do.

`mall.cz` is offline: Allegro acquired it in 2025. Its client stays registered, but every capability is off, and every
product or listing call fails with an error that says so. Six other clients cannot read a single product page (see
`get` above), so the shop's own brand and EAN for their products come only from a crawl.

Bot protection is `akamai` for `alza.cz` and `itesco.cz`, `soft` for `kaufland.cz`, `lidl.cz` and `tetadrogerie.cz`,
and `none` for the rest.

`alza.cz` runs through `Bun.WebView`, a headless browser that needs Bun 1.3.12 or newer. The other shops use HTTP.
Each client limits itself to 2 requests per second unless its code sets another rate.

Price history comes from Hlídač Shopů (`api.hlidacshopu.cz` and its S3 data at `data.hlidacshopu.cz`). The shop
clients add current prices, stock, brand, EAN and categories.

### Data on disk

The tool's data lives under `~/.genesis-tools/shops/`:

| Path | What it holds |
|---|---|
| `index.db` | The SQLite database |
| `settings/<user id>.json` | Dashboard settings, one file per user |
| `.secret-key` | The 32-byte key that encrypts stored shop credentials (mode 0600) |

The dashboard's process files live with the other GenesisTools dashboards: the pid file is
`~/.genesis-tools/dashboards/shops.pid`, and the background log, which `ui logs` and `ui attach` read, is
`~/.genesis-tools/logs/shops.bg.log`.

The database tables: `shops`, `categories`, `master_categories`, `products`, `product_categories`, `master_products`,
`match_candidates`, `prices`, `crawl_runs`, `favorites`, `notifications`, `http_requests`, `brand_aliases`, `users`,
`sessions`, `user_providers`, `user_orders`, `user_order_items`, plus the `current_offers` view and the `products_fts`
full-text index (FTS5, diacritics removed). The migrations in `src/shops/db/migrations/` are the full schema
reference.

Every shop API call is recorded in `http_requests`. The dashboard's live page reads it, and it is the record for
traffic analytics, debugging of captchas and 403 answers, and rate-limit tuning. The MCP tools do not read it. Do
not truncate it by hand outside an explicit maintenance step; the daily prune task keeps it to 30 days.

Shop credentials (the rohlik.cz email and password, the kosik.cz `sid` cookie) are stored in `user_providers`,
encrypted with AES-256-GCM under `.secret-key`. The first run that needs the key creates it. If you lose the key, the
stored credentials cannot be read; connect the accounts again.

### Users

The database has users because the dashboard has accounts. Migration 003 seeds a local user with id 1. The CLI acts
as that user: `watch` and `notify` always use id 1, and `provider-connect` and `orders-sync` default to it. A
dashboard account you register gets a new id, so its watchlist and notifications are separate from the CLI's.

### Alerts

`watch tick` compares each active favorite with the current offers and writes a notification when a threshold is
met and the cooldown has passed. It then sends the alert to these channels:

- macOS banner, through the shared notification channel (GenesisTools.app, else `terminal-notifier`). A click opens
  the shop page, or the product page on the dashboard.
- Telegram, when `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set, or when `tools telegram-bot` is configured.

The tick also publishes a `notification-fired` web event, but only to live-event subscribers in its own process.
`watch tick` runs in the CLI or the daemon, and the dashboard is another process, so an open dashboard does not get
this event. The dashboard shows tick alerts on its notifications page, which it reads from the database.

## Configuration

The dashboard's settings page writes `settings/<user id>.json`. The keys and defaults:

| Key | Default | Notes |
|---|---|---|
| `default_landing_view` | `/watchlist` | Also `/`, `/browse`, `/live`, `/workspace` |
| `theme` | `cyberpunk` | Also `wow` |
| `notification_channels` | macOS, web on | Telegram off; see below |
| `default_cooldown_hours` | 24 | |
| `http_requests_retention_days` | 30 | 1 or more |
| `default_rate_limit_per_second` | 2 | |
| `shops` | `{}` | Per shop: `enabled`, `rate_limit_per_second` |
| `daemon_enabled` | false | |

`notification_channels` holds the switches `macos` (on), `web_sse` (on) and `telegram` (off), plus
`telegram_bot_token` and `telegram_chat_id` (both empty).

Only the dashboard reads these keys. The CLI and the background tasks use their own defaults: see Troubleshooting for
the alert channels, the daemon toggle and the retention window. The rate-limit keys do not change the shop clients.

An older single-user `~/.genesis-tools/shops/config.json` is copied to `settings/1.json` the first time user 1's
settings are read.

Environment variables:

| Variable | Effect |
|---|---|
| `SHOPS_SECRET_KEY_PATH` | Use another file for the credentials key |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Send watchlist alerts to this Telegram chat |
| `ALBERT_PERSISTED_QUERY_HASHES_JSON` | Replace the albert.cz query hashes (see below) |
| `SHOPS_LIVE_SMOKE`, `SHOPS_LIVE_ITESCO` | Turn on the live network tests (development only) |

`ALBERT_PERSISTED_QUERY_HASHES_JSON` is a JSON object that replaces the built-in albert.cz GraphQL persisted-query
hashes.

## For agents

- JSON output: `get --json`, `watch list --json`, `notify list --json`, `match review` (always JSON),
  `match verify --json`, `watch tick` (always JSON), `watch edit` (always JSON, the updated favorite).
- Exit codes:
  - `crawl` exits 1 when the run fails.
  - `sitemap-sync` exits 1 for an unknown shop, when neither `--shop` nor `--all` is given, or when a sync fails.
    `sitemap-crawl` exits 1 for a missing or unknown `--shop`, or a failed crawl.
  - `match verify` exits 1 when F1 is below 0.95, but only in the human output. With `--json` it always exits 0, so
    read `f1` from the JSON.
  - `provider-connect` exits 1 on an error.
  - `orders-sync` exits 1 only when it cannot open the database or read the account list. A failed account prints
    a `×` line to stdout, the sync continues with the next account, and the exit code stays 0, even when every
    account fails.
- Prefer the MCP server (read-only by default) over shelling out. It answers searches, comparisons and coverage from
  the local DB without network calls.
- Nothing here costs money. Crawls send real traffic to the shops, so keep `--limit` small when you test.

## Troubleshooting

- **The dashboard settings change nothing about alerts.** `watch tick` does not read `notification_channels`: the
  macOS banner always fires, and Telegram depends only on the environment variables or `tools telegram-bot`. Set
  those instead.
- **An open dashboard shows no live alert after a tick.** The tick runs in another process, so its web event never
  reaches the dashboard (see "Alerts" above). Open the notifications page, or run `tools shops notify list`.
- **The dashboard's daemon toggle does not schedule anything.** It only stores `daemon_enabled`. Run
  `tools shops daemon enable`, and check it with `tools shops daemon status`.
- **The watchlist check never runs.** `daemon enable` only registers the tasks. Run `tools daemon install` once, then
  check with `tools daemon status` that the daemon runs.
- **`http_requests_retention_days` has no effect.** The prune task runs `db prune-http` without `--days`, so it keeps
  30 days. Run `tools shops db prune-http --days <n>` for another window.
- **`ui up` fails with "Could not find vite".** Run `bun install` in the GenesisTools checkout.
- **A crawl of alza.cz or itesco.cz stops with 403, 429 or 503.** Both sit behind Akamai, and the itesco.cz client
  detects its block page. Wait, then retry with a smaller `--limit`. The dashboard's live page and the `http_requests`
  table show the failed calls.
- **`alza.cz` fails with "Bun.WebView requires Bun >= 1.3.12".** Run `bun upgrade`.
- **albert.cz fails with "no persisted-query hash".** The shop changed its GraphQL hashes. Set
  `ALBERT_PERSISTED_QUERY_HASHES_JSON`; the refresh steps are in the JSDoc of `src/shops/api/shops/AlbertClient.ts`.
- **`provider-connect` says it needs `--email` and `--password` (or `--cookie`).** The run has no terminal to prompt
  in. Pass the flags.
- **A product added in the dashboard is missing from `tools shops watch list`.** The dashboard account is another
  user than the CLI's user 1. See "Users" above.

## Contributing

The Hlídač Shopů project is the reference for its API and data. A read-only reference clone lives in
`_Playgrounds/hlidac-shopu/` beside the projects.

## Related

- [daemon](../daemon/README.md): runs the hourly watchlist check and the daily prune.
- [notify](../notify/README.md): macOS notifications from the command line.
- [telegram-bot](../telegram-bot/README.md): the shared Telegram bot for alerts.
- [alza](../alza/README.md): the Alza catalog and account as a tool of its own.
