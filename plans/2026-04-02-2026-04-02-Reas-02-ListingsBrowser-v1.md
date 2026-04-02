# Superplan 2: Listings Browser — Live & Sold with Source Links

> **MANDATORY — On Every Session Start & After Every Compaction:**
> 1. Read `CLAUDE.md` at the worktree root in full
> 2. Set cwd to `/Users/Martin/Tresors/Projects/GenesisTools/.claude/worktrees/reas` — never drift
> 3. Load skills: `frontend-design`, `shadcn` (+ `writing-plans` if planning)
> 4. If the master plan is not in context, read `plans/2026-04-02-Reas-00-MasterPlan.md` first — it contains cross-cutting architectural decisions that govern all subplans

## Objective

Create two new pages (`/listings/live` and `/listings/sold`) that let users browse, filter, click through, and see details of both active and sold property listings from all sources. Currently there is zero listing browsing capability — the user cannot see what's on the market, what sold, or where the data came from. Every listing must link back to its source URL.

## Current State

- No listings browsing page exists anywhere in the UI
- `listings.sold` array exists in `DashboardExport:18-28` with fields: disposition, area, price, pricePerM2, address, soldAt, daysOnMarket, discount, link, source
- `listings.rentals` array exists in `DashboardExport:30-38` with fields: disposition, area, rent, rentPerM2, address, link, source
- Sold listings come from reas.cz (`api/reas-client.ts`) — each has a `link` field pointing to the reas.cz detail page
- Rental listings come from sreality.cz (`api/sreality-client.ts:125-137`) — links constructed as `https://www.sreality.cz/detail/${hash_id}`
- Bezrealitky listings should come from the GraphQL client path (`api/bezrealitky-client.ts`) with source-native URLs and media; the legacy SSR / `__NEXT_DATA__` scraping path is _DEPRECATED_ and should only remain as historical context during migration
- Ereality listings (`api/ereality-client.ts`) return `link` directly
- The store has no listing persistence — listings only exist in analysis results

## Implementation Plan

### Phase A: Backend — Listing Persistence & API

- [ ] 1. **Add `listings` table to `lib/store.ts`** — New SQLite table: `id, source, type (sale|rental|sold), district, disposition, area, price, pricePerM2, address, link, sourceId, fetchedAt, soldAt, daysOnMarket, discount, status (active|sold|removed), raw JSON blob`. Index on `source + sourceId` for dedup, index on `district + type` for filtering.
- [ ] 2. **Create listing ingestion in analysis-service.ts** — After `fetchAndAnalyze` completes, persist all fetched listings (sold from reas, rentals from sreality/bezrealitky/ereality) into the listings table. Upsert by `source + sourceId`.
- [ ] 3. **Create `/api/listings` server route** — GET endpoint with query params: `type` (sale|rental|sold), `district`, `disposition`, `source`, `priceMin`, `priceMax`, `areaMin`, `areaMax`, `sortBy`, `sortDir`, `page`, `limit`. Returns paginated listing array with total count.
- [ ] 4. **Create `/api/listings/[id]` server route** — GET single listing detail by ID. Returns full listing with raw JSON blob for maximum detail.
- [ ] 5. **Extend bezrealitky and ereality clients to return standardized listing format** — Create a `UnifiedListing` interface that all providers map to. Include: `sourceId`, `source`, `type`, `link`, `address`, `disposition`, `area`, `price`, `pricePerM2`, `rent`, `rentPerM2`, `buildingType`, `description` (if available from GraphQL/provider payload), `images` (if available), `coordinates`, `fetchedAt`. Bezrealitky should map from GraphQL as the primary contract; legacy SSR scraping is _DEPRECATED_.

### Phase B: shadcn Components Needed

- [ ] 6. **Add `DropdownMenu` to `src/ui/`** — For listing action menus (open source, add to watchlist, compare).
- [ ] 7. **Add `Pagination` to `src/ui/`** — For paginated listing table.
- [ ] 8. **Add `Sheet` (side panel) to `src/ui/`** — For listing detail slide-out without leaving the listing page.
- [ ] 9. **Add `Popover` to `src/ui/`** — For filter popovers on listing columns.

### Phase C: Listings Pages

