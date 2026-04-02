# Superplan 5: Full Provider Integration & Market Data Pipeline

> **MANDATORY — On Every Session Start & After Every Compaction:**
> 1. Read `CLAUDE.md` at the worktree root in full
> 2. Set cwd to `/Users/Martin/Tresors/Projects/GenesisTools/.claude/worktrees/reas` — never drift
> 3. Load skills: `frontend-design`, `shadcn` (+ `writing-plans` if planning)
> 4. If the master plan is not in context, read `plans/2026-04-02-Reas-00-MasterPlan.md` first — it contains cross-cutting architectural decisions that govern all subplans

## Objective

Unlock the full potential of all 5 existing data providers (reas.cz, sreality.cz, bezrealitky.cz, ereality.cz, MF cenova mapa) by wiring them completely into the analysis pipeline, aggregating their data, and exposing rich multi-source analytics. Currently, the analysis pipeline at `lib/analysis-service.ts:84-100` only uses 3 providers (reas for sold, sreality for rentals, MF for benchmarks). Bezrealitky and ereality are implemented, tested, but NOT wired in. The rental-aggregation module exists but is never called by the orchestrator.

## Current State

### Provider Readiness Matrix

| Provider | Client | Status | Data Type | Wired into Pipeline? | Limitations |
|---|---|---|---|---|---|
| reas.cz | `api/reas-client.ts:1-153` | Production | Sold listings (cadastral register) | YES | No disposition filter server-side |
| sreality.cz | `api/sreality-client.ts:1-235` | Production | Rental listings + suggest | YES | Only rentals used |
| bezrealitky.cz | `api/bezrealitky-client.ts:1-259` | Implemented + Tested | Rental + sale listings | NO | GraphQL should become primary; existing SSR / `__NEXT_DATA__` path is _DEPRECATED_ legacy code |
| ereality.cz | `api/ereality-client.ts:1-194` | Implemented + Tested | Rental listings | NO | HTML scraping, fragile |
| MF cenova mapa | `api/mf-rental.ts:1-204` | Production | Government rental benchmarks | YES | XLSX parsing, VK category mapping |

### Unused Backend Modules

- `analysis/rental-aggregation.ts:1-113` — Fully implemented multi-provider rental dedup + aggregation with source tagging. Has `aggregateRentals()` function. NEVER called by analysis-service.
- `rentalAggregation` field exists on `FullAnalysis` type (`types.ts:108`) and `DashboardExport` (`api-export.ts:77`). Always `undefined`.

## Implementation Plan

### Phase A: Wire Missing Providers into Pipeline

- [x] 1. **Wire bezrealitky GraphQL into `analysis-service.ts`** — Add GraphQL-backed `fetchBezrealitkyRentals()` / `fetchBezrealitkySales()` flows to the `Promise.allSettled` array at `analysis-service.ts:84-100`. Use the validated `AdvertList` / `AdvertRelatedList` operations as the primary contract. Mark the existing SSR / `__NEXT_DATA__` extraction path as _DEPRECATED_ and remove it from the main data path.
- [x] 2. **Wire ereality into `analysis-service.ts`** — Add `fetchErealityRentals(district)` to the `Promise.allSettled` array. Map district names to ereality's URL slug format (already in `ereality-client.ts:26-35`). Convert `ErealityListing` to unified format.
- [x] 3. **Call `aggregateRentals()` in analysis pipeline** — After all rental providers resolve, pass their combined results to `rental-aggregation.ts:aggregateRentals()`. Store result in `FullAnalysis.rentalAggregation`. This module already handles deduplication by price+area proximity and source tagging.
- [x] 4. **Create unified `RentalListing` interface** — Standardize rental data across providers. Fields: `id`, `source` (provider name), `disposition`, `area`, `rent`, `rentPerM2`, `address`, `link`, `coordinates`, `fetchedAt`, `buildingType`, `description`. Each provider client maps to this interface.
- [x] 5. **Extend bezrealitky GraphQL to fetch SALE listings too** — Use the same validated GraphQL contract for active sale inventory (nabídky prodej) so Bezrealitky complements REAS sold data with live asking prices. The SSR / Apollo page-scrape path stays _DEPRECATED_ and should not be expanded further.

### Phase B: Sreality for Sales (not just rentals)

