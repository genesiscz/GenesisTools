# Superplan 4: Watchlist 2.0 — Full Property Analysis Cards with Investment Intelligence

> **MANDATORY — On Every Session Start & After Every Compaction:**
> 1. Read `CLAUDE.md` at the worktree root in full
> 2. Set cwd to `/Users/Martin/Tresors/Projects/GenesisTools/.claude/worktrees/reas` — never drift
> 3. Load skills: `frontend-design`, `shadcn` (+ `writing-plans` if planning)
> 4. If the master plan is not in context, read `plans/2026-04-02-Reas-00-MasterPlan.md` first — it contains cross-cutting architectural decisions that govern all subplans

## Objective

Transform the shallow `/watchlist` page from a flat property summary into a full investment intelligence dashboard per property. Currently `watchlist.tsx:1-180` shows bare-minimum cards (district, type, disposition, net yield, median CZK/m²) with no analysis depth, no source links, no charts, no trend tracking, and no investment metrics. Target: each watchlist property should show a mini-analysis matching the Hypoteka benchmark depth with expandable sections.

## Current State

- `watchlist.tsx:1-180` — Lists saved properties, allows Add/Delete/Refresh
- `PropertyCard.tsx:1-160` — Shows: name, grade badge, staleness, property details grid (5 fields), notes, action buttons
- `AddPropertyForm.tsx:1-269` — Dialog with basic fields, no mortgage params, no auto-rent estimation
- `api/properties.ts:1-109` — CRUD + refresh (re-runs analysis on refresh)
- `SavedPropertyRow` in `store.ts:35-55` stores: name, district, type, disposition, price, area, rent, costs, notes, grade, net yield, median CZK/m²
- NO: trend data, yield history, score history, rental data, comparable count, source links, mortgage calculation

## Implementation Plan

### Phase A: Backend — Rich Property Data

- [x] 1. **Extend `saved_properties` table** — Add columns: `score`, `grossYield`, `paybackYears`, `percentile`, `comparableCount`, `rentalCount`, `timeOnMarket`, `discountVsMarket`, `momentum`, `lastAnalysisJson` (full DashboardExport blob). Migration: ALTER TABLE with defaults.
- [x] 2. **Store analysis history per property** — Create `property_analysis_history` table: `id, propertyId, analyzedAt, grade, score, netYield, grossYield, medianPricePerM2, comparableCount, rentalMedian`. On each refresh, insert a row. This enables tracking changes over time.
- [x] 3. **Extend PATCH `/api/properties` to store full analysis on refresh** — When refresh is triggered, store the complete DashboardExport JSON and extract summary metrics into the new columns.
- [x] 4. **Create `/api/properties/[id]/history` endpoint** — Returns analysis history for a specific property. Used for trend sparklines.
- [x] 5. **Add mortgage calculation parameters to `SavePropertyInput`** — Add: `mortgageRate`, `mortgageTerm`, `downPayment`, `loanAmount`. Compute monthly payment, total interest, DSTI, cash-on-cash return.

### Phase B: Property Card Redesign

- [ ] 6. **Build `PropertyCardExpanded` component** — Replace flat `PropertyCard` with an expandable card. Collapsed state shows: name, grade badge + score, key metric row (yield, CZK/m², percentile, momentum arrow). Expanded state reveals full analysis sections.
- [ ] 7. **Build `PropertyMetricRow` component** — Compact horizontal row of 6 mini-stat chips: Grade, Net Yield %, Percentile, CZK/m², Comparables count, Momentum direction. Each chip colored by value quality (green/amber/red).
- [ ] 8. **Build `PropertySparkline` component** — Tiny inline SVG sparkline showing metric trend over time (yield, median price, score). Uses `property_analysis_history` data. Renders inline next to each metric value.
- [ ] 9. **Build `PropertyVerdictMini` component** — Compact verdict block: pass/fail checklist (6 criteria with checkmarks), score gauge (small), buy/hold/avoid recommendation. Matches `letnany-live-dashboard.jsx:494-545` but condensed.
- [ ] 10. **Build `PropertyYieldBreakdown` component** — Shows: gross yield, net yield, at-market comparison, mortgage-adjusted yield (if mortgage params provided), payback years, benchmark comparison bar. Matches `YieldCard` but with mortgage intelligence added.
- [ ] 11. **Build `PropertyMortgageCard` component** — If mortgage params are set: monthly payment, total interest over term, LTV ratio, DSTI ratio (if income provided), cash-on-cash return, break-even occupancy rate. Amortization sparkline.
- [x] 12. **Build `PropertySourceLinks` component** — Shows all data sources with direct links: "Data from: reas.cz (477 sold), sreality.cz (89 rentals), bezrealitky.cz (34 rentals), MF cenova mapa". Each source is a clickable link.

