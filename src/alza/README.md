# alza

Alza.cz from the terminal and as an MCP server: search, category listings with filters, product detail, reviews,
questions, comparisons, alternatives, deals, EAN lookup, price history (Hlídač shopů) and AlzaBox pickup points.
Unofficial; not affiliated with Alza.

```bash
tools alza search alkohol tester --sort rating --limit 10
tools alza search monitor --brand 1602 --max 5000 --in-stock --discounted
tools alza product AUPR65708            # code, numeric id or product URL
tools alza reviews AUPR65708 --limit 100
tools alza questions AUPR65708
tools alza compare AUPR65708 Moto19476
tools alza alternatives Moto19476
tools alza history AUPR65708            # lowest/highest price, claimed vs real discount
tools alza suggest alkohol              # phrases, products, categories with ids
tools alza categories 18851284          # path and subcategories
tools alza filters 18851284             # brand ids and parameter filter ids
tools alza category 18851284 --brand 15529 --filter 15361:239455089
tools alza deals --category 18851284 --min-discount 20
tools alza deals alkohol tester
tools alza ean 8594190030364
tools alza pickup 11000 --limit 5       # postal code, place name or "lat,lon"
tools alza --country sk search "alkohol tester"
tools alza --json product AUPR65708     # machine-readable result
tools alza mcp                          # stdio MCP server, one tool per command
```

Add the MCP server to a client: `tools mcp-manager install alza "tools alza mcp" -t stdio -p claude`.

## How it reaches Alza

Cloudflare answers Bun's fetch with HTTP 403. Requests go through `@genesiscz/utils/http/impersonate`, which loads
libcurl-impersonate (the library curl_cffi wraps) with a Chrome TLS fingerprint; the first request downloads the
pinned library, so nothing has to be installed. Data comes from the
Android app's JSON routes (search, product detail, reviews, questions, facets, alternatives, EAN, AlzaBox places) and
from the server-rendered category pages. The route inventory comes from
[alza-mcp-community](https://github.com/lukabudik/alza-mcp-community) (MIT). Price history comes from
[Hlídač shopů](https://www.hlidacshopu.cz). Postal codes are geocoded with OpenStreetMap Nominatim.

Question posts upstream carry the asker's email address; the tool never reads it.

## Account

Sign in once in a browser; the tool never sees your password. Then the basket, orders, watchdogs and favourites work
from the CLI and as MCP tools. Placing orders, payments, cancellations and account changes are not implemented.

```bash
tools alza auth login                   # opens the sign-in page, then asks for the alza://identity?code=… URL
tools alza auth login --print-url       # the same in two steps, without a terminal prompt …
tools alza auth login --redirect-url 'alza://identity?code=…&state=…'   # … step 2
tools alza auth status                  # reads only: expiry, user id, one check that Alza accepts the token
tools alza auth logout
tools alza cart                         # works signed out too: a visitor basket kept between runs
tools alza cart add AUPR65708 --qty 2   # code, numeric id or product URL; orders nothing
tools alza cart remove AUPR65708
tools alza favorites                    # the Oblíbené list
tools alza orders list --limit 20       # active and archived orders (signed in)
tools alza orders show 1058423434
tools alza watchdog list                # price and stock watchdogs (Hlídací pes), signed in
tools alza watchdog add AUPR65708 --price 1999 --stock
tools alza watchdog remove <id|product>
```

After the sign-in the browser tries to open `alza://identity?code=…` and cannot; copy that URL from the address bar,
the "open this app?" message, or the DevTools Network tab (turn on "Preserve log" first). The code expires within
minutes.

Files, all mode 0600, under `~/.genesis-tools/alza/`: `tokens.json` (access and refresh token, user id),
`pending-login.json` (the PKCE verifier between the two sign-in steps, removed after the exchange) and `state.json`
(the visitor id and the `IDOX`/`VST` cookies: the anonymous basket is keyed by the `IDOX` cookie, not by the visitor
id). An account command renews an expiring access token with the refresh token; `auth status` never does.

MCP tools: `account_status`, `cart_show`, `cart_add`, `cart_remove`, `favorites_list`, `orders_list`, `order_show`,
`watchdog_list`, `watchdog_add`, `watchdog_remove`. The four that change the basket or the watchdogs are annotated
`readOnlyHint: false`. A tool that needs a sign-in answers "Sign in first: tools alza auth login".

## More catalog and account tools

```bash
tools alza categories                   # the top level of the category tree (an id shows that category instead)
tools alza pc check BD750k7a1 AGb650ea DP095b32a64 UY006rm85new CBh5f5   # compatibility of a parts list; code:role when detection fails
tools alza pc suggest 40000 --profile gaming --cpu amd --skip storage     # a compatible build within the budget (about a minute)
tools alza account profile | gdpr | subscription | claims [--archive]     # signed in
tools alza account claim <detailAction href>
tools alza account contacts             # Alza's contact channels, no sign-in
tools alza orders search 1058           # order search, with invoice links
tools alza orders document <https link> --out invoice.pdf   # only Alza hosts; pdf.alza.cz is read with fetch for binary PDFs
tools alza orders payments <order> <part>   # payment options of an unpaid part (reads only)
tools alza checkout delivery | payments | preview   # for the basket, signed in or as the visitor; nothing is ordered
tools alza checkout pickup 2680         # payments that fit one delivery option, with prices (does not pick a box)
tools alza checkout address Brno        # postal codes and places
tools alza favorites add|remove <product> [--later]
tools alza chat                         # the chatbot's navigation actions (sends nothing)
tools alza raw <operation> [key=value]  # fixed read-only GET routes; `tools alza mcp --raw` adds mobile_read to MCP
```

The PC builder rules come from [alza-mcp-community](https://github.com/lukabudik/alza-mcp-community) (MIT), adapted to
the JSON product route. `checkout preview` runs Alza's first checkout step (`sendOrder1`), so MCP marks it as a write,
but there is no order step in this tool. Another MCP server can mount every Alza tool through `createAlzaToolset()`
from `src/alza/mcp/tools.ts` (name, description, JSON input schema, annotations, call).
