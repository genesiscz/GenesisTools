# Superplan 3: Interactive District Comparison & Prague Localities

> **MANDATORY — On Every Session Start & After Every Compaction:**
> 1. Read `CLAUDE.md` at the worktree root in full
> 2. Set cwd to `/Users/Martin/Tresors/Projects/GenesisTools/.claude/worktrees/reas` — never drift
> 3. Load skills: `frontend-design`, `shadcn` (+ `writing-plans` if planning)
> 4. If the master plan is not in context, read `plans/2026-04-02-Reas-00-MasterPlan.md` first — it contains cross-cutting architectural decisions that govern all subplans

## Objective

Transform the flat `/compare` page into an interactive Prague district comparison tool matching the "Srovnání pražských lokalit" and "Pražské lokality" tabs from the Hypoteka benchmark. The current `/compare` page at `compare.tsx:1-270` only allows selecting 2-4 districts and shows a basic metric grid. The target is a rich, user-driven, multi-chart comparison with selectable districts, customizable metrics, and location-context analysis.

## Current State

- `compare.tsx:1-270` — Select 2-4 districts, renders `ComparisonGrid` side-by-side
- `ComparisonGrid.tsx:1-275` — Shows: Median CZK/m², Net Yield, Days on Market, Median Discount, Trend direction. Tags best/worst.
- No charts in comparison view — pure metric cards
- No Prague-specific district data visualization
- No rental yield per district comparison
- All 22 Praha wards + 64 districts available in `data/districts.ts:1-362`
- District snapshots stored in `district_snapshots` table in SQLite (`lib/store.ts:143-162`)
- API route `/api/district-snapshots` exists (`api/district-snapshots.ts:1-40`) but is only used in history page

## Implementation Plan

### Phase A: Backend Enrichment

- [x] 1. **Create `/api/district-comparison` endpoint** — New server route that accepts array of district IDs and returns pre-computed comparison data for all requested districts in a single batch call. Runs parallel analysis for each district (cached). Returns: per-district median/m², yield, DOM, discount, trend, rental stats, listing count, momentum.
- [x] 2. **Add district-level rental yield aggregation** — Extend `analysis-service.ts` to compute and persist per-district rental yield estimates. Use sreality median rent / reas median sale price ratio per district.
- [ ] 3. **Add district price snapshot time-series** — Enhance `district_snapshots` to store monthly snapshots. Create endpoint to return time-series for multiple districts for overlay charting.
- [ ] 4. **Pre-seed Praha district data** — Create a background job or CLI command that fetches and caches analysis for all 22 Praha wards, building the district comparison dataset proactively instead of on-demand only.

### Phase B: shadcn Components

- [x] 5. **Add `Checkbox` component to `src/ui/`** — For multi-select district picker.
- [x] 6. **Add `Switch` component to `src/ui/`** — For toggling chart options (show/hide districts, normalize data).
- [x] 7. **Add `Slider` component to `src/ui/`** — For timeframe range selection.
- [x] 8. **Add `Popover` to `src/ui/`** — For district picker dropdown with checkbox list.

### Phase C: District Comparison Components

- [x] 9. **Build `DistrictPicker` component** — Multi-select district chooser. Shows Praha wards and major Czech districts in grouped sections. Checkboxes for each. Pre-select Praha 1-10 as default. Shows count of selected. Maximum 12 districts for meaningful comparison. Uses shadcn Command (already exists) with multi-select mode.
- [x] 10. **Build `DistrictPriceBarChart` component** — Recharts ComposedChart (vertical bars) showing average CZK/m² per selected district. Highlight user's target district. Two ReferenceLines: Prague average and user's property price/m². Color-code bars (darker for user's district). Matches `analysis-letnany.jsx:680-693`.
- [x] 11. **Build `DistrictYieldBarChart` component** — Recharts BarChart showing estimated gross rental yield per district. Highlight user's district. ReferenceLine for benchmark yield. Matches `analysis-letnany.jsx:696-707`.
- [x] 12. **Build `DistrictTrendOverlay` component** — Recharts LineChart with one line per selected district, showing median CZK/m² trend over time. User can toggle districts on/off. Timeframe selector (3mo, 6mo, 12mo, 24mo). Uses data from `district_snapshots`.
- [x] 13. **Build `DistrictRadarChart` component** — Recharts RadarChart comparing 2-4 selected districts across 6 dimensions: Price, Yield, Liquidity (DOM), Discount, Trend, Volume. Normalizes all metrics to 0-100 scale. Missing from Hypoteka but adds significant value for quick comparison.
- [x] 14. **Build `DistrictDetailTable` component** — Full DataTable with all selected districts as rows, metrics as columns. Sortable by any metric. Color-code cells (green = good, red = bad for each metric direction). Best/worst badges per column. Matches `ComparisonGrid` data but in tabular form.
- [x] 15. **Build `DistrictContextCallout` component** — Per-district contextual information box. Shows: district description, key positives, transport connections, notable developments. Matches `analysis-letnany.jsx:709-716`.

### Phase D: Page Rewrite

- [x] 16. **Rewrite `/compare` route as multi-section page** — Layout:
  - Top: DistrictPicker (sticky) with selected districts shown as badges
  - Section 1: DistrictPriceBarChart + DistrictYieldBarChart side by side
  - Section 2: DistrictDetailTable (full comparison table)
  - Section 3: DistrictTrendOverlay (time-series overlay)
  - Section 4: DistrictRadarChart (for 2-4 selected districts)
  - Section 5: DistrictContextCallout per selected district
  - Footer: Data source attribution with links
- [x] 17. **Add URL state for selected districts** — Encode selected districts in URL search params so comparisons are shareable/bookmarkable.
- [x] 18. **Add "Compare with this district" action to other pages** — From Analyze results, Watchlist cards, and Listing detail, add button to navigate to Compare with that district pre-selected.

## Verification Criteria

- User can select any combination of Praha 1-22 districts for comparison
- Bar charts show CZK/m² and yield per district with target highlighting
- Trend overlay shows time-series for selected districts with toggle
- Radar chart visualizes multi-dimensional comparison for 2-4 districts
- Full comparison table is sortable by any metric
- Context callouts provide location intelligence
- URL state preserves selections for sharing
- Smooth transitions when adding/removing districts

## Potential Risks and Mitigations

1. **Parallel analysis for 10+ districts may be slow**
   Mitigation: Aggressive caching (24h TTL), background pre-computation for Praha wards. Show loading skeletons per-district with progressive rendering.

2. **District comparison data may be incomplete for non-Praha districts**
   Mitigation: Show "insufficient data" badge for districts with fewer than 20 sales. Still display available data.

3. **Chart readability with 10+ districts**
   Mitigation: Limit bar chart to 12 districts max. Trend overlay allows toggle per district. Radar chart limited to 4.

## Alternative Approaches

1. **Map-based comparison instead of charts**: Would be visually stunning (colored Praha map) but requires map tiles/SVG map data which is significant additional complexity. Could be Phase 2.
2. **Pre-computed comparison pages instead of interactive**: Faster but rigid. Interactive approach is what the user explicitly requested.
