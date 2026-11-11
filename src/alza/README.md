# tools alza

Alza.cz from the terminal and as an MCP server. Search the catalog, read a product with its reviews, questions and
real price history, find deals and AlzaBox lockers, check a PC parts list, and use your own account: basket,
favourites, orders, watchdogs, warranty claims. Unofficial; not affiliated with Alza. Nothing in this tool places an
order, pays, cancels or changes account details.

## Quick start

```bash
tools alza search ssd --sort rating --limit 10            # the best rated products of a search
tools alza product AUPR65708                              # one product: price, stock, warranty, EAN, every parameter
tools alza history AUPR65708                              # lowest and highest price, the claimed and the real discount
tools alza deals --category 18851284 --min-discount 20    # the biggest discounts of a category
tools alza auth login                                     # sign in once in the browser; no password reaches the tool
tools alza cart add AUPR65708 --qty 2                     # put it in the basket (orders nothing)
```

A product argument is a product code (`AUPR65708`), a numeric id (`9383715`) or a product URL.

## Commands

Global options go before the command, for example `tools alza --country sk --json search ssd`.

| Option | What it does |
|---|---|
| `--country [id]` | Storefront: `cz` (default), `sk`, `hu`, `at`, `de` |
| `--json` | Print the result data as JSON |
| `-v, --verbose` | Verbose logging |
| `--readme` | Print this README |

A flag shown as `[value]` (`--country`, `--sort`, `--profile`, `--cpu`) opens a picker when you give it bare in a
terminal. Without a terminal, a bare or unknown value prints the allowed values and exits 1.

### Catalog (no sign-in)

```bash
tools alza search alkohol tester --sort rating --limit 10
tools alza search monitor --brand 1602 --max 5000 --in-stock --discounted
tools alza search monitor --page 0 --skip 20              # continue at the "next" of the answer before
tools alza category 18851284 --brand 15529 --filter 15361:239455089
tools alza product AUPR65708                              # code, numeric id or product URL
tools alza reviews AUPR65708 --limit 100                  # newest first, with pros, cons and the star distribution
tools alza questions AUPR65708 --no-answers               # the questions without the answers
tools alza compare AUPR65708 Moto19476                    # 2 to 6 products side by side
tools alza alternatives Moto19476                         # Alza's own list, or else the best rated of its category
tools alza suggest alkohol                                # search-box phrases, products, categories, brands (with ids)
tools alza categories                                     # the top level of the category tree
tools alza categories 18851284                            # one category: its path and subcategories
tools alza filters 18851284                               # brand ids and parameter filter ids of a category
tools alza deals alkohol tester                           # discounted products of a search, biggest discount first
tools alza deals --category 18851284 --min-discount 20 --pages 8
tools alza ean 8594190030364                              # by EAN barcode: 1 to 20 codes, 8 to 14 digits each
tools alza history AUPR65708                              # Hlídač shopů: lowest, highest, 30-day low, real discount
tools alza pickup 11000 --limit 5                         # AlzaBox lockers near a postal code, a place or "lat,lon"
```

`search` and `category` share the listing flags:

| Flag | What it does |
|---|---|
| `--limit <n>` | How many products: `search` default 20 (max 100), `category` default 24 (max 200) |
| `--page <n>` | First page: 0-based for `search`, 1-based for `category` |
| `--skip <n>` | Matching products of the first page to leave out (the `skip` of `next`) |
| `--brand <id>` | Brand id from `filters` |
| `--min <price>`, `--max <price>` | Price range in the storefront currency |
| `--in-stock` | Only products you can buy now |
| `--discounted` | Only discounted products |
| `--sort [order]` | `search` only: `relevance` (default), `price-asc`, `price-desc`, `newest`, `rating` |
| `--filter <paramId:valueId>` | `category` only, repeatable; the ids come from `filters` |

