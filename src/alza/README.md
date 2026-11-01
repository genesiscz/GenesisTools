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

Cloudflare answers Bun's fetch with HTTP 403. Requests go through `@genesiscz/utils/http/impersonate`, a curl_cffi
sidecar with a Chrome TLS fingerprint, started through `uv` (install it with `brew install uv`). Data comes from the
Android app's JSON routes (search, product detail, reviews, questions, facets, alternatives, EAN, AlzaBox places) and
from the server-rendered category pages. The route inventory comes from
[alza-mcp-community](https://github.com/lukabudik/alza-mcp-community) (MIT). Price history comes from
[Hlídač shopů](https://www.hlidacshopu.cz). Postal codes are geocoded with OpenStreetMap Nominatim.

Question posts upstream carry the asker's email address; the tool never reads it.
