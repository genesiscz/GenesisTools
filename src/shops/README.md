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
- For full schema reference (tables, indexes, FTS), see
  `GenesisBrain/GenesisTools/shops/Spec.md` § "Full schema" (around line 870).

## MCP server (Plan 08)

> **HTTP request log retention:** Every shop API call is recorded in
> `http_request_log` and kept for **30 days** (the retention window is
> configurable via Plan 02 settings). MCP read tools and the dashboards
> rely on this log for traffic analytics, debugging captchas / 403s, and
> rate-limit tuning — so do not truncate it manually outside of explicit
> ops procedures.

`tools shops mcp` runs a stdio MCP server that exposes 8 read-only tools (always available) and 5 write tools (gated behind `--allow-write`):

**Read tools:** `shops_get_product`, `shops_match_product`, `shops_search`, `shops_list_categories`, `shops_compare_prices`, `shops_coverage`, `shops_watch_list`, `shops_recent_notifications`.

**Write tools (require `--allow-write`):** `shops_ingest`, `shops_accept_match`, `shops_watch_add`, `shops_watch_remove`, `shops_notify_ack`.

**Resources:** `shops://product/<shop>/<slug>` and `shops://master/<id>` return JSON the corresponding tools would.

**Stdout discipline:** the logger is auto-routed to stderr when running under MCP so JSON-RPC frames on stdout stay clean.

### Claude Code MCP config

Add the following to your `~/.config/claude-code/mcp.json` (or platform equivalent):

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

Use the read-only entry by default; switch to `shops-write` only when you need Claude to ingest, accept matches, or mutate the watchlist.