A listing that reaches `--limit` inside a page ends with `next: page N, skip K` (in `--json`, `next`). Pass both back
(`--page N --skip K`) and the rest of that page comes first, so no product is lost between two calls. The price,
stock and discount filters apply to the pages the tool reads, so a narrow filter can read many pages: one call reads
at most 20 pages (a search page holds 25 products) and then names where to continue.

Other limits: `reviews --limit` default 50 (max 500), `questions --limit` default 25 (max 200), `alternatives
--limit` default 10 (max 50), `deals --limit` default 30 (max 200), `deals --pages` default 4 (max 20; that many pages
are read, fewer when the listing ends, however sparse the discounts are), `deals --min-discount` 1 to 99 (default 1),
`pickup --limit` default 10 (max 100). `alternatives` says in its `source` field (`alza` or `category`) which list it
returns, because Alza's own list is empty for many products.

### PC builder

```bash
tools alza pc check BD750k7a1 AGb650ea DP095b32a64 UY006rm85new CBh5f5   # compatibility of a parts list
tools alza pc check BD750m7b1:psu AGb650ea                               # code:role when the role detection fails
tools alza pc suggest 40000 --profile gaming --cpu amd --skip storage    # a compatible build within 40 000 CZK
tools alza pc suggest 30000 --profile office --fixed BD750m7b1:psu       # build around a part you already chose
```