### Phase C: Enhanced Add/Edit Form

- [x] 13. **Add mortgage section to AddPropertyForm** — Collapsible "Hypotéka" section with: interest rate (%), term (years), down payment / LTV. Auto-computes monthly payment and cash flow preview.
- [x] 14. **Add auto-rent estimation** — When district + disposition + area are filled, make an API call to get median rent for that combination. Pre-fill the rent field with "Estimated: X Kč" that user can accept or override.
- [x] 15. **Add "Import from URL" feature** — Text input accepting listing URL (sreality, bezrealitky, reas). Parse URL to extract source and listing ID, fetch listing details, auto-fill form fields.
- [x] 16. **Add providers selection** — Checkboxes for which data providers to use in analysis (reas, sreality, bezrealitky, ereality, mf). Matches `SavePropertyInput.providers` field that exists but is never exposed.
- [x] 17. **Add timeframe selection** — Select analysis period (6mo, 12mo, 24mo). Matches `SavePropertyInput.periods` field that exists but is never exposed.

### Phase D: Watchlist Page Layout

- [x] 18. **Add summary stats row at top** — Total properties, average yield, best performer, worst performer, total portfolio value, weighted average grade.
- [ ] 19. **Add sort/filter controls** — Sort watchlist by: grade, yield, percentile, last updated, name. Filter by: district, grade range, yield range.
- [ ] 20. **Add "Refresh All" bulk action** — Button to re-analyze all watchlist properties in sequence with progress indicator.
- [x] 21. **Add comparison action** — Select 2-4 watchlist properties and navigate to comparison view with them pre-loaded.
- [ ] 22. **Add notification thresholds** — Per-property alert settings: "Alert me if yield drops below X%" or "Alert if grade changes". Stored in saved_properties table.

## Verification Criteria

- Each property card shows 6+ metrics with color-coded quality indicators
- Expanding a card reveals full analysis sections (verdict, yield, mortgage, sources)
- Sparklines show metric trends over time (requires 2+ refresh cycles)
- Mortgage calculation works and affects cash flow / yield display
- Source links are clickable and open correct URLs
- Auto-rent estimation pre-fills form based on district/disposition
- Refresh stores analysis history for trend tracking
- Sort and filter controls work on watchlist

## Potential Risks and Mitigations

1. **Property analysis history grows unbounded**
   Mitigation: Limit to last 100 analysis records per property. Auto-prune on insert.

2. **Expanded card with full analysis may be slow to render**
   Mitigation: Lazy-load expanded content on click. Keep collapsed cards lightweight.

3. **Mortgage calculation complexity (PMT formula, amortization)**
   Mitigation: Standard PMT formula is ~10 lines of code. No external dependency needed.

4. **URL import requires parsing multiple listing site formats**
   Mitigation: Start with sreality (most structured URL format: `/detail/{hash_id}`). Add bezrealitky and reas formats incrementally.

## Alternative Approaches

1. **Separate detail page per property instead of expandable cards**: More space but loses the quick-browse capability. Cards with expansion is the better pattern for a watchlist.
2. **Portfolio-level analytics as a separate page**: Could split portfolio stats into `/portfolio` route. For now, embedding summary stats in watchlist header is sufficient.
