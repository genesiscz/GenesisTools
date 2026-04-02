# REAS Dashboard — Master Execution Plan

## MANDATORY — On Every Session Start & After Every Compaction

> These steps are NON-NEGOTIABLE. Execute them before ANY other work.

> DO NOT END UNTIL ALL IS FULLY FUNCTIONAL, THE PLANS tasks are marked as done and are really done. YOU WILL NOT BE LAZY AND CUTTING CORNERS.
>
> Your master is sleeping; He won't respond to any questions. All is said in the plans so read them carefully and in full.

1. **Read `CLAUDE.md`** at the worktree root in full. It contains code style rules that override defaults.
2. **Set working directory** to the worktree. ALL commands, reads, edits run from here:
   ```
   /Users/Martin/Tresors/Projects/GenesisTools/.claude/worktrees/reas
   ```
   If you drift to the main repo root, `cd` back immediately. Use `workdir` on Bash calls. Never drift.
3. **Load skills** (they are lost on compaction — reload every time):
   - `frontend-design` — Dark/cyberpunk/neon aesthetic
   - `shadcn` — Composition rules, `gap-*` not `space-*`, semantic colors
   - `writing-plans` (only if in planning mode)
4. **Load on-demand per phase:**
   - `gt:analyze-har` — Phase 1: Bezrealitky API traffic capture
   - `systematic-debugging` — When provider APIs misbehave
   - `verification-before-completion` — Before marking any phase complete

---

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the REAS dashboard from a basic analysis tool into a full property intelligence platform — with clickable listing URLs, multi-provider data (incl. Bezrealitky GraphQL), rich per-property detail pages, browseable listings, and Recharts-based visualizations.

**Architecture:** This master plan orchestrates 5 existing superplans plus new cross-cutting concerns. Each superplan is a self-contained implementation unit. The master plan defines execution order, shared prerequisites, and architectural decisions that span multiple subplans.

**Worktree:** `.claude/worktrees/reas/` on branch `feat/reas`

---

## Subplan Registry

All subplans live alongside this file in `plans/`.

| # | File | Scope |
|---|------|-------|
| 01 | `plans/2026-04-02-2026-04-02-Reas-01-RichAnalysisDashboard-v1.md` | Tabbed `/analyze` page with 7 tabs + recharts |
| 02 | `plans/2026-04-02-2026-04-02-Reas-02-ListingsBrowser-v1.md` | `/listings` pages — browse, filter, click-through |
| 03 | `plans/2026-04-02-2026-04-02-Reas-03-DistrictComparison-v1.md` | Enhanced `/compare` with charts + Praha wards |
| 04 | `plans/2026-04-02-2026-04-02-Reas-04-WatchlistIntelligence-v1.md` | Watchlist detail page, expanded cards, URLs, scoring |
| 05 | `plans/2026-04-02-2026-04-02-Reas-05-FullProviderIntegration-v1.md` | Bezrealitky GraphQL, wire all 5 providers, aggregation |
| P | `.claude/plans/2026-04-01-ReasPdfExport.md` (in main repo) | PDF export via md-to-pdf |

---

## Cross-Cutting Architectural Decisions

### 1. API Client Layer — `src/utils/api/ApiClient.ts`

**All server-side outbound HTTP calls to third-party APIs MUST go through a shared `ApiClient`** powered by **`ofetch`** (from unjs). Install: `bun add ofetch`.

`ofetch` provides native fetch with interceptors (`onRequest`, `onResponse`, `onRequestError`, `onResponseError`), auto retry, timeout, and auto JSON parse. The `ApiClient` wraps `ofetch.create()` and layers on:
- Automatic error logging via `@app/logger` (global pino instance)
- Per-provider logger context (e.g., `logger.child({ provider: "bezrealitky" })`)
- Request/response timing via `onRequest`/`onResponse` interceptors
- Retry logic via ofetch's built-in `retry` option (configurable per provider)
- Rate limiting hooks
- Response status logging (success/failure/timeout) via `onResponse`/`onResponseError`
- Error classification (network, 4xx, 5xx, parse error) via `onResponseError`