- [x] 6. **Extend sreality-client to fetch sale listings** — Currently only `fetchRentalListings()` exists at `sreality-client.ts:87-140`. Add `fetchSaleListings()` using the same API with `category_main_cb=1` (prodej) instead of `category_main_cb=2` (pronájem). This gives active asking prices to compare against reas.cz's sold prices.
- [ ] 7. **Create `ActiveVsSoldComparison` analysis module** — New module that compares active asking prices (sreality/bezrealitky) against sold prices (reas.cz). Computes: asking-to-sold ratio, typical negotiation discount, average time from listing to sale. This is high-value intelligence.

### Phase C: MF Cenova Mapa Deep Integration

- [ ] 8. **Expand MF data display in UI** — Currently MF benchmarks exist in `DashboardExport.benchmarks.mf` but are never rendered. Create `MfBenchmarkCard` component showing: VK1-VK4 reference prices per cadastral unit, confidence intervals, new-build premium, coverage score. Show as comparison bar chart (MF reference vs actual market median vs user's price).
- [ ] 9. **Map MF cadastral units to districts automatically** — Currently MF data is fetched for a specific cadastral area. Add mapping from district ID to relevant cadastral units (multiple MF areas may be within one district). Fetch all relevant cadastral areas for comprehensive coverage.
- [ ] 10. **Use MF data for rent validation** — On the Rentals tab, overlay MF reference rental prices on the market data chart. Show "MF says X Kč/m²/month, market shows Y Kč/m²/month" comparison. This validates whether market rents are above or below government benchmarks.

### Phase D: Data Source Attribution & Transparency

- [ ] 11. **Add source tagging to every data point** — Every listing, every stat, every chart data point should be traceable to its source. Add `sources: string[]` to every aggregated metric. The UI should show "Based on: 477 reas.cz sales + 89 sreality rentals + 34 bezrealitky rentals + 21 ereality rentals + MF benchmarks".
- [ ] 12. **Create `DataProvenance` component** — Footer/sidebar component showing: which providers were queried, how many results each returned, when each was last fetched, any errors/warnings (e.g., "bezrealitky returned 0 — may be rate limited"). Matches the footer in `analysis-letnany.jsx:867`.
- [ ] 13. **Add provider health monitoring** — Track success/failure/count per provider in SQLite. Show provider health dashboard: "reas.cz: 98% success, avg 1.2s | bezrealitky: 85% success, avg 3.1s | ereality: 72% success, avg 2.8s".

### Phase E: Enhanced Rental Analysis

- [ ] 14. **Create per-disposition rental aggregation view** — Using `AggregatedRentalStats` from `rental-aggregation.ts`, show rental data broken down by disposition with per-provider counts. DataTable with columns: Disposition, Provider Count, Min, Median, Max, Avg, Avg Area, Rent/m². Matches `analysis-letnany.jsx:511-522` but with multi-provider data.
- [ ] 15. **Add rental-to-price ratio per disposition** — Cross-reference rental medians with sale medians per disposition. Compute yield per disposition. Show which disposition has the best rental yield in the area.
- [ ] 16. **Add rent estimation model** — Use aggregated rental data to build a simple regression: `estimatedRent = f(area, disposition, district, buildingType)`. Display as "AI-estimated rent for your property: X Kč ± Y" on the analysis overview.

### Phase F: Caching & Performance

- [ ] 17. **Implement staggered cache refresh** — Instead of all-or-nothing cache, refresh providers independently. If reas cache is stale but sreality is fresh, only re-fetch reas. Each provider's cache TTL is already different (24h reas, 6h sreality/bezrealitky/ereality, 7d MF).
- [ ] 18. **Add cache warming endpoint** — API endpoint that pre-fetches and caches data for specified districts without running full analysis. Used by the District Comparison pre-seed feature (Plan 3) and watchlist refresh-all (Plan 4).
- [ ] 19. **Implement incremental listing ingestion** — Instead of replacing all cached listings, merge new listings with existing ones. Track listing state changes (price drops, removal).

## Verification Criteria

- Analysis pipeline calls all 5 providers in parallel
- Rental data aggregation works: deduplication reduces total count, source attribution preserved
- UI shows rental data from 3+ sources with per-source count
- MF benchmark comparison chart renders alongside market data
- Active sale listings from sreality/bezrealitky complement reas sold data
- ActiveVsSoldComparison shows asking-to-sold price ratio
- Every analysis result shows data provenance footer
- Provider health dashboard shows success/failure rates
- Rent estimation model provides predictions for user's property parameters

## Potential Risks and Mitigations

1. **Bezrealitky GraphQL contract may change**
   Mitigation: Lock the exact `AdvertList` / `AdvertRelatedList` contracts into fixtures and tests. Keep the legacy SSR / `__NEXT_DATA__` parser explicitly marked _DEPRECATED_ and out of the default path rather than treating it as the normal integration surface.

2. **Ereality HTML scraping is even more fragile**
   Mitigation: Regex-based extraction at `ereality-client.ts:58-85` will break on HTML changes. Add error boundary + warning. Ereality contributes least data volume — acceptable to lose temporarily.

3. **Deduplication across providers may over-prune**
   Mitigation: `rental-aggregation.ts:46-68` uses price±5% AND area±3m² proximity. These thresholds are conservative and tested. Log dedup stats for monitoring.

4. **Rate limiting when fetching from 5 providers simultaneously**
   Mitigation: Existing rate limits per provider are respected. `Promise.allSettled` with per-provider timeouts (already in `lib/fetch.ts`) prevents one slow provider from blocking others.

## Alternative Approaches

1. **Add new providers instead of maximizing existing ones**: Could add Realitymix, Eurobydleni, UlovDomov etc. But first maximize the 5 existing providers before adding more.
2. **Use a scraping service (Bright Data, ScrapingBee) for robustness**: Would increase reliability but adds cost and dependency. Direct scraping with graceful degradation is sufficient for a personal tool.
3. **GraphQL API layer over all providers**: Would provide cleaner data access but over-engineering for the current use case. REST endpoints with typed responses are sufficient.

## API Discovery Appendendum (execute before Phase A)

### Discovery Inputs Already Identified

- `www.sreality.cz.har` shows that the public Sreality web app is currently using richer **v1** endpoints in addition to the already-integrated v2 API: `/api/v1/estates/search`, `/api/v1/estates/filter_page/histogram`, `/api/v1/estates/search/clusters`, `/api/v1/localities/geometries`, and `/_next/data/...` payloads with dehydrated search results.
- The current REAS integration only uses the sold catalog client in `src/Internal/commands/reas/api/reas-client.ts`; discovery still needs to verify whether there are additional REAS detail/search surfaces worth exposing for the dashboard and listings browser.
- Bezrealitky should be treated as a GraphQL-first provider. The validated operations to productize are `AdvertList`, `AdvertRelatedList`, and `AdvertDetail`, including fields such as `publicImages`, `mortgageData`, `originalPrice`, `links`, `gps`, `videos`, `dataJson`, `shortTerm`, `poiData`, `regionTree`, `formattedAds`, `serviceCharges`, `utilityCharges`, `deposit`, `availableFrom`, `relatedAdverts`, and `nemoreport`. The existing SSR / Apollo extraction is _DEPRECATED_ and kept only as legacy context, not as the target architecture.
- **Concrete Bezrealitky operations to lock in**:
  - `AdvertList(limit, offset, order, boundaryPoints, currency, estateType, offerType, ...)` — primary search/browse contract for listings pages, rental analysis, and active market inventory.
  - `AdvertRelatedList(limit, offset, order, boundaryPoints, currency, estateType, offerType, ...)` — comparable/nearby suggestion contract for "similar listings" and supporting comparison widgets.
  - `AdvertDetail(id, locale, relatedAdvertLimit, withUser, isOwner)` — canonical detail hydration contract for listing sheets, media, charges, POIs, `regionTree`, `formattedAds`, related adverts, and provenance links.
- **Explicit Bezrealitky operation-purpose mapping**:
  - **Rentals browse / active rentals table** → `AdvertList` with `offerType=["PRONAJEM"]`, `estateType=["BYT"]`, map boundary filters, pagination, and sort order.
  - **Sales browse / active sale inventory** → `AdvertList` with `offerType=["PRODEJ"]`, `estateType=["BYT"]` (and later other estate types if expanded).
  - **Rental comparables / “Srovnání nabídek” widgets** → `AdvertRelatedList` for similar nearby adverts matching listing context.
  - **Listing detail sheet / enriched source page** → `AdvertDetail` for full structured data: description, charges, utilities, deposit, `availableFrom`, media, `poiData`, `regionTree`, `formattedAds`, links, `nemoreport`, related adverts.
  - **Investment analysis enrichment** → `AdvertDetail.mortgageData`, `originalPrice`, `isDiscounted`, structured charges, and `formattedAds`.
  - **Source provenance / clickthroughs** → `AdvertDetail.links`, `uri`, `regionTree`, and related advert metadata.
- **Correct HAR workflow name**: the local GenesisTools skill/workflow to use for HAR analysis is `gt:analyze-har` from `plugins/genesis-tools/skills/analyze-har/SKILL.md` (not `har-analyzer`).

### Sreality HAR-derived Endpoint Contract (discovery target)

- **Primary discovery source** → `www.sreality.cz.har` processed via `gt:analyze-har`; this is the authoritative contract for the public web app surfaces, not guesswork from the existing v2 client alone.
- **Current in-repo baseline** → the existing client still uses `https://www.sreality.cz/api/cs/v2/estates` + `/suggest` and only maps minimal listing fields (`hash_id`, `name`, `price`, `locality`, `gps`, `labels`, parsed disposition/area, constructed link) in `src/Internal/commands/reas/api/sreality-client.ts:6-8`, `src/Internal/commands/reas/api/sreality-client.ts:15-35`, `src/Internal/commands/reas/api/sreality-client.ts:125-148`, `src/Internal/commands/reas/api/sreality-client.ts:155-205`.
- **Endpoint families to lock in from HAR**:
  - `/api/v1/estates/search` — canonical active listings search surface for richer browse results.
  - `/api/v1/estates/filter_page/histogram` — canonical distribution/histogram surface for dashboard charting.
  - `/api/v1/estates/search/clusters` — canonical density/map cluster surface for live listing browse and district density views.
  - `/api/v1/localities/geometries` — canonical district / locality polygon overlay surface.
  - `/_next/data/...` — dehydrated Next.js payloads that may expose richer card/result metadata not present in the current v2 adapter.
- **Explicit Sreality endpoint-purpose mapping**:
  - **Rentals browse / active rental inventory** → `/api/v1/estates/search` with rental category filters.
  - **Sales browse / active sale inventory** → `/api/v1/estates/search` with sale category filters.
  - **Price distribution / scenario charts / disposition-type matrices** → `/api/v1/estates/filter_page/histogram`.
  - **Live listings map / district density / cluster summary widgets** → `/api/v1/estates/search/clusters`.
  - **Interactive Prague district overlays / selectable locality boundaries** → `/api/v1/localities/geometries`.
  - **Richer listing cards / breadcrumbs / auxiliary locality metadata** → `/_next/data/...` only where it exposes fields the direct API surface does not.

### Sreality Request Contract Baseline (to persist from HAR)

- **Preserve full request URLs and query parameters from fixtures** for each endpoint family; do not assume v1 params are identical to the current v2 client.
- **Compare against existing working v2 filters** from `sreality-client.ts` when mapping semantics: `category_main_cb`, `category_type_cb`, `category_sub_cb`, `locality_region_id`, `locality_district_id`, `building_type_search`, `per_page`, `page`, `tms` in `src/Internal/commands/reas/api/sreality-client.ts:83-113`.
- **Preserve filter semantics from HAR exactly** for locality, sale vs rental category, disposition/type, building type, pagination, sorting, viewport/map bounds, and any feature flags present in the web app requests.
- **Persist separate request fixtures** for rental search, sale search, histogram, clusters, geometries, and representative `/_next/data` page payloads.
- **Do not treat `/_next/data` as the primary browse contract** if the direct v1 JSON endpoint provides the same fields more cleanly.

### Exact field groups to normalize from Sreality HAR surfaces

- **`/api/v1/estates/search` result fields** (normalize whatever exact field names the HAR confirms):
  - Identity / routing → listing id / `hash_id`, canonical detail URL inputs, SEO slug/locality parts, listing type/category ids.
  - Commercial metrics → asking price, `priceCzkPerSqM` when present, currency, discount / promo indicators, days-on-market style metadata if present.
  - Property shape → disposition, usable area, land area, building/construction type, ownership, floor / total floors, energy label when present.
  - Location → locality text, district / region identifiers, GPS / centroid, locality hierarchy, breadcrumb/location labels.
  - Presentation → title/name, labels/badges, image counts, primary image, gallery thumbs, project / broker hints.
  - Provenance / outgoing linkability → detail link inputs, source tags, search metadata, publication / ordering metadata.
  - Query-level metadata → total result count, page size, current page, filter context.

- **`/api/v1/estates/filter_page/histogram` fields**:
  - Bucket identity → lower/upper bound or label/range.
  - Aggregate counts → listing count per bucket.
  - Dimension metadata → which metric is bucketed (price, price/m², area, DOM, etc.) and any active filter context.
  - Comparative metadata → totals / medians / reference markers when the endpoint exposes them.
  - Use case → feed dashboard histograms directly instead of recomputing only from paginated listing pages.

- **`/api/v1/estates/search/clusters` fields**:
  - Cluster location → centroid / lat/lon.
  - Cluster magnitude → count / weight / zoom-dependent aggregate.
  - Cluster scope → bounding box / tile / viewport info when present.
  - Optional sample payloads → representative listing ids or excerpts if returned.
  - Use case → map density layers, district heat summaries, “live listings nearby” views.

- **`/api/v1/localities/geometries` fields**:
  - Locality identity → locality / district / region ids and names.
  - Geometry payload → polygon / multipolygon coordinates.
  - Geometry helpers → centroid, bbox, slug, hierarchy, display labels when present.
  - Use case → interactive district selection, overlay highlighting, locality-aware filtering.

- **`/_next/data/...` dehydrated payload fields**:
  - Search page state → filters, pagination, selected locality context, totals.
  - Enriched card data → image URLs, price-per-m², extra badges, locality breadcrumbs, project/broker hints.
  - UI metadata → whichever labels/derived strings the app renders but direct API responses omit.
  - Use case → secondary enrichment layer only, not first-choice primary ingestion if direct v1 endpoints are sufficient.

### Sreality Implementation-level normalization rules

- Keep the current v2 client as a stable baseline, but promote v1 / HAR-derived surfaces where they provide materially richer fields or direct aggregates.
- Create separate typed adapters for `search`, `histogram`, `clusters`, `geometries`, and `next-data` instead of one oversized parser.
- Persist raw response snapshots and normalized outputs per endpoint family so fixtures can detect contract drift.
- Tag every normalized record / aggregate with the exact source contract: `sreality-v2`, `sreality-v1-search`, `sreality-v1-histogram`, `sreality-v1-clusters`, `sreality-v1-geometries`, or `sreality-next-data`.
- Prefer direct endpoint aggregates (`histogram`, `clusters`) over recomputing approximate values from paginated listing subsets.
- Use `geometries` to drive the district-selection UI and map overlays instead of hand-maintained polygon data.
- Use `/_next/data` only for enrichment fields not otherwise available, and keep its usage explicit in provenance so it never becomes hidden scraping.

### Bezrealitky GraphQL Request Contract (known-good baseline)

- **Endpoint** → `https://api.bezrealitky.cz/graphql/`
- **Observed-important headers** → `content-type: application/json`, `origin: https://www.bezrealitky.cz`, `referer: https://www.bezrealitky.cz/`, `accept: */*`, `accept-language: cs-CZ,cs;q=0.8`, plus a normal browser-like user agent.
- **Locale / currency defaults to preserve in fixtures** → `locale="CS"`, `currency="CZK"`
- **Map search baseline** → use `boundaryPoints` polygon search because the working examples and real browse flows use map-bounded queries.
- **Pagination / sorting baseline** → `limit`, `offset`, `order="TIMEORDER_DESC"`
- **Rental browse baseline** → `offerType=["PRONAJEM"]`, `estateType=["BYT"]`
- **Sale browse baseline** → `offerType=["PRODEJ"]`, `estateType=["BYT"]`
- **Do not plan around SSR extraction anymore** → GraphQL request/response fixtures become the contract; SSR / `__NEXT_DATA__` remains _DEPRECATED_ context only.

### Exact field groups to normalize from Bezrealitky GraphQL

- **`AdvertList` browse/result fields**:
  - Identity / routing → `id`, `uri`, `type`, `estateType`, `offerType`, `disposition`, `landType`
  - Visuals → `imageAltText`, `mainImage.url`, `publicImages[].url`, `publicImages[].size`, `videos[].previewUrl`
  - Pricing → `price`, `charges`, `currency`, `originalPrice`, `isDiscounted`
  - Property shape → `surface`, `surfaceLand`, `tags`, `construction`, `shortTerm`
  - Location → `address`, `gps.lat`, `gps.lng`
  - Investment hints → `mortgageData.rateLow`, `mortgageData.rateHigh`, `mortgageData.loan`, `mortgageData.years`
  - Provenance / outgoing links → `links[].url`, `links[].type`, `links[].status`, `nemoreport.status`, `nemoreport.timeCreated`
  - Raw provider context → `dataJson`, `project.id`, `reserved`, `highlighted`, `roommate`, `petFriendly`, `isNew`
  - Query-level aggregate → `totalCount`, and the aliased `actionList.totalCount` when present for discounted counts / callouts.

- **`AdvertRelatedList` comparable fields**:
  - Identity / routing → `id`, `uri`, `offerType`, `estateType`, `disposition`, `landType`, `type`
  - Pricing / shape → `surface`, `surfaceLand`, `price`, `charges`, `currency`, `originalPrice`, `isDiscounted`
  - Location / visuals → `address`, `mainImage.url`
  - Provider context → `project.id`, `dataJson`
  - Query-level aggregate → `totalCount`

- **`AdvertDetail` full hydration field groups**:
  - Identity / publishing state → `id`, `uri`, `externalId`, `active`, `archived`, `reserved`, `highlighted`, `isNew`, `isPausedBySystem`, `isPausedByUser`, `type`
  - Description / marketing → `description`, `descriptionEnglish`, `descriptionByLocale`, `tags`, `comfortNote`, `comfortToCheck`, `situation`
  - Pricing / charges / affordability → `price`, `serviceCharges`, `serviceChargesNote`, `utilityCharges`, `utilityChargesNote`, `charges`, `fee`, `currency`, `deposit`, `annuity`, `priceProposalAllowed`, `originalPrice`, `isDiscounted`, `mortgageData.*`
  - Availability / usage → `availableFrom`, `timeDeactivated`, `shortTerm`, `roommate`, `equipped`, `condition`, `ownership`, `transferToPersonalOwnership`
  - Physical characteristics → `estateType`, `offerType`, `disposition`, `position`, `surface`, `surfaceLand`, `construction`, `reconstruction`, `execution`, `landType`, `age`, `floor`, `etage`, `totalFloors`, `penb`, `heating`, `lowEnergy`
  - Amenities → `balcony`, `balconySurface`, `terrace`, `terraceSurface`, `loggia`, `loggiaSurface`, `parking`, `lift`, `frontGarden`, `cellar`, `cellarSurface`, `barrierFree`, `garage`, `petFriendly`
  - Utilities / infrastructure → `water`, `sewage`
  - Address / geo / locality → `address`, `city`, `gps`, `street`, `houseNumber`, `houseUnit`, `zip`, `ruianId`, `region.id`, `regionTree[]`, `isPrague`, `isCityWithDistricts`
  - Media → `imageAltText`, `mainImage.url`, `publicImages[]`, `videos[]`, `tour360`
  - POI / neighborhood → `poiData`, `formattedAds[]`
  - Related listings / comparison context → `relatedAdverts.list[]`, `relatedAdvertParameters`
  - Messaging / contact flow → `messageData.messageType`, `messageData.requireLogin`, `messageData.url`, `conversationCount`, `withUser`, `user.id`
  - Provenance / external artifacts → `links[]`, `nemoreport.id`, `nemoreport.resultUrl`, `nemoreport.status`, `nemoreport.timeCreated`, `project.id`, `project.dataJson`, `dataJson`
  - Compliance / product flags → `realmanExportEnabled`, `requireCreditcheck`, `requireInsurance`, `showOwnest`, `premiumProfileVoucher`

### Implementation-level normalization rules

- Build canonical Bezrealitky URLs from `uri` first; use direct `links[]` where they are better provenance than reconstructed paths.
- Persist both normalized fields and the raw GraphQL payload keyed by `operationName` so the UI can progressively expose more detail without re-scraping.
- Treat `charges`, `serviceCharges`, `utilityCharges`, `fee`, and `deposit` as separate first-class normalized fields; do not collapse them prematurely into a single number.
- Store both `gps` and `regionTree` so district filters and locality breadcrumbs are possible.
- Store `formattedAds` and `poiData` for richer explanation blocks, locality badges, and neighborhood summaries.
- Use `relatedAdverts` as a first-class source for "similar listings" UI and fallback comparables, not just decorative detail data.
- Use `mortgageData`, `originalPrice`, and `isDiscounted` for affordability / investment widgets and discount callouts.
- Carry `nemoreport` and `links[]` through to the UI for source transparency and outbound clickthroughs.

### Appendendum Tasks

- [ ] **Run a HAR-driven Sreality contract capture** — Use the local GenesisTools HAR workflow `gt:analyze-har` as the reference procedure. Treat `www.sreality.cz.har` as the source of truth for the web app’s live contract. Capture the exact request/response shapes, query parameters, pagination behavior, and cross-endpoint relationships for `/api/v1/estates/search`, `/api/v1/estates/filter_page/histogram`, `/api/v1/estates/search/clusters`, `/api/v1/localities/geometries`, and the `/_next/data/...` dehydrated search payload.
- [ ] **Persist exact Sreality request templates in fixtures** — Save known-good HAR-derived request templates for rental search, sale search, histogram, clusters, geometries, and representative `/_next/data` payloads. Preserve full URLs/query params and tag each fixture with the endpoint family.
- [ ] **Implement explicit Sreality endpoint mappers** — Create dedicated typed adapters for `sreality-v1-search`, `sreality-v1-histogram`, `sreality-v1-clusters`, `sreality-v1-geometries`, and `sreality-next-data` instead of extending the current small v2 mapper forever. Each mapper should preserve raw payload, normalized fields, and provenance tags.
- [ ] **Implement a discovery-backed Sreality adapter strategy** — Keep the current v2 client as a stable baseline, but add an adapter layer that can consume the richer v1 / `_next/data` surfaces when they provide fields the dashboard needs (histograms, clusters, geometry, images, per-result `priceCzkPerSqM`, richer locality metadata, broker/project hints). Persist the chosen contract in tests so we are not guessing.
- [ ] **Use Sreality search as the canonical active listings surface** — Productize `/api/v1/estates/search` for both rentals and sales so listings ingestion and active-vs-sold analysis are not limited to the current rental-only v2 adapter.
- [ ] **Use Sreality histogram responses directly in analytics** — Feed dashboard distribution widgets and disposition/type matrix charts from `/api/v1/estates/filter_page/histogram` where available instead of recomputing all buckets only from paginated listing subsets.
- [ ] **Use Sreality clusters and geometries for map-driven UX** — Productize `/api/v1/estates/search/clusters` and `/api/v1/localities/geometries` for district overlays, live listings density views, and interactive locality selection.
- [ ] **Treat `/_next/data` as a secondary enrichment layer only** — Use dehydrated Next.js payloads only for richer card metadata or labels not present in the chosen direct API contract, and tag this provenance explicitly in persistence/UI.
- [ ] **Add a proper Bezrealitky GraphQL client path** — Validate and integrate `AdvertList`, `AdvertRelatedList`, and `AdvertDetail` as the primary fetchers. Treat GraphQL as the canonical Bezrealitky contract for browse/search, related-listing expansion, listing detail hydration, images, `mortgageData`, `originalPrice`, `isDiscounted`, `links`, `videos`, `shortTerm`, `dataJson`, structured charges, `regionTree`, `formattedAds`, and `nemoreport`. Mark the current SSR / `__NEXT_DATA__` extraction as _DEPRECATED_ everywhere in implementation notes and do not extend it further.
- [ ] **Implement explicit operation mappers** — Create dedicated typed mappers for `AdvertList`, `AdvertRelatedList`, and `AdvertDetail` instead of one loose parser. Each mapper should preserve raw payload, normalized listing fields, pricing subfields, media, location, provenance, and investment hints.
- [ ] **Persist exact request templates in fixtures** — Save known-good request bodies for rental browse, sale browse, comparable search, and detail hydration, including baseline headers/variables (`locale`, `currency`, polygon `boundaryPoints`, pagination, sort order).
- [ ] **Add fetch-on-open detail hydration** — Listings tables should ingest from `AdvertList`, but the detail panel should lazily hydrate missing fields from `AdvertDetail` and cache them separately so browse requests stay lightweight.
- [ ] **Perform a REAS API discovery pass** — Audit the REAS catalog integration beyond the currently used sold-listing flow. Identify whether additional detail, locality, or history endpoints exist and whether they can feed the dashboard with better provenance, listing links, transaction context, or distribution data. Update the provider capability matrix only after this audit.
- [ ] **Lock exact Bezrealitky GraphQL operations into fixtures** — Capture `AdvertList` for search/browse, `AdvertRelatedList` for comparable suggestions, and `AdvertDetail` for full listing hydration (charges, media, POIs, `regionTree`, related adverts, mortgage hints, provenance links). Persist fixture-driven tests for these exact operations before downstream UI work consumes them.
