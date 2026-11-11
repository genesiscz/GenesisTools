# tools fetch

`tools fetch` reads a web page and gives you its main content as Markdown, its raw HTML or its schema.org JSON-LD (products, offers, breadcrumbs). Use it from a script or an agent when a site sits behind Cloudflare or another bot wall: such sites (alza.cz, heureka.cz, heureka.sk, portalridice.cz) answer Bun's fetch with HTTP 403 and a challenge page, and `fetch` can send the request with a real Chrome TLS, HTTP/2 and header fingerprint instead, which those sites accept.

It is a CLI and an MCP server, and the `genesis-tools` MCP server serves the same tools as its `fetch` group. All three call one core in `lib/`.

## Quick start

`fetch` ships with GenesisTools: once `tools` is on your PATH, nothing else needs installing. The `chrome` transport downloads its library on its first request ([Files and network](#files-and-network)).

```bash
tools fetch "https://example.com"                               # main content as Markdown, transport auto
tools fetch example.com --tokens 2048                           # a bare host gets https://; at most 2048 tokens
tools fetch "https://shop.example/product" --mode jsonld        # products, offers and breadcrumbs as JSON
tools fetch "https://shop.example/product" --transport chrome   # always the Chrome fingerprint
tools fetch "https://example.com" -o page.md                    # write the Markdown to a file
tools fetch mcp                                                 # serve the three fetch_* tools over stdio
```

Quote a URL that has `?` or `&`, or zsh and bash will break it.

## Commands

| Command | What it does |
|---|---|
| `tools fetch get <url>` | Fetch one page as Markdown, raw HTML or JSON-LD. The default command: `tools fetch <url>` is `tools fetch get <url>`. |
| `tools fetch mcp` | Run `fetch_markdown`, `fetch_raw` and `fetch_jsonld` as a stdio MCP server. No flags. See [For agents](#for-agents). |

### `get` flags

The URL may be a bare host: `example.com` becomes `https://example.com/`.

| Flag | Default | What it does |
|---|---|---|
| `-t, --transport [transport]` | `auto` | How to reach the page: `plain`, `chrome` or `auto` ([Transports](#transports)). |
| `-m, --mode [mode]` | `markdown` | Output: `markdown`, `raw` or `jsonld`. |
| `-d, --depth [depth]` | `basic` | Markdown only: `advanced` adds YAML front matter (title, url, author, date). |
| `-T, --tokens <n>` | no limit | Return at most n tokens (markdown and raw). A positive whole number. |
| `-s, --save-tokens` | off | Compact whitespace (raw) or code blocks (markdown). |
| `--headers <json>` | none | Extra request headers as a JSON object of strings, sent only to the page's own origin. |
| `-o, --out <path>` | stdout | Write the text to a file instead of stdout. |
| `--json` | off | Print the whole result as JSON: source, status, transport, escalation, extraction. |

`-v, --verbose` (a root option, valid on every command including `mcp`) prints debug lines on stderr: each request
with its transport, status, size and time.

```bash
tools fetch https://example.com --mode raw                    # raw HTML
tools fetch https://example.com --transport plain             # never the Chrome fingerprint
tools fetch https://example.com --depth advanced              # YAML front matter: title, url, author, date
tools fetch https://example.com --save-tokens                 # compact whitespace / code blocks
tools fetch https://example.com --json                        # the whole result, with source, status, transport, escalation
tools fetch https://example.com --headers '{"Cookie":"a=b"}'  # an extra header for this origin only
```

- `--transport`, `--mode` and `--depth` take a fixed set of values. Given bare in a terminal, they open a picker. An unknown value, or a bare flag without a terminal, prints the possible values and a corrected command and exits 1.
- The result goes to stdout. Two lines go to stderr: `Fetching <url> (<mode>, transport <transport>)` first, then a status line with the HTTP status, the transport that answered and why `auto` escalated, the token count, `(truncated)` when `--tokens` cut the text, and in jsonld mode the number of products and JSON-LD blocks. For example: `HTTP 200 via chrome, escalated after plain got a Cloudflare challenge page (header cf-mitigated: challenge, HTTP 403): 5120 tokens`.
- `--json` wins over `-o`: the JSON goes to stdout and no file is written.
- In jsonld mode, `-o` writes the JSON document.

## How it works

### Transports

| Transport | What it does |
|---|---|
| `plain` | Bun's fetch with a desktop Chrome User-Agent and an HTML `Accept` header. Fast, no extra process. Bot walls refuse it. |
| `chrome` | libcurl-impersonate 2.3.2 with the `chrome152` target, in a worker thread (below). |
| `auto` (default) | `plain` first, then `chrome` once when `plain` is blocked (below). |

- `chrome` is libcurl-impersonate 2.3.2 (the library curl_cffi wraps) with curl_cffi's `chrome152` target, through `ImpersonatedHttpClient` (`src/utils/http/impersonate/`) in a worker thread. The worker starts on the first request and keeps one cookie jar.
- `auto` tries `plain` first. On HTTP 403, 429 or 503, or on a recognised challenge page with any status, it retries once through `chrome`. The result says which transport answered and why it escalated.
- `auto` does not retry any other status. A 404 or a 500 from `plain` is the answer.
- A `plain` request that fails with no answer (DNS failure, TLS error, connection reset, the 30 s timeout) is not retried through `chrome` either. Use `--transport chrome` for such a site.
- The cookie jar lets a clearance cookie carry over to later requests of the same process. A CLI run starts with an empty jar every time. An MCP server keeps its jar until the worker ends after one idle minute; the next worker starts with an empty jar.
- On `plain`, a header named exactly `User-Agent` or `Accept` in `--headers` replaces the default one. A different case, such as `user-agent`, sends both values joined with a comma.

### Challenge pages and refusals

A challenge page is never returned as content. When the last transport tried still gets one, the command fails (exit 1, or an MCP error result) with a message that names the vendor, the signal and every transport tried, for example:

```
Blocked: https://… answered with a Cloudflare challenge page (header cf-mitigated: challenge, HTTP 403) through the plain transport. Retry with transport "auto" or "chrome" (tools fetch https://… --transport auto).
```

- When `chrome` was one of the transports tried, the message ends with `Even the Chrome fingerprint was refused: the site may need a real browser session, or it limits this IP.`
- A block status (403, 429, 503) without a recognised page is a refusal, for example `a refusal (HTTP 429)`. It fails the same way.
- Any other status outside 2xx fails as `HTTP 404 for https://… (plain transport)`.

Recognised challenge pages (`lib/challenge.ts`):

- **Cloudflare**: the `cf-mitigated: challenge` header, `_cf_chl_opt`, or the `/cdn-cgi/challenge-platform/h/` orchestration path.
- **Akamai**: `sec-if-cpt-container`, `bm-verify`, or an "Access Denied" page with a Reference #.
- **DataDome**: `captcha-delivery.com`. **PerimeterX**: `px-captcha`. **Imperva**: `_Incapsula_Resource`.
- **A challenge title**, matched without case: "Just a moment...", "Attention Required! | Cloudflare", "Checking your browser", "Checking security", "Kontrola zabezpečení", "Kontrola zabezpečenia", "One more step", "Pardon our interruption". The vendor then comes from the `Server` header. "Kontrola zabezpečení", "Kontrola zabezpečenia" and "Checking security" are the Czech, Slovak and English titles of the Cloudflare page Heureka serves (measured 2026-11-01).

Cloudflare also puts `/cdn-cgi/challenge-platform/scripts/jsd/` into pages it lets through, so that path alone is not a challenge. `_cf_chl_opt` and the `/h/` path were on the refused Heureka page and absent from the passed one (2026-11-01). The markers are searched in the first 64,000 characters of the body. A title, `bm-verify` and `_Incapsula_Resource` count only on a body shorter than 200,000 characters, because challenge pages are small and those markers can sit on a normal page.

### Requests, redirects and limits

- Redirects (301, 302, 303, 307, 308) are followed by hand, up to 5, through the same transport and only to http or https addresses. A redirect to another scheme fails with `Refusing the redirect from … to …`, and a sixth fails with `More than 5 redirects for …`.
- `--headers` go only to the origin you asked for, or the same host upgraded from http to https on default ports. They never go to another origin a redirect leads to.
- Every request has a 30 s timeout. Each redirect hop is its own request.
- A response body may be at most 20 MiB (20,971,520 bytes). Both transports stop a larger body while it streams and fail with `The response of … is larger than 20971520 bytes; the transfer was stopped`. No flag raises the limit.

### Markdown and raw output

- Markdown mode takes the main content and converts it with Turndown. The conversion is mcp-web-reader's (`@app/mcp-web-reader/lib/convert`): navigation, footers, ads and cookie banners are dropped, and links are absolute. `conversion.method` in `--json` names the part it took: `main`, `article`, `scored` (the best container by a Readability-style score of its paragraphs) or `body`.
- `--depth advanced` puts YAML front matter first, with `title`, `url`, `author` and `date`. A field the page does not have is left out.
- Raw mode returns the HTML text the server sent, decoded as UTF-8.
- Every body is read as UTF-8 and the charset a page declares is ignored. A page in windows-1250 or ISO-8859-2 shows broken characters in markdown, raw and jsonld mode.
- `--tokens` counts with the GPT-3 encoder (`gpt-3-encoder`), so for another model the count is an estimate. JSON-LD output is never cut by `--tokens`, so it stays valid JSON.

### JSON-LD mode

`--mode jsonld` reads every `<script type="application/ld+json">` block, flattens `@graph` arrays and returns one JSON document. No per-site code: it uses schema.org vocabulary only.

```json
{
  "url": "https://…/product/",
  "transport": "chrome",
  "escalatedFrom": "plain",
  "blocks": 2,
  "parseErrors": 0,
  "products": [
    {
      "type": "Product",
      "name": "…",
      "brand": "…",
      "sku": null,
      "gtin": null,
      "mpn": null,
      "url": null,
      "category": "…",
      "description": "… (cut at 500 characters)",
      "images": ["https://…"],
      "rating": { "value": 93, "best": 100, "worst": 0, "ratingCount": 12, "reviewCount": 7 },
      "priceRange": { "low": 7990, "high": 9647.33, "currency": "CZK", "offerCount": 9 },
      "offers": [
        { "seller": "…", "price": 7990, "currency": "CZK", "availability": "InStock", "condition": "NewCondition", "url": null }
      ],
      "properties": [{ "name": "…", "value": "…" }]
    }
  ],
  "breadcrumbs": [[{ "position": 1, "name": "…", "url": "https://…" }]],
  "other": [{ "type": "Organization", "name": "…" }]
}
```

- `products` holds every `Product`, `ProductGroup`, `IndividualProduct` and `ProductModel` node. `offers` lists each `Offer`, also the ones inside an `AggregateOffer`. `priceRange` comes from the `AggregateOffer` when the page has one, otherwise from the offers.
- A computed `priceRange` needs one currency across the priced offers. 100 CZK and 10 EUR have no common range, so mixed currencies give `null`, and the offers keep their own prices (fixed 2026-11-02; before, they became a 10 to 100 range).
- Prices become numbers (`"7990"`, `"7 990,50"`, `"1,234.50"`). `availability` and `condition` lose the `https://schema.org/` prefix. `brand` and `seller` are the name of the nested thing.
- Fallbacks: `brand` reads `manufacturer`, `sku` reads `productID`, `gtin` reads `gtin13`, `gtin`, `gtin12`, `gtin14` and `gtin8` in that order, `seller` reads `offeredBy`, and an offer's `price` reads its `priceSpecification`, then `lowPrice`. `images` keeps at most 10 URLs.
- `breadcrumbs` has one list per `BreadcrumbList`, sorted by position. `other` names every other typed node (`type` joins several types with a comma), so you can see what else the page describes.
- `blocks` counts the JSON-LD blocks found and `parseErrors` the ones that did not parse. A page without JSON-LD gives empty lists, not an error. An HTML comment (`<!-- … -->`) or a `/*<![CDATA[*/ … /*]]>*/` wrapper around a block is removed before parsing. A bare `<![CDATA[ … ]]>` stays and counts in `parseErrors`. A large `@graph` is read node by node: a 1.6 MB graph threw RangeError before the 2026-11-02 fix.

### Files and network

- The first `chrome` request downloads the pinned libcurl-impersonate archive (about 7 to 28 MB per platform) from the `lexiforest/curl-impersonate` GitHub releases, checks it against its sha256, and extracts the shared library with `tar`. The download may take up to 180 s. Nothing else has to be installed.
- The library and a CA bundle (`ca-<hash>.pem`, the Mozilla roots Bun ships, because BoringSSL cannot read the system trust store) live in `~/.genesis-tools/impersonate/libcurl-impersonate-2.3.2/`.
- `chrome` works on macOS (arm64, x64) and Linux (x64, arm64). Upstream publishes no Windows shared library, so the `chrome` transport fails there with an error that says so and names the supported platforms. `plain` works everywhere.
- `fetch` keeps no page cache and no account, and nothing it does costs money. Debug lines (scope `fetch`) go to the GenesisTools day log, `~/.genesis-tools/logs/<date>.log`.

### Source layout

- `lib/types.ts`: transport and mode names, the `HttpTransport` interface.
- `lib/transports.ts`: the `plain` and `chrome` transports, the `TRANSPORTS` table and the 20 MiB limit. A new transport is one class and one row there.
- `lib/fetcher.ts`: `Fetcher`, the redirect loop, the `auto` escalation, `FetchBlockedError` and `FetchHttpError`.
- `lib/challenge.ts`: `detectChallenge`, `blockVerdict`.
- `lib/jsonld.ts`: `extractJsonLd`, `parsePrice`.
- `lib/read.ts`: `fetchUrl`, the one operation behind the CLI and both MCP doors. Markdown conversion is mcp-web-reader's (`@app/mcp-web-reader/lib/convert`).
- `mcp/tools.ts`: the tool definitions both MCP doors serve; `mcp/server.ts` (`tools fetch mcp`); `mcp/genesis-tools.ts` (the genesis-tools group).

## Configuration

`fetch` has no config file. Two environment variables matter:

- `GENESIS_TOOLS_HOME` replaces your home folder for GenesisTools data. With `GENESIS_TOOLS_HOME=/data/gt`, the library goes to `/data/gt/.genesis-tools/impersonate/libcurl-impersonate-2.3.2/`, and the day log moves with it.
- `GENESIS_TOOLS_MCP_CAPABILITIES` picks the groups the `genesis-tools` MCP server loads. The fetch tools load when it is unset or names `fetch`.

## For agents

### `--json`

`--json` prints one object: `mode`, `text` (left out in jsonld mode), `tokens`, `truncated`, `source` (the address after redirects), `status`, `transport`, and `escalation` (`from`, `status`, `reason` with `vendor`, `signal` and `challenge`) when `auto` retried through `chrome`. Markdown mode adds `conversion` (`method`, `conversionTime`, `issues`). Jsonld mode adds `jsonld`, the extraction without `url` and `transport`.

Exit code 0 means the page came back. Exit code 1 means it did not: a blocked page, another status outside 2xx, an invalid URL, `--headers` that are not a JSON object of strings, an unknown or bare enumerated flag without a terminal, a body over 20 MiB, or a timeout. The reason is on stderr.

### MCP

```bash
tools fetch mcp
```

```json
{ "mcpServers": { "fetch": { "command": "tools", "args": ["fetch", "mcp"] } } }
```

The same three tools are in the `genesis-tools` MCP server under the capability `fetch` (`GENESIS_TOOLS_MCP_CAPABILITIES=fetch`, or unset for every capability). That group loads only when the capability list can expose it.

| Tool | Arguments |
|---|---|
| `fetch_markdown` | `url`, `transport?`, `headers?`, `depth?` (`basic` or `advanced`), `tokens?`, `save_tokens?` |
| `fetch_raw` | `url`, `transport?`, `headers?`, `tokens?`, `save_tokens?` |
| `fetch_jsonld` | `url`, `transport?`, `headers?` |

- All three are read-only and default to `transport: "auto"`. An argument the tool does not list is an error.
- A markdown or raw result starts with one HTML comment line that names the final URL, the status and the transport (`<!-- fetched https://… (HTTP 200) via chrome, escalated after plain got … -->`, plus `, truncated to N tokens` when cut), because many MCP clients do not show `_meta`. `tools fetch mcp` also puts `source`, `status`, `transport`, `escalation`, `tokens` and `truncated` in `_meta`.
- The jsonld result is the JSON document above.
- A blocked page, or any other failure, is an error result (`isError`) that carries the message from [Challenge pages and refusals](#challenge-pages-and-refusals). `tools fetch mcp` starts its text with `Error:`; the `genesis-tools` server starts it with `<tool> failed:`.
- Both servers end the Chrome worker when their stdin ends, and after one minute without a request; the next chrome request starts a new one. A CLI run ends it before it exits. The worker runs in the same process, so nothing is left behind.

## Troubleshooting

- **`Blocked: … through the plain transport. Retry with transport "auto" or "chrome"`**: you chose `--transport plain`. Retry with `auto` or `chrome`. The longer message `… through the plain transport, then … through the chrome transport` is the next item.
- **`Even the Chrome fingerprint was refused`**: the site wants a real browser session, or it limits your IP. Read the page in your own browser with [chrome-devtools](../chrome-devtools/README.md).
- **`HTTP 404 for … (plain transport)`**: the server answered a status outside 2xx that is not a bot wall. `auto` does not retry it. Check the URL.
- **`libcurl-impersonate has no shared library for win32-x64`**: no `chrome` transport on Windows. Use `--transport plain`.
- **`libcurl-impersonate download did not finish within 180 s` or `checksum mismatch`**: the first `chrome` request could not fetch or verify the library from GitHub. Check the network and retry: the archive is checked against its sha256 before anything is extracted.
- **`The response of … is larger than 20971520 bytes`**: the body passed the 20 MiB limit. The limit has no flag.
- **`--headers must be a JSON object of string values`, or a JSON parse error**: pass an object such as `'{"Cookie":"a=b"}'`, with string values only and valid JSON.
- **Broken characters on a page**: every body is read as UTF-8 (see Markdown and raw output).

## Related

- [mcp-web-reader](../mcp-web-reader/README.md): the HTML to Markdown conversion `fetch` uses, and a Jina Reader mode.
- [genesis-tools-mcp](../genesis-tools-mcp/README.md): the MCP server that serves these tools as its `fetch` group.
- [hub](../hub/README.md): Send to my vault runs `tools fetch <url> --depth advanced --tokens 6000` to save a shared link as Markdown.
- [alza](../alza/README.md): an Alza.cz client that uses the same Chrome-fingerprint client.
- [chrome-devtools](../chrome-devtools/README.md): drive your real browser when a fingerprint is not enough.