**Scope:** Backend -> third-party APIs only (reas.cz, sreality.cz, bezrealitky.cz, ereality.cz, MF cenova mapa). Does NOT apply to dashboard frontend -> own backend calls (`fetch('/api/...')`) — those are local TanStack Start routes and stay as-is.

**Refactoring approach:** The existing provider files are bags of loose functions with direct `fetch()` calls. As part of this migration, each provider client should become a **class** that receives an `ApiClient` instance (dependency injection). This gives each client structured logging, shared retry/rate-limit config, and testability.

Before (loose functions):
```typescript
// api/sreality-client.ts
export async function fetchRentalListings(filters, refresh) {
    const response = await fetch(url);  // raw fetch, no logging
}
```

After (class with ApiClient):
```typescript
// api/sreality-client.ts
export class SrealityClient {
    constructor(private api: ApiClient) {}

    async fetchRentalListings(filters: AnalysisFilters, refresh = false): Promise<SrealityRental[]> {
        const response = await this.api.get(url);  // logged, timed, retried
    }
}
```

**File convention:** Each provider client is split into two files — the class and its types. Types go in a `.types.ts` sibling so they can be imported without pulling in runtime code.

Provider clients to refactor:
- `api/ReasClient.ts` + `api/ReasClient.types.ts`
- `api/SrealityClient.ts` + `api/SrealityClient.types.ts`
- `api/BezrealitkyClient.ts` + `api/BezrealitkyClient.types.ts`
- `api/ErealityClient.ts` + `api/ErealityClient.types.ts`
- `api/MfRentalClient.ts` + `api/MfRentalClient.types.ts`

Old files (`reas-client.ts`, `sreality-client.ts`, etc.) get deleted after migration.

The `ApiClient` lives in `src/utils/api/ApiClient.ts` because it's general-purpose — any tool that makes outbound HTTP calls can use it. Provider classes stay in `api/` and import it.

### Code Style — MUST READ

**Before writing any code, read `CLAUDE.md` at the worktree root in full.** It contains mandatory code style rules. Key ones for this plan:

- **Function parameters:** 3+ params or optional params -> use an object: `fetchListings({ filters, dateRange, refresh })`. 1-2 required, obvious params -> positional is fine. This applies to all new client methods, analysis functions, and component props.
- **No one-line `if` statements** — always block form with braces.
- **Empty line before `if`** — unless preceded by a variable declaration used by the `if`.
- **No `as any`** — use proper type narrowing.
- **No obvious comments** — don't restate what code already says.
- **No file-path comments** — no `// src/path/to/file.ts` as first line.
- **`gap-*` not `space-*`** in Tailwind/JSX.
- **Concise commits** — title only, no per-file breakdown.

### 2. Recharts Shared Components — `src/utils/ui/graphs/`

All chart components use **recharts** (the exact library from the Hypoteka JSX dashboards). Shared chart primitives go in `src/utils/ui/graphs/`:

```
src/utils/ui/graphs/
  index.ts              # Re-exports of recharts + theme utilities
  chart-theme.ts        # Neon color palette, dark tooltip styles, axis config
  ChartTooltip.tsx      # Dark-themed tooltip (bg-[#1e293b], monospace, border)
  ChartContainer.tsx    # ResponsiveContainer wrapper with consistent dark styling
  colors.ts             # Named color constants matching cyberpunk theme
```

Chart components from the Hypoteka JSX to replicate:
- `BarChart` + `Bar` + `Cell` (histogram, benchmarks)
- `AreaChart` + `Area` (trends with gradient fill)
- `LineChart` + `Line` (projections, multi-series)
- `ScatterChart` + `Scatter` (price vs area)
- `ComposedChart` (combined bar + line)
- `ReferenceLine` (target price markers)
- `ResponsiveContainer` (responsive wrapper)

These are used directly from recharts — the shared layer provides theming/styling only, NOT wrapper abstractions.

### 3. Bezrealitky — `regionOsmIds` via Autocomplete API

**Do NOT use GPS boundary polygons.** Use Bezrealitky's own region resolution:

1. **Autocomplete API**: `GET https://autocomplete.bezrealitky.cz/autocomplete?q={districtName}&size=20&address=0&preferredCountry=cz`
   - Returns OSM region IDs (e.g., `R439840` for Praha 4)
   - Cache the mapping: district name -> OSM ID

2. **GraphQL queries** use `regionOsmIds: ["R439840"]` instead of `boundaryPoints`
   - Much cleaner, no coordinate math
   - Works for all district levels (city, okres, Praha ward)

3. **Fallback**: For sub-district searches, use `boundaryPoints` derived from Sreality geometry API. Secondary path only.

4. Store the resolved `osmId` in `districts.ts` alongside `reasId` and `srealityId`.

### 4. Property Detail — Stored Analysis

The property detail page (`/watchlist/$propertyId`) loads from stored `last_analysis_json` in SQLite. User clicks "Refresh" to re-fetch. This means:
- Fast page loads (no API calls on view)
- No provider hammering
- Analysis is a snapshot — user controls when to update
- The full `FullAnalysis` JSON is stored (can be large, ~50-200KB per property)

### 5. Comparables — Full Table with Links

Every comparable listing table shows ALL listings with clickable source links:
- REAS listings: `listing.link` -> reas.cz detail page
- Sreality listings: `buildSrealityLink()` -> sreality.cz detail page
- Bezrealitky listings: `https://www.bezrealitky.cz/nemovitosti-byty-domy/${uri}`
- Ereality listings: `listing.link` -> ereality.cz page

No truncation — show all comparables (could be 400+ rows), with virtual scrolling if needed.

---

## Execution Order

### Phase 0: Foundation (shared prerequisites)

Dependencies for ALL subplans. Do this first.

- [ ] **0.1** Create and maintain deep Playwright MCP verification from the start — do not wait until the end. After each major slice, exercise the implemented flows in the running UI, fix regressions immediately, and do a final end-to-end pass before closing the plan.
- [ ] **0.2** `bun add recharts ofetch` — install recharts + ofetch dependencies
- [ ] **0.3** Create `src/utils/api/ApiClient.ts` — wraps `ofetch.create()` with pino logging interceptors, retry, rate limiting, timing
- [ ] **0.4** Create `src/utils/ui/graphs/` — chart theme, tooltip, container, colors (re-exports recharts)
- [ ] **0.5** Add shadcn components needed across plans:
   - `Tabs` (Plan 01, 04)
   - `Select` (Plan 01, 02, 03)
   - `Tooltip` (Plan 01, 04)
   - `Progress` (Plan 01, 04)
   - `Separator` (Plan 01, 02)
   - `Pagination` (Plan 02)
   - `Sheet` (Plan 02)
   - `Popover` (Plan 02, 03)
   - `Checkbox` (Plan 03, 05)
   - `Switch` (Plan 03)
- [ ] **0.6** Migrate all provider clients to use `ApiClient` instead of raw `fetch()`
- [ ] **0.7** Schema migration: extend `saved_properties` with `listing_url`, `last_analysis_json`, and new metric columns (from Plan 04 Phase A)

### Phase 1: Provider Integration (Subplan 05)

Must come before UI work — enriches the data pipeline that everything else renders.

- [ ] **1.1** Bezrealitky: Add autocomplete API for OSM ID resolution
- [ ] **1.2** Bezrealitky: Rewrite `fetchBezrealitkyRentals()` to use GraphQL with `regionOsmIds`
- [ ] **1.3** Bezrealitky: Add `fetchBezrealitkySales()` GraphQL query
- [ ] **1.4** Wire bezrealitky + ereality into `fetchAndAnalyze()` pipeline
- [ ] **1.5** Call `aggregateRentals()` in pipeline — already implemented but never called
- [ ] **1.6** Create unified `RentalListing` interface across all providers
- [ ] **1.7** Add `BezrealitkyListing[]` to `FullAnalysis` type
- [ ] **1.8** Add source tagging to every data point (Plan 05 Phase D)

> Full task details: `plans/2026-04-02-2026-04-02-Reas-05-FullProviderIntegration-v1.md`

### Phase 2: Watchlist Intelligence (Subplan 04)

The user's primary request. Depends on Phase 1 for enriched data.