`pc check` takes 1 to 10 parts and reads each product once. It detects each part's role (`cpu`, `motherboard`, `ram`,
`gpu`, `storage`, `case`, `cooler`, `psu`) from its spec table, else from its name; append `:role` when that fails.
A role you give must agree with the spec table: a role the specs contradict is refused. RAM and storage may repeat.
It checks: CPU socket and motherboard socket, RAM generation, module type and slots against the motherboard, RAM
generation against the CPU memory controller, PSU wattage, GPU length and cooler height or radiator against the case,
cooler socket, motherboard and PSU form factor against the case, and the display output
(a GPU or the CPU's integrated graphics). The verdict, in this order, is `incompatible` when a rule fails,
`needs_review` when one warns or lacks data, `no_conflicts_found` when the build lacks a CPU, motherboard, RAM, PSU
or case, and `compatible` otherwise.

The PSU rule estimates the peak draw: 75 W for the platform, the CPU's TDP times 1.35, and the GPU's board power (40%
of the vendor's recommended PSU when there is no TDP row). A missing spec counts as 150 W for a CPU or 250 W for a GPU,
and the answer names that assumption. A PSU below the draw fails; below the draw plus `--headroom` (default 0.3, from
0 to 1) it warns. The recommended size is also at least the GPU vendor's recommended PSU. When the draw uses the
150 W or 250 W fallback, the rule warns even when the PSU is large enough.

`pc suggest` takes a budget from 8 000 to 500 000 CZK, fixed parts included, and runs on the `cz` storefront only. It
picks in the order cpu, motherboard, ram, gpu, storage, case, cooler, psu, and each pick must fit the earlier ones and
the `--fixed` parts (up to 6, repeatable). `--profile` splits the budget: `gaming` (default) gives the GPU 38%,
`workstation` gives the CPU 30%, and `office` has no GPU. `--skip <role>` (repeatable) leaves a role out,
`--max-fetches <n>` bounds the product reads (default 14, max 24). It reads one category page per role plus those
product reads, so it takes about a minute.

### Sign-in

```bash
tools alza auth login                    # opens the sign-in page, then asks for the alza://identity?code=… URL
tools alza auth login --no-open          # the same, but prints the URL instead of opening the browser
tools alza auth login --print-url        # step 1 without a terminal prompt: print the sign-in URL and exit …
tools alza auth login --redirect-url 'alza://identity?code=…&state=…'   # … step 2: finish with the pasted URL
tools alza auth status                   # reads only: expiry, user id, one check that Alza accepts the token
tools alza auth logout                   # forget the tokens; the visitor basket stays
```

After the sign-in the browser tries to open `alza://identity?code=…` and cannot; that is expected. Copy that URL from
the address bar, the "open this app?" message, or the DevTools Network tab (turn on "Preserve log" before you sign
in). The prompt also takes the bare code. The code is single-use and expires within minutes, and a waiting sign-in
older than 30 minutes is refused.

### Basket and lists (signed in or as a visitor)

```bash
tools alza cart                          # the basket and its total (same as `cart show`)
tools alza cart add AUPR65708 --qty 2    # 1 to 99 pieces (default 1); orders nothing
tools alza cart remove AUPR65708
tools alza favorites                     # the favourites list, Oblíbené (same as `favorites list`)
tools alza favorites add AUPR65708       # --later uses the buy-later list
tools alza favorites remove AUPR65708 --later
```

Signed out, the basket and the lists belong to an anonymous visitor that the tool keeps between runs, one per
storefront. Signed in, they are the account's.

### Orders (signed in)

```bash
tools alza orders                                  # active and archived orders (same as `orders list`)
tools alza orders list --active-only               # leave the archive out
tools alza orders list --hide-cancelled --limit 20 # archive page size up to 100
tools alza orders show 1012345678                  # one order: parts, status, dates (--json for the full answer)
tools alza orders search 1012                      # search by order number or product words; shows invoice links
tools alza orders document '<link from orders search>' --out invoice.pdf   # --overwrite replaces an existing file
tools alza orders payments 1012345678 1012345678   # payment options still open for an unpaid order part (reads only)
```

`orders document` needs `--out`. It follows only pdf.alza.cz links (read with a plain fetch, because they are binary
PDFs) and order routes (`/api/users/<id>/v<n>/orders/<order>/…`) on alza.cz, www.alza.cz, m.alza.cz, webapi.alza.cz
and api.alza.cz. It checks the shape of the route, not that the user id or the order belongs to the signed-in
account. It never follows a redirect, so the token cannot leak to another host, and it saves at most 8 MiB within
30 seconds.

### Watchdogs (signed in)

```bash
tools alza watchdog                                # your watchdogs, Hlídací pes (same as `watchdog list`)
tools alza watchdog list --limit 50                # up to 100
tools alza watchdog list --items                   # only the watchdogs that fire now, as Monitor item lines
tools alza watchdog add AUPR65708 --price 1999 --stock   # alert below a price, back in stock, or both
tools alza watchdog remove AUPR65708               # the watched product, or a watchdog id from `watchdog list`
```

`watchdog add` with neither flag watches the stock. Alza sends the alert by email to the account's address. The price
limit must be below the current price, and a product can have one watchdog only.

### Account sections and checkout reads

```bash
tools alza account profile              # name, email, phone, address book (--json for all); signed in
tools alza account gdpr                 # the GDPR section and data-export dialog (reads only); signed in
tools alza account subscription         # the AlzaPlus+ subscription section; signed in
tools alza account claims --archive     # warranty claims; without --archive the active ones; signed in
tools alza account claim '<detailAction href>'   # one claim, by its link from `account claims --json`
tools alza account contacts             # Alza's contact channels, no sign-in
tools alza checkout delivery            # delivery options and payment methods for the basket; --option <id> anchors it
tools alza checkout payments            # payment methods only; --option <id> as above
tools alza checkout pickup 2680         # payments that fit one delivery option, with prices (does not pick a box)
tools alza checkout preview             # lines, total, delivery and payments; --option <id> picks the delivery
tools alza checkout address Brno        # postal codes and places, for example 110 00 or Brno
tools alza chat                         # the live chatbot's navigation actions (sends nothing); no sign-in
```

The checkout commands work signed in or as the visitor, and none of them orders anything. `checkout delivery`,
`checkout payments`, `checkout pickup` and `checkout preview` need at least one product in the basket;
`checkout address` does not. `checkout pickup <id>` also takes `--group <id>` (found when you leave it out) and
`--place <id>` (a pickup place). `checkout preview` runs Alza's first checkout step (`sendOrder1`), which starts
Alza's server-side checkout state, so MCP marks it as a write; there is no later step in this tool.

### Raw reads

`tools alza raw <operation> [key=value ...]` sends one fixed read-only GET of the Android app and prints the answer.

```bash
tools alza raw router_product product_id=9383715
tools alza raw branches latitude=50.08 longitude=14.42
```

| Operation | Arguments | Sign-in |
|---|---|---|
| `router_product` | `product_id` | no |
| `alternatives`, `discussion_posts` | `commodity_id` | no |
| `category`, `facets` | `category_id` | no |
| `zip_codes` | `query` (optional) | no |
| `branches` | `latitude`, `longitude` | no |
| `anonymous_order` | `order_id` | no |
| `delivery_countries`, `order_helpdesk_questions`, `visitor_navigation`, `chat_navigation` | none | no |
| `basket_info`, `cart`, `order_add_info`, `order2_info` | none | optional |
| `commodity_lists` | `type` (optional) | optional |
| `order_part` | `order_id`, `part_id` | optional |
| `user_data`, `user_navigation` | none | yes |

### MCP server

```bash
tools alza mcp                          # stdio MCP server: every command as a tool
tools alza mcp --raw                    # also list the raw reads as the tool mobile_read
tools alza --country sk mcp             # a server for another storefront
tools mcp-manager install alza "tools alza mcp" -t stdio -p claude   # add it to a client
```

## How it works

- **Transport.** Cloudflare answers Bun's fetch with HTTP 403 (measured 2026-11-01: plain fetch, every `impit`
  profile and wreq-js got 403; curl_cffi got 200). Requests to Alza go through `@genesiscz/utils/http/impersonate`,
  which loads libcurl-impersonate (the library curl_cffi wraps) through `bun:ffi` in a worker thread, with curl_cffi's
  Chrome TLS fingerprint. The first request downloads the pinned library (v2.3.2, checked against its pinned sha256,
  the largest archive about 28 MB), so nothing has to be installed. It exists for macOS (arm64, x64) and Linux (x64,
  arm64), not for Windows. It trusts the Mozilla roots that Bun ships, not the system trust store.
- **Data.** The Android app's JSON routes on webapi.alza.cz (search, product detail, reviews, questions, facets,
  alternatives, EAN, AlzaBox places, the account), and the server-rendered category pages for `category`. The route
  inventory, the sign-in client and the PC builder rules come from
  [alza-mcp-community](https://github.com/lukabudik/alza-mcp-community) (MIT); the PC builder rules are adapted to
  the JSON product route. `chat` reads Alza's chatbot API. Price history comes from
  [Hlídač shopů](https://www.hlidacshopu.cz). `pickup` geocodes a postal code or a place with OpenStreetMap
  Nominatim, which gets only the query text. Invoice PDFs come from pdf.alza.cz.
- **Sign-in.** OAuth 2.0 with PKCE against identity.alza.cz, with the Android app's client. You sign in in your own
  browser, so the tool never sees the password. An account command renews an expiring access token with the refresh
  token; `auth status` never does, and it sends no request until a catalog command has downloaded the HTTP library.
- **Privacy.** Question posts upstream carry the asker's email address; the tool never reads it.
- **Storefronts.** `cz` prices in CZK, `sk`, `at` and `de` in EUR, `hu` in HUF. `--min` and `--max` use that
  currency.
- **Cost.** Nothing costs money. No command orders, pays, cancels an order or changes account details.

## Files and configuration

There is no config file: choose the storefront with `--country` on each call. The files live under
`~/.genesis-tools/alza/` (`$GENESIS_TOOLS_HOME/.genesis-tools/alza/` when `GENESIS_TOOLS_HOME` is set), each one
mode 0600:

| File | What it holds |
|---|---|
| `tokens.json` | Access and refresh token, expiry, the numeric user id |
| `pending-login.json` | The PKCE verifier between the two sign-in steps, removed after the exchange |
| `visitors/<storefront>.json` | The visitor id and its `IDOX` and `VST` cookies, one file per storefront |
| `state.json` | An older single-visitor file, read as the `cz` visitor until that visitor is saved again |

The anonymous basket is keyed by the `IDOX` cookie, not by the visitor id, and alza.cz and alza.sk set their own
cookies, so each storefront has its own visitor. There is one `tokens.json` for every storefront. The HTTP library
lives in `~/.genesis-tools/impersonate/libcurl-impersonate-2.3.2/`.

Several processes can share these files. Signed out, until the visitor has its `IDOX` cookie, each account call holds
`visitors/<storefront>.json.lock` and first takes a visitor another process saved, so two first calls share one
basket. Every change of the tokens holds `tokens.json.lock`. A renewal never writes tokens back over a logout or a
new sign-in from another process, and a sign-in that completes after a logout or a newer `auth login` is refused.

## For agents

- **Output.** `--json` prints the result data on stdout. Without it, a catalog listing with products (`search`,
  `category`, `deals`, `alternatives`) on a terminal prints as a table; everything else, account listings included,
  prints as markdown. Piped output is markdown.
- **Exit codes.** 0 on success, 1 on any failure, with the reason on stderr. `auth status` also exits 1 when nobody is
  signed in, when the access token expired (even when the next account command can renew it), when the HTTP library
  is not installed yet, or when the check against Alza fails or is refused. Read `check.detail` in `--json` for the
  reason. `auth login` without a terminal and without `--print-url` or
  `--redirect-url` exits 1 and prints the two-step commands.
- **MCP.** `tools alza mcp` serves 43 tools: 17 catalog tools and 26 account tools; `--raw` adds `mobile_read`.
  Catalog tools and account reads are marked `readOnlyHint: true`. The eight writes (`cart_add`, `cart_remove`,
  `mutate_list`, `watchdog_add`, `watchdog_remove`, `select_pickup_point`, `checkout_preview`, `order_document`) are
  marked `readOnlyHint: false`, and the four that remove or replace something (`cart_remove`, `watchdog_remove`,
  `mutate_list`, and `order_document`, which can replace a file) also `destructiveHint: true`. Each tool answers
  markdown text plus `structuredContent.result` with the same data as `--json`. A failure is an `isError` result,
  never a crash. A tool that needs a sign-in answers "Sign in first: tools alza auth login"; the sign-in itself has
  no tool, because the user runs it in a terminal.
- **The genesis-tools MCP server** mounts the same tools, prefixed `alza_`, when `GENESIS_TOOLS_MCP_CAPABILITIES`
  names `alza` (opt-in). Another MCP server can mount every Alza tool through `createAlzaToolset()` from
  `src/alza/mcp/tools.ts` (name, description, JSON input schema, annotations, call).
- **Monitor.** `watchdog list --items` prints JSON item lines for `tools monitor`. An item id carries the state that
  fired (`<product>:price:<price>`, `<product>:stock`), so a further price drop, or stock that comes back after a gap,
  is a new item:

  ```bash
  tools monitor add "tools alza watchdog list --items" --kind command --items --interval 1800
  ```

The CLI commands map to these MCP tools. `auth login` and `auth logout` have no tool.

| CLI command | MCP tool |
|---|---|
| `search`, `category` | `search_products`, `list_category` |
| `product`, `reviews`, `questions` | `get_product`, `get_reviews`, `get_questions` |
| `compare`, `alternatives` | `compare_products`, `recommend_alternatives` |
| `suggest` | `autocomplete` |
| `categories`, `categories <id>` | `list_categories`, `get_category` |
| `filters`, `deals`, `ean` | `list_category_filters`, `get_deals`, `find_by_ean` |
| `history`, `pickup` | `price_history`, `find_pickup_points` |
| `pc check`, `pc suggest` | `pc_build_check`, `pc_build_suggest` |
| `auth status` | `account_status` |
| `cart show`, `add`, `remove` | `cart_show`, `cart_add`, `cart_remove` |
| `favorites list`, `add`, `remove` | `favorites_list`, `mutate_list` |
| `orders list`, `show`, `search` | `orders_list`, `order_show`, `order_search` |
| `orders document`, `payments` | `order_document`, `after_order_payments` |
| `watchdog list`, `add`, `remove` | `watchdog_list`, `watchdog_add`, `watchdog_remove` |
| `account profile`, `contacts`, `gdpr` | `profile`, `contacts`, `gdpr_info` |
| `account subscription`, `claims`, `claim` | `subscription_overview`, `complaint_claims`, `claim_detail` |
| `checkout delivery`, `payments`, `pickup` | `delivery_options`, `payment_methods`, `select_pickup_point` |
| `checkout preview`, `address` | `checkout_preview`, `address_search` |
| `chat`, `raw` | `chat_navigation`, `mobile_read` (only with `--raw`) |

## Troubleshooting

- **"libcurl-impersonate has no shared library for win32-…".** The pinned library has no Windows build. Run the tool
  on macOS or Linux.
- **The first command is slow, or "libcurl-impersonate download did not finish within 180 s".** The first request
  downloads the HTTP library. Check the network and run the command again.
- **`auth status` says "Not checked: the Chrome-fingerprint HTTP library is not installed yet".** A status check
  installs nothing, and it exits 1. Run any catalog command once, for example `tools alza search ssd`.
- **The browser cannot open `alza://identity?code=…`.** That is expected. Copy the URL (see Sign-in) and paste it.
- **"No sign-in is waiting", "The waiting sign-in is too old", "state mismatch", or the token endpoint refuses the
  code.** The code is single-use and short-lived, and a redirect must belong to the latest `auth login`. Run
  `tools alza auth login` again and paste the new URL at once.
- **"Your Alza session expired" or "could not be renewed".** The refresh token is gone or refused. Sign in again.
- **"A watchdog already exists for product N. Remove it first."** Run `tools alza watchdog remove <product>`, then add
  it again with the new limits.
- **"The price limit must be below the current price".** Pass a `--price` below today's price, or watch the stock.
- **`pc suggest` refuses another storefront.** The budget is CZK, so it runs on `cz` only. `pc check` has no such
  limit.
- **`orders document` says the file "already exists".** Pass `--overwrite`, or choose another `--out`. A link that is
  neither on pdf.alza.cz nor an order route on another Alza host is refused: copy it from
  `tools alza --json orders search <query>`.
- **"The basket is empty: there is nothing to preview."** `checkout preview` needs at least one basket line.
- **"The basket is empty: delivery and payment options exist only for a basket with products."** `checkout delivery`,
  `checkout payments` and `checkout pickup` read the basket's delivery options, and an empty basket has none. Add a
  product first, for example `tools alza cart add <product>`, on the same storefront.
- **Signed out, the basket on `sk` does not show what you added on `cz`.** Each storefront has its own visitor, and
  the visitor owns the basket.
- **`pickup` says "No location found" or "Nominatim did not answer within 15 s".** Try a postal code, another place
  name, or `lat,lon`, and try again.

## Related

- [shops](../shops/README.md): price tracking across many shops; its Hlídač shopů client is the one `history` uses.
- [fetch](../fetch/README.md): any web page through the same Chrome-fingerprint transport.
- [monitor](../monitor/README.md): runs `watchdog list --items` on a schedule and notifies you.
- [mcp-manager](../mcp-manager/README.md): installs `tools alza mcp` into an MCP client.
- [genesis-tools-mcp](../genesis-tools-mcp/README.md): the shared MCP server with the opt-in `alza` capability.
