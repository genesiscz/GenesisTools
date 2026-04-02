# Superplan 1: Rich Analysis Dashboard — Tabbed Property Analysis

> **MANDATORY — On Every Session Start & After Every Compaction:**
> 1. Read `CLAUDE.md` at the worktree root in full
> 2. Set cwd to `/Users/Martin/Tresors/Projects/GenesisTools/.claude/worktrees/reas` — never drift
> 3. Load skills: `frontend-design`, `shadcn` (+ `writing-plans` if planning)
> 4. If the master plan is not in context, read `plans/2026-04-02-Reas-00-MasterPlan.md` first — it contains cross-cutting architectural decisions that govern all subplans

## Objective

Transform the flat `/analyze` page into a rich, multi-tabbed property analysis experience matching the depth of `analysis-letnany.jsx` and `letnany-live-dashboard.jsx`. Currently, `analyze.tsx` renders a single flat page with `ScoreCard`, `YieldCard`, `PriceTrendChart`, `MomentumCard`, and `ComparablesTable` stacked vertically. The target is 7+ tabs with deep analytics, interactive filters, and full data visibility.

## Current State

- `ui/src/routes/analyze.tsx:1-144` — flat single-page layout
- `ui/src/components/AnalysisResults.tsx:1-45` — simple composition of 5 cards
- Data available but NOT rendered: `listings.rentals`, `benchmarks.mf`, `analysis.discount`, `analysis.rentalAggregation`, `analysis.timeOnMarket` (as standalone card), `soldAt` dates, `source` field, listing links
- Backend `InvestmentScore` and `MarketMomentum` computed but NOT in `DashboardExport` (`types.ts:106-107`)
- No charting library — current charts are handrolled SVG (`PriceTrendChart.tsx`, `TrendChart.tsx`)

## Implementation Plan

### Phase A: Backend / API Export Enrichment

- [x] 1. **Extend `DashboardExport` to include `investmentScore` and `momentum`** — Add `investmentScore` (grade, score, factors[], reasoning[]) and `momentum` (direction, velocity, acceleration, interpretation) to the export type at `lib/api-export.ts:9-83`. Wire them from `FullAnalysis` in `buildDashboardExport()` at line 87.
- [x] 2. **Extend `DashboardExport` to include histogram data** — Add a `priceHistogram: Array<{range: string, count: number}>` field. Compute histogram buckets from `comparables.listings` in `buildDashboardExport()`. Also add `domDistribution` (days-on-market distribution buckets).
- [x] 3. **Wire bezrealitky + ereality into `analysis-service.ts`** — Currently only `fetchRentalListings` (sreality) is called at `lib/analysis-service.ts:84-100`. Add `fetchBezrealitkyListings` and `fetchErealityListings` to the `Promise.allSettled` call. Use `rental-aggregation.ts` to merge and deduplicate. This dramatically increases rental data volume.
- [x] 4. **Add scatter plot data to DashboardExport** — Include per-listing `{area, pricePerM2, disposition}` array for scatter chart rendering.

### Phase B: shadcn Foundation Components

- [x] 5. **Add `Tabs` component to `src/ui/`** — shadcn Tabs (Radix `@radix-ui/react-tabs`). This is the core navigation primitive for the tabbed analysis. Add to `src/utils/ui/components/tabs.tsx` and re-export from index.
- [x] 6. **Add `Select` component to `src/ui/`** — shadcn Select (Radix `@radix-ui/react-select`). Needed for disposition/location/timeframe filters on multiple tabs.
- [x] 7. **Add `Tooltip` component to `src/ui/`** — shadcn Tooltip (Radix `@radix-ui/react-tooltip`). Needed for chart hover states and metric explanations.
- [x] 8. **Add `Progress` component to `src/ui/`** — shadcn Progress. Needed for scoring progress bars in Verdict tab.
- [x] 9. **Add `Separator` component to `src/ui/`** — For visual section breaks between analysis blocks.
- [x] 10. **Install `recharts`** — Add to package.json. Replace handrolled SVG charts. All Hypoteka dashboards use Recharts (`BarChart`, `AreaChart`, `LineChart`, `ScatterChart`, `ComposedChart`, `ResponsiveContainer`).

### Phase C: Reusable Analysis Building Blocks

- [ ] 11. **Create `StatCard` component** — Reusable metric card with left color border, label/value/subtitle (matches `analysis-letnany.jsx:151-158`). Use shadcn Card with variant extension. Place at `ui/src/components/analysis/StatCard.tsx`.
- [ ] 12. **Create `SectionTitle` component** — Heading with subtitle for section breaks. Place at `ui/src/components/analysis/SectionTitle.tsx`.
- [ ] 13. **Create `DataTable` reusable component** — Generic table with configurable columns, custom renderers, row highlighting predicate, sorting support (matches `analysis-letnany.jsx:170-195`). Use shadcn Table underneath. Place at `ui/src/components/analysis/DataTable.tsx`.
- [ ] 14. **Create `Callout` component** — Color-coded alert box (green=positive, amber=warning, red=critical, blue=info). Place at `ui/src/components/analysis/Callout.tsx`. Use shadcn Alert as base.
- [ ] 15. **Create `ScoreGauge` component** — Circular conic-gradient score gauge (matches `analysis-letnany.jsx:749-754`). Place at `ui/src/components/analysis/ScoreGauge.tsx`.

### Phase D: Tab Components (7 Tabs)