- [ ] **2.1** Schema: `property_analysis_history` table for tracking changes over time
- [ ] **2.2** Store full analysis JSON on PATCH refresh
- [ ] **2.3** Create `/api/property-detail?id=N` endpoint
- [ ] **2.4** Add `listing_url` to AddPropertyForm + "Import from URL" feature
- [ ] **2.5** Shared detail components: `StatCard`, `DataTable`, `InfoBox`, `ScoreGauge`, formatters
- [ ] **2.6** Detail page tabs: Overview, Comparables, Rentals, Investment, Verdict
- [ ] **2.7** Wire up `/watchlist/$propertyId` route
- [ ] **2.8** Enhanced PropertyCard: clickable -> detail, listing URL, provider badges
- [ ] **2.9** `ProviderLinks` component — search result URLs per provider
- [ ] **2.10** URL builder: `lib/url-builder.ts` for browseable search URLs

> Full task details: `plans/2026-04-02-2026-04-02-Reas-04-WatchlistIntelligence-v1.md`

### Phase 3: Rich Analysis Dashboard (Subplan 01)

Reuses chart components from Phase 0 and data from Phase 1.

- [ ] **3.1** Extend `DashboardExport` with score, momentum, histogram, scatter data
- [ ] **3.2** Build analysis building blocks (StatCard, SectionTitle, etc. — shared with Phase 2)
- [ ] **3.3** 7 tabs: Overview, Price Distribution, Trend, Comparables, Rentals, Investment, Verdict
- [ ] **3.4** Replace handrolled SVG charts with recharts

> Full task details: `plans/2026-04-02-2026-04-02-Reas-01-RichAnalysisDashboard-v1.md`

### Phase 4: Listings Browser (Subplan 02)

Depends on Phase 1 (all providers wired) and Phase 0 (persistence schema).

- [ ] **4.1** `listings` SQLite table + ingestion in analysis pipeline
- [ ] **4.2** `/api/listings` endpoint with filters + pagination
- [ ] **4.3** Listings page with 3 tabs: For Sale, Rentals, Sold
- [ ] **4.4** `ListingsTable`, `ListingFilters`, `ListingDetail` sheet, `SourceBadge`

> Full task details: `plans/2026-04-02-2026-04-02-Reas-02-ListingsBrowser-v1.md`

### Phase 5: District Comparison (Subplan 03)

Depends on Phase 1 (enriched district data) and Phase 0 (charts).

- [ ] **5.1** `/api/district-comparison` batch endpoint
- [ ] **5.2** District-level charts: price bar, yield bar, trend overlay, radar
- [ ] **5.3** Rewrite `/compare` as multi-section page

> Full task details: `plans/2026-04-02-2026-04-02-Reas-03-DistrictComparison-v1.md`

### Phase 6: PDF Export (Existing plan)

Polish. Depends on Phase 2-3 for rich data to export.

- [ ] **6.1** `lib/pdf-export.ts` — Markdown builder + md-to-pdf
- [ ] **6.2** `--format pdf` CLI flag
- [ ] **6.3** Dashboard PDF download button

> Full task details: `.claude/plans/2026-04-01-ReasPdfExport.md`

---

## Recommended Execution Strategy

**Subagent parallelism opportunities:**
- Phase 0.2 (ApiClient) and 0.3 (graphs/) are independent
- Phase 1.1-1.3 (Bezrealitky) is independent from 1.4-1.5 (pipeline wiring)
- Phase 2.5-2.6 (detail components) can parallel with 2.1-2.3 (backend)
- Phase 3 and 4 are largely independent of each other

**Critical path:** 0 -> 1 -> 2 -> (3 | 4 | 5 in parallel) -> 6

**Estimated complexity:**
- Phase 0: ~2h (foundation, mostly mechanical)
- Phase 1: ~4h (Bezrealitky GraphQL is the complex part)
- Phase 2: ~6h (property detail page is the largest piece)
- Phase 3: ~4h (7 tabs but reuses Phase 2 components)
- Phase 4: ~3h (listing persistence + browsing)
- Phase 5: ~3h (charts for compare page)
- Phase 6: ~1h (existing plan, straightforward)
