# shops/commands/* Refactor Summary

## Commits (per command, in order)

- `d601804c` — refactor(shops): extract dev-capture-fixture logic into lib/capture-fixture
- `bae65642` — refactor(shops): extract db-prune logic into lib/db-prune
- `f9b77bf2` — refactor(shops): extract match command logic into lib/match-api (added `resolveProductId` + `rematchProduct` to existing api facade)
- `3a2868a2` — refactor(shops): extract notify reason validation into watchlist-api (`VALID_NOTIFICATION_REASONS` + `assertValidReason`)
- `e4d7d0a2` — refactor(shops): extract db admin logic into lib/db-admin (`listMigrations`, `getDbInfo`, `vacuumDb`)
- `d47e94e1` — refactor(shops): extract watch tick + parsers into lib/watchlist-tick + lib/watch-parsing
- `fb7cab45` — refactor(shops): extract get command flow into lib/get-product (composes `HlidacShopuClient` + `ingestFromHlidacResult`; preserves `--no-cache` / `--full-history` debug logs at command layer)
- `ef6ddd1d` — refactor(shops): extract crawl dispatch into lib/crawler-factory (19-case `createCrawlerForShop` factory; verified count matches original)
- `dbdbbeab` — chore(shops): biome reformat churn from refactor commits (whitespace-only)

## New lib files

- `lib/capture-fixture.ts` + `.test.ts` — fixture capture (HTTP + WebView)
- `lib/db-prune.ts` — `runDbPruneHttp` (test moved from misplaced `commands/notify.test.ts`)
- `lib/db-admin.ts` + `.test.ts` — DB admin queries
- `lib/watchlist-tick.ts` — channel construction + evaluator wiring (`runWatchlistTick`, `buildDefaultChannels`)
- `lib/watch-parsing.ts` + `.test.ts` — `parsePercent` / `parseCooldown`
- `lib/get-product.ts` + `.test.ts` — get-by-URL flow
- `lib/crawler-factory.ts` + `.test.ts` — `createCrawlerForShop`

Reasoning: each represents a distinct domain unit not duplicating any existing facade. `match-api`, `watchlist-api` were extended in place rather than created.

## Test count

- Baseline: 431 pass / 19 skip / 0 fail (450 total)
- Final: 438 pass / 19 skip / 0 fail (457 total). +7 tests (resolveProductId x4, db-admin x3, crawler-factory x2, get-product flow x1, retired 4 thin-wrapper command tests).

## Skipped (already lean / special CLI)

- `mcp.ts` — 17 lines, only delegates to `startMcpServer`. Stdio discipline must stay in command. No-op.
- `ui.ts` — 64 lines, all spawn / signal / process.exit plumbing for vite. CLI-only.
- `daemon.ts` — 64 lines; `SHOPS_DAEMON_TASKS` config + thin `registerTask`/`unregisterTask`/`Executor` wrappers. Already as lean as it gets.
- `shops.ts` — 41 lines; `renderShopsTable` is already exported from the command file, registry init is one line. Borderline; leaving alone to avoid churn for marginal benefit.
- `list.ts` — 59 lines; `runListCommand` already exported and tested, just delegates to `db.listProducts`. Thin wrapper already.

## Coordination collisions

- Team-lead landed `c8f05e73 fix(shops): handle Hlidac shops with no @hlidac-shopu/lib slug parser` mid-stream while I was working. Their unstaged edits to `src/shops/api/HlidacShopuClient.ts` were visible across several of my commits and were never staged into mine. After their commit landed the file showed only a pre-commit-hook biome reformat to their own change in my working tree — left untouched. No semantic collision.
- `.superpowers/` untracked directory ignored throughout.