- [ ] 10. **Create `/listings` route with sub-tabs** — Main listings page with 3 tabs: "Na prodej" (For Sale — active), "Pronájmy" (Rentals — active), "Prodané" (Sold). Each tab is a filterable, sortable, paginated table.
- [ ] 11. **Build `ListingsTable` component** — Reusable table with shadcn Table, sortable columns, pagination. Columns: Source icon/badge, Address (linked to source URL), Disposition, Area, Price, CZK/m², District, Date (fetchedAt or soldAt), Actions. Source badges show origin (reas.cz, sreality.cz, bezrealitky.cz, ereality.cz) with colored indicators.
- [ ] 12. **Build `ListingFilters` component** — Horizontal filter bar with: District select, Disposition multi-select, Price range (min/max inputs), Area range, Source multi-select (checkboxes for each provider), Date range picker. Uses shadcn Select, Input, DateRangePicker.
- [ ] 13. **Build `ListingDetail` sheet/panel** — Side panel (shadcn Sheet) that slides in when clicking a listing row. Shows: Full address, all metrics, map embed (if coordinates available), link to source, "Add to Watchlist" button, listing history (price changes if tracked). For sold listings: shows soldAt date, original price, sold price, discount, days on market. For Bezrealitky active listings, hydrate the panel from GraphQL `AdvertDetail` so it can render structured charges, deposit, `availableFrom`, media gallery, `poiData`, `regionTree`, `formattedAds`, related adverts, and `nemoreport` links.
- [ ] 14. **Build `SourceBadge` component** — Small colored badge showing data source with link. Reas = blue, Sreality = green, Bezrealitky = orange, Ereality = purple, MF = gray.
- [ ] 15. **Add listings navigation to `__root.tsx`** — Add "Listings" nav item to the root layout at `__root.tsx:36-56`.

### Phase D: Data Freshness & Auto-Fetch

- [ ] 16. **Add "Fetch Listings" action button** — Button on listings page that triggers fresh data fetch for selected district/filters. Shows progress indicator. Uses existing cache with manual refresh option.
- [ ] 17. **Show data freshness per source** — Each source column shows when data was last fetched. Use existing `StalenessIndicator` component.
- [ ] 18. **Add listing count summary** — Top of page shows: "342 sold listings | 89 rentals | from 4 sources | Last updated: 2h ago"

## Verification Criteria

- User can browse sold listings from reas.cz with clickable links to source
- User can browse rental listings from sreality, bezrealitky, ereality with source links
- Every listing shows its data provenance (source badge + direct link)
- Filters work: district, disposition, price range, area range, source selection
- Pagination works with 50 listings per page
- Clicking a listing row opens detail panel without navigation
- "Add to Watchlist" from listing detail works
- Data persists across sessions in SQLite

## Potential Risks and Mitigations

1. **Provider rate limiting / blocking for Bezrealitky GraphQL and eReality HTML**
   Mitigation: Use cached data when available, only fetch fresh on explicit user action, and lock Bezrealitky to the GraphQL contract validated in Plan 5. The legacy Bezrealitky SSR / `__NEXT_DATA__` path is _DEPRECATED_ and should not be treated as the normal fallback architecture.

2. **Large listing volume may slow SQLite queries**
   Mitigation: Proper indexes on (source, sourceId), (district, type), (fetchedAt). Pagination limits response size. SQLite handles 100k+ rows easily.

3. **Listing links may become stale (listings removed from source)**
   Mitigation: Track `status` field. Periodic re-check could mark listings as removed. Show stale indicator on old listings.

## Alternative Approaches

1. **Virtual scrolling instead of pagination**: Better UX for large datasets but adds complexity. Pagination is simpler to implement first, virtual scrolling can be added later.
2. **Full-page listing detail instead of side panel**: More screen space but loses context. Sheet/panel pattern keeps the list visible for quick browsing.

## API Discovery Appendendum

- [ ] **Store richer listing payloads from discovery-backed endpoints** — When Plan 5 validates Sreality v1 / `_next/data` and Bezrealitky GraphQL contracts, extend the listings store to keep images, `originalPrice`, mortgage hints, richer locality metadata, source-native links, and raw provider payload snapshots so the listings browser can show more than the current minimal normalized fields.
- [ ] **Prefer first-class provider links and media** — Use discovered Sreality and Bezrealitky fields to populate clickable source URLs, thumbnails, image galleries, and related-listing links in the listing detail sheet instead of relying only on reconstructed URLs.
- [ ] **Tag the exact source contract used for each listing** — Distinguish `sreality-v2`, `sreality-v1`, `sreality-next-data`, `bezrealitky-graphql`, `bezrealitky-ssr-deprecated`, `reas-catalog`, and `ereality-html` in persistence so debugging provenance is possible from the browser UI.

