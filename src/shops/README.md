# tools shops

Personal grocery + drogerie + pharmacy price intelligence across Czech eshops.

## Sources of truth

- Spec: `GenesisBrain/GenesisTools/shops/Spec.md`
- Research: `GenesisBrain/GenesisTools/shops/Research.handoff.md`
- Reference clone: `_Playgrounds/hlidac-shopu/` (read-only)

## Quick start

    tools shops db migrate
    tools shops shops
    tools shops get https://www.rohlik.cz/1419780-ritter-sport-mlecna-cokolada

## Foundation status (Plan 01)

- DB schema (12 tables + `current_offers` view + `products_fts` + `brand_aliases`) — done.
- `HlidacShopuClient` (Hlídač REST + S3) — done.
- `tools shops get <url>` via Hlídač passthrough — done.
- Per-shop clients, watchlist, matcher, UI, MCP — see plans 02-09.

## Storage

- Database: `~/.genesis-tools/shops/index.db`
- Cache: `~/.genesis-tools/shops/cache/`
- HTTP request log retention: 30 days (configurable in Plan 02 settings).