- [ ] 16. **Tab 1: Přehled (Overview)** — Grid of 8 StatCards: purchase price, market median/m², target percentile, gross yield, net yield, cash flow, time-on-market, estimated market price. Green callout with positives, amber callout with key findings. Source attribution footer.
- [ ] 17. **Tab 2: Cenový rozptyl (Price Distribution)** — Recharts BarChart histogram of price-per-m² distribution with target ReferenceLine. P25/Median/P75 StatCards. Text interpretation. DOM distribution bar chart.
- [ ] 18. **Tab 3: Trend (Price Trend)** — Recharts AreaChart with gradient fill for median price/m² trend. Dashed line for target price. Volume bars overlay. YoY change badge. 4 selected-month StatCards. Timeframe selector (3mo, 6mo, 12mo, 24mo).
- [ ] 19. **Tab 4: Srovnání prodejů (Sales Comparison)** — Interactive filters (disposition dropdown, price range). Recharts ScatterChart (ppm2 vs area) with ReferenceLine. Aggregate DataTable by disposition. Detailed DataTable of all sales with dates, links to source, building type badges, row highlighting for target-comparable entries.
- [ ] 20. **Tab 5: Analýza nájmů (Rental Analysis)** — Disposition filter. StatCards per disposition median. Recharts ComposedChart (min/median/max bars per disposition + target rent ReferenceLine). Aggregate DataTable by disposition (7 columns). Detailed DataTable of all rentals with source links. Blue assessment callout. This tab uses data from ALL rental providers (sreality + bezrealitky + ereality + MF).
- [ ] 21. **Tab 6: Investice (Investment Analysis)** — 4 scenario table (KFP/Realistic/Conservative/Pessimistic) with colored cash flow. Horizontal BarChart (yield benchmarks: property vs bonds vs S&P 500 vs savings). LineChart (value growth per scenario over 30yr). AreaChart (property value / equity / mortgage decomposition). Opportunity cost callout.
- [ ] 22. **Tab 7: Verdikt (Verdict)** — ScoreGauge with total/max. DataTable with 8 scoring categories with inline progress bars. Two-column Pro/Proti grid. Dark recommendation box. Pass/fail checklist. Data source footer with links.

### Phase E: Wiring and Polish

- [x] 23. **Rewrite `AnalysisResults.tsx`** — Replace the flat layout with shadcn Tabs. Each tab lazy-renders its content. Pass full `DashboardExport` to each tab.
- [ ] 24. **Fix duplicated scoring logic** — Remove client-side `computeScore()` from `ScoreCard.tsx:49-141`. Use `data.investmentScore` from the extended DashboardExport. Single source of truth.
- [ ] 25. **Fix duplicated momentum logic** — Remove client-side `computeMomentum()` from `MomentumCard.tsx:22-81`. Use `data.momentum` from the extended DashboardExport.
- [ ] 26. **Unify GRADE_COLORS** — Extract to shared constant. Currently defined independently in `ScoreCard.tsx:17-23`, `PropertyCard.tsx:9-15`, and `HistoryTable.tsx:25-31`.
- [ ] 27. **Add Czech locale formatting utilities** — Shared `fmt()`, `fmtK()`, `fmtM()`, `pct()` functions matching `analysis-letnany.jsx:122-135`. Place at `ui/src/lib/format.ts`.

## Verification Criteria

- Analysis page shows 7 tabs with smooth tab switching
- Each tab renders at minimum 4 stat cards + 1 chart + 1 table or callout
- All data from DashboardExport is visualized — zero wasted backend data
- Rental tab shows data from 3+ providers with source attribution
- Interactive filters on Comparables and Rentals tabs update data in real-time
- Verdict tab shows scoring gauge + 8-category breakdown + pro/contra lists
- No duplicated client-side scoring or momentum logic

## Potential Risks and Mitigations

1. **Recharts bundle size increase**
   Mitigation: Tree-shake imports (import specific chart types only). Recharts is ~150KB gzipped but the Hypoteka benchmark proves the value.

2. **API response payload size increase with histogram/scatter data**
   Mitigation: Histogram bins are ~20 objects. Scatter data reuses existing listings. Total increase is negligible.

3. **Bezrealitky GraphQL / eReality provider instability or rate-limits**
   Mitigation: Treat Bezrealitky GraphQL as the canonical contract, persist its fixtures in tests, and allow graceful degradation via `Promise.allSettled`. eReality remains scrape-based and therefore lower-confidence.

## Alternative Approaches

1. **Keep handrolled SVG charts instead of Recharts**: Lower bundle size but exponentially more code for histograms, scatter plots, composed charts. Hypoteka benchmark proves Recharts is the right choice.
2. **Server-side compute all chart data instead of client-side**: Would reduce client JS but adds API complexity. Hybrid approach (backend computes aggregates, client renders) is optimal.

## API Discovery Appendendum

- [ ] **Feed the dashboard from discovered Sreality web endpoints where they are richer than the current client** — After the HAR capture in Plan 5, expose `filter_page/histogram` output directly to the price-distribution tab, `search/clusters` output to map/list density widgets, `localities/geometries` to interactive district overlays, and `_next/data` result fields to richer listing cards when they carry data not present in the current v2 adapter.
- [ ] **Expose Bezrealitky GraphQL-only fields in the dashboard UI** — Once the GraphQL path is validated, surface `publicImages`, `mortgageData`, `originalPrice`, `isDiscounted`, `links`, `dataJson`, and `AdvertDetail`-level fields such as structured charges, `availableFrom`, `deposit`, `poiData`, `regionTree`, `formattedAds`, related adverts, and `nemoreport` wherever they materially improve the Overview, Rentals, Investment, and Verdict tabs.
- [ ] **Keep source provenance visible per widget** — Every histogram, rental aggregate, and listing table added in this plan should explicitly say whether it came from REAS, Sreality v1/v2, Bezrealitky GraphQL, Bezrealitky SSR _DEPRECATED_ legacy data, eReality, or MF so the richer dashboard never becomes a black box.
