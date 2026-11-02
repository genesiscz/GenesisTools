# fetch

Fetch a web page as Markdown, raw HTML or its schema.org JSON-LD. Sites behind Cloudflare and other bot walls (alza.cz, heureka.cz, heureka.sk, portalridice.cz) answer Bun's fetch with HTTP 403 and a challenge page; `fetch` can send the request with a real Chrome TLS, HTTP/2 and header fingerprint instead, which those sites accept. It is a CLI and an MCP server, and the `genesis-tools` MCP server serves the same tools as its `fetch` group. All three call one core in `lib/`.

## CLI usage

```bash
tools fetch "https://example.com"                                 # main content as Markdown, transport auto
tools fetch "https://example.com" --mode raw                      # raw HTML
tools fetch "https://shop.example/product" --mode jsonld          # schema.org JSON-LD as JSON
tools fetch "https://shop.example/product" --transport chrome     # always the Chrome fingerprint
tools fetch "https://example.com" --transport plain               # never the Chrome fingerprint

tools fetch "https://example.com" --depth advanced    # YAML front matter: title, url, author, date
tools fetch "https://example.com" --tokens 2048       # at most 2048 tokens (markdown and raw)
tools fetch "https://example.com" --save-tokens       # compact whitespace / code blocks
tools fetch "https://example.com" -o page.md          # write to a file
tools fetch "https://example.com" --json              # the whole result, with source, status, transport, escalation
tools fetch "https://example.com" --headers '{"Cookie":"a=b"}'
```

`tools fetch <url>` is `tools fetch get <url>`. `--transport`, `--mode` and `--depth` take a fixed set of values: given bare in a terminal they open a picker; an unknown value, or a bare flag without a terminal, prints the possible values and a corrected command and exits 1.

The result goes to stdout. A status line goes to stderr: the HTTP status, the transport that answered and why `auto` escalated, the token count, and in jsonld mode the number of products and JSON-LD blocks.

## Transports

| Transport | What it does |
|---|---|
| `plain` | Bun's fetch with a desktop Chrome User-Agent. Fast, no extra process. Bot walls refuse it. |
| `chrome` | libcurl-impersonate (the library curl_cffi wraps) with curl_cffi's `chrome152` target, through `ImpersonatedHttpClient` (`src/utils/http/impersonate/`) in a worker thread. The worker starts on the first request and keeps one cookie jar. |
| `auto` (default) | `plain` first. On HTTP 403, 429 or 503, or on a recognised challenge page with any status, it retries once through `chrome`. The result says which transport answered and why it escalated. |

The first `chrome` request downloads the pinned libcurl-impersonate shared library (checked against its sha256) into `~/.genesis-tools/impersonate/`; nothing else has to be installed. Upstream publishes no Windows shared library, so the `chrome` transport fails there with an error that says so.

A challenge page is never returned as content. When the last transport tried still gets one, the command fails (exit 1, or an MCP error result) with a message that names the vendor, the signal and every transport tried, for example:

```
Blocked: https://… answered with a Cloudflare challenge page (header cf-mitigated: challenge, HTTP 403) through the plain transport. Retry with transport "auto" or "chrome" (tools fetch https://… --transport auto).
```

Recognised challenge pages (`lib/challenge.ts`): Cloudflare (`cf-mitigated: challenge` header, `_cf_chl_opt`, the `/cdn-cgi/challenge-platform/h/` orchestration path, the titles "Just a moment...", "Attention Required! | Cloudflare", "Checking security", "Kontrola zabezpečení", "Kontrola zabezpečenia"), Akamai (`sec-if-cpt-container`, `bm-verify`, an "Access Denied" page with a Reference #), DataDome (`captcha-delivery.com`), PerimeterX (`px-captcha`) and Imperva (`_Incapsula_Resource`). Cloudflare also puts `/cdn-cgi/challenge-platform/scripts/jsd/` into pages it lets through, so that path alone is not a challenge.

Redirects are followed by hand, up to 5, through the same transport and only to http or https addresses. `--headers` go only to the origin you asked for (or the same host upgraded from http to https), never to another origin a redirect leads to. Every request has a 30 s timeout.

## JSON-LD mode

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
- Prices become numbers (`"7990"`, `"7 990,50"`, `"1,234.50"`); `availability` and `condition` lose the `https://schema.org/` prefix; `brand` and `seller` are the name of the nested thing.
- `breadcrumbs` has one list per `BreadcrumbList`, sorted by position. `other` names every other typed node, so you can see what else the page describes.
- `blocks` counts the JSON-LD blocks found and `parseErrors` the ones that did not parse. A page without JSON-LD gives empty lists, not an error. JSON-LD output is never cut by `--tokens`, so it stays valid JSON.

## MCP

```bash
tools fetch mcp
```

```json
{ "mcpServers": { "fetch": { "command": "tools", "args": ["fetch", "mcp"] } } }
```

The same three tools are in the `genesis-tools` MCP server under the capability `fetch` (`GENESIS_TOOLS_MCP_CAPABILITIES=fetch`, or unset for every capability). That group loads only when the capability list can expose it.

| Tool | Arguments |
|---|---|
| `fetch_markdown` | `url`, `transport?`, `headers?`, `depth?` (`basic` \| `advanced`), `tokens?`, `save_tokens?` |
| `fetch_raw` | `url`, `transport?`, `headers?`, `tokens?`, `save_tokens?` |
| `fetch_jsonld` | `url`, `transport?`, `headers?` |

All three are read-only and default to `transport: "auto"`. A markdown or raw result starts with one HTML comment line that names the final URL, the status and the transport (`<!-- fetched https://… (HTTP 200) via chrome, escalated after plain got … -->`), because many MCP clients do not show `_meta`. The jsonld result is the JSON document above. A blocked page is an error result with the message from the Transports section.

Both servers end the Chrome worker when their stdin ends, and after one minute without a request; the next chrome request starts a new one. A CLI run ends it before it exits. The worker runs in the same process, so nothing is left behind.

## Code

- `lib/types.ts`: transport and mode names, the `HttpTransport` interface.
- `lib/transports.ts`: the `plain` and `chrome` transports and the `TRANSPORTS` table. A new transport is one class and one row there.
- `lib/fetcher.ts`: `Fetcher`, the redirect loop, the `auto` escalation, `FetchBlockedError` and `FetchHttpError`.
- `lib/challenge.ts`: `detectChallenge`, `blockVerdict`.
- `lib/jsonld.ts`: `extractJsonLd`, `parsePrice`.
- `lib/read.ts`: `fetchUrl`, the one operation behind the CLI and both MCP doors. Markdown conversion is mcp-web-reader's (`@app/mcp-web-reader/lib/convert`).
- `mcp/tools.ts`: the tool definitions both MCP doors serve; `mcp/server.ts` (`tools fetch mcp`); `mcp/genesis-tools.ts` (the genesis-tools group).
