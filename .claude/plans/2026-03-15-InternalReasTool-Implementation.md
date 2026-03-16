# `tools internal reas` Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an interactive CLI tool that fetches sold property data from reas.cz and rental data from sreality.cz to analyze whether a specific property purchase is a good investment.

**Architecture:** Commander-based tool under `src/internal/` namespace with `commands/reas/` subcommand. Three API clients (reas.cz, sreality.cz, MF XLSX) feed into analysis modules that produce a detailed terminal report with individual listings and aggregate stats.

**Tech Stack:** Bun, Commander, @clack/prompts, picocolors, xlsx (SheetJS)

**Design doc:** `.claude/plans/2026-03-15-InternalReasTool.md`

---

### Task 1: Scaffold `tools internal` Entry Point

**Files:**
- Create: `src/internal/index.ts`

**Step 1: Create the internal tool entry point**

```typescript
#!/usr/bin/env bun

import { Command } from "commander";

const program = new Command();

program
    .name("internal")
    .description("Internal tools — not for public use");

// Register subcommands
const { registerReasCommand } = await import("./commands/reas/index.ts");
registerReasCommand(program);

program.parse();
```

**Step 2: Verify tool discovery works**

Run: `ls src/internal/index.ts`
Expected: File exists, `tools internal --help` shows the reas subcommand (after Task 2).

**Step 3: Commit**

```bash
git add src/internal/index.ts
git commit -m "feat(internal): scaffold tools internal entry point"
```

---

### Task 2: Types + Reas Command Skeleton

**Files:**
- Create: `src/internal/commands/reas/types.ts`
- Create: `src/internal/commands/reas/index.ts`

**Step 1: Create types**

All types from the design doc — `ReasListing`, `SrealityRental`, `MfRentalBenchmark`, `TargetProperty`, `AnalysisFilters`, `DateRange`, `CacheEntry`. See design doc `types.ts` section for exact shapes. Additionally:

```typescript
export interface DateRange {
    label: string;        // "2025", "Q1 2024", "Last 6 months"
    from: Date;
    to: Date;
}

export interface CacheEntry<T> {
    fetchedAt: string;
    params: Record<string, unknown>;
    count: number;
    data: T[];
}

export interface AnalysisResult {
    soldComparables: ReasListing[];
    rentalListings: SrealityRental[];
    mfBenchmarks: MfRentalBenchmark[];
    target: TargetProperty;
    filters: AnalysisFilters;
}
```

**Step 2: Create command skeleton with Commander flags**

Register a `reas` subcommand on the parent `internal` program. Define all CLI options from the design: `--district`, `--type`, `--disposition`, `--periods`, `--price`, `--area`, `--rent`, `--monthly-costs`, `--output`, `--refresh`. Action handler calls `runReasAnalysis(options)` which is a stub for now (just logs "not implemented").

**Step 3: Verify**

Run: `tools internal reas --help`
Expected: Shows all options with descriptions.

**Step 4: Commit**

```bash
git add src/internal/commands/reas/
git commit -m "feat(internal/reas): types and command skeleton with CLI flags"
```

---

### Task 3: Cache Layer

**Files:**
- Create: `src/internal/commands/reas/cache/index.ts`

**Step 1: Implement cache**

Use `~/.genesis-tools/internal/reas/` as cache dir (create with `import { Storage } from "@app/utils/storage/storage"` pattern or raw `fs`).

Functions needed:
- `getCached<T>(key: string, ttlMs: number): Promise<CacheEntry<T> | null>` — returns null if expired/missing
- `setCache<T>(key: string, entry: CacheEntry<T>): Promise<void>` — write JSON file
- `cacheKey(params: Record<string, unknown>): string` — SHA256 hash of JSON-sorted params
- `clearCache(): Promise<void>` — delete all cache files

Cache key = SHA256 of `JSON.stringify(sortedParams)`. Files stored as `{hash}.json`.

TTL constants: `REAS_TTL = 24 * 60 * 60 * 1000` (24h), `SREALITY_TTL = 6 * 60 * 60 * 1000` (6h), `MF_TTL = 7 * 24 * 60 * 60 * 1000` (7d).

**Step 2: Verify**

Quick smoke test — call `setCache` then `getCached` in a temp script. Verify file appears in `~/.genesis-tools/internal/reas/`.

**Step 3: Commit**

```bash
git add src/internal/commands/reas/cache/
git commit -m "feat(internal/reas): cache layer with TTL and hash-based keys"
```

---

### Task 4: Reas.cz API Client (Sold Data)

**Files:**
- Create: `src/internal/commands/reas/api/reas-client.ts`

**Step 1: Implement the client**

Functions:
- `fetchSoldCount(filters: AnalysisFilters, dateRange: DateRange): Promise<number>` — calls `GET /catalog/listings/count`
- `fetchSoldListings(filters: AnalysisFilters, dateRange: DateRange): Promise<ReasListing[]>` — calls `GET /catalog/listings` with auto-pagination (follow `nextPage` until no more pages)

Build query params from filters exactly as seen in the HAR:
```
estateTypes=["flat"]
constructionType=["panel"]  (or "brick")
soldDateRange={"from":"2024-12-31T23:00:00.000Z","to":"2026-01-01T22:59:59.999Z"}
linkedToTransfer=true
locality={"districtId":3602}
clientId=6988cb437c5b9d2963280369
```

Use `fetch()` directly (Bun native). Base URL: `https://catalog.reas.cz/catalog`.

Integrate with cache: check cache first, fetch if miss/expired, store result.

**Step 2: Verify with real API**

Run a quick test: fetch count for HK panel flats 2025. Expected: ~32 (based on HAR data).
Then fetch first page of listings. Verify response parses into `ReasListing[]`.

**Step 3: Commit**

```bash
git add src/internal/commands/reas/api/reas-client.ts
git commit -m "feat(internal/reas): reas.cz API client with pagination and caching"
```

---

### Task 5: Sreality.cz API Client (Rental Data)

**Files:**
- Create: `src/internal/commands/reas/api/sreality-client.ts`

**Step 1: Implement the client**

Functions:
- `fetchRentalListings(filters: AnalysisFilters): Promise<SrealityRental[]>` — calls `GET /api/cs/v2/estates` with rental params, auto-paginates
- `suggestLocality(phrase: string): Promise<SuggestResult[]>` — calls `GET /api/cs/v2/suggest`
- `parseSrealityName(name: string): { disposition?: string; area?: number }` — regex to extract from "Pronájem bytu 3+1 68 m²"

Key params mapping from `AnalysisFilters`:
```
category_main_cb=1  (flats)
category_type_cb=2  (rental)
locality_district_id=28  (from filters.district.srealityId)
building_type_search=1  (panel) or 2 (brick)
category_sub_cb=7  (3+1) — map disposition to sreality sub_cb codes
per_page=60
page=N
```

Disposition mapping: `{ "1+kk": 2, "1+1": 3, "2+kk": 4, "2+1": 5, "3+kk": 6, "3+1": 7, "4+kk": 8, "4+1": 9, "5+kk": 10, "5+1": 11 }`

For each raw listing, parse `name` to extract disposition and area, then map to `SrealityRental`.

Integrate with cache (6h TTL).

**Step 2: Verify with real API**

Fetch rental listings for HK district. Expected: ~147 results. Verify name parsing works.

**Step 3: Commit**

```bash
git add src/internal/commands/reas/api/sreality-client.ts
git commit -m "feat(internal/reas): sreality.cz rental API client with name parsing"
```

---

### Task 6: MF Cenová Mapa XLSX Parser

**Files:**
- Create: `src/internal/commands/reas/api/mf-rental.ts`

**Step 1: Install xlsx dependency**

Run: `bun add xlsx`

**Step 2: Implement the parser**

Functions:
- `fetchMfRentalData(municipality: string): Promise<MfRentalBenchmark[]>` — downloads latest XLSX, parses, filters to municipality
- `getLatestMfUrl(): string` — compute URL based on current quarter: `https://mf.gov.cz/assets/attachments/YYYY-MM-15_Cenova-mapa.xlsx` (Feb, May, Aug, Nov)

XLSX parsing: use `xlsx.read()` on the downloaded buffer. The sheet contains rows with municipality name, cadastral unit, and VK1-VK4 columns. Filter rows matching the target municipality. Parse numeric columns for reference price, confidence interval, median, new-build price.

Cache the downloaded XLSX (7d TTL) — store the raw buffer, parse on read.

**Step 3: Verify**

Download and parse. Find rows for "Hradec Králové". Verify VK3 reference price ≈ 223.

**Step 4: Commit**

```bash
git add src/internal/commands/reas/api/mf-rental.ts
git commit -m "feat(internal/reas): MF cenová mapa XLSX parser for rental benchmarks"
```

---

### Task 7: Analysis Modules

**Files:**
- Create: `src/internal/commands/reas/analysis/comparables.ts`
- Create: `src/internal/commands/reas/analysis/trends.ts`
- Create: `src/internal/commands/reas/analysis/rental-yield.ts`
- Create: `src/internal/commands/reas/analysis/time-on-market.ts`
- Create: `src/internal/commands/reas/analysis/discount.ts`

**Step 1: Implement comparables analysis**

`analyzeComparables(listings: ReasListing[], target: TargetProperty)` → returns:
- `pricePerM2` stats: median, mean, p25, p75, min, max (computed from `soldPrice / floorArea`)
- `targetPercentile`: where the target's CZK/m² falls in the distribution
- `listings` sorted by `soldPrice / floorArea` ascending

Use simple array math — sort values, compute percentiles via index.

**Step 2: Implement trends analysis**

`analyzeTrends(listings: ReasListing[], periods: DateRange[])` → returns:
- Per-period: median CZK/m², count, QoQ change %
- Group listings by quarter (from `soldAt` date), compute median per quarter

**Step 3: Implement rental yield**

`analyzeRentalYield(target: TargetProperty, rentalStats: { srealityAvg: number; mfOfficial: number })` → returns:
- Gross yield: `(monthlyRent * 12) / price * 100`
- Net yield: `((monthlyRent - monthlyCosts) * 12) / price * 100`
- Payback years: `price / ((monthlyRent - monthlyCosts) * 12)`
- At-market-price variant: same calcs with `median * area` as price
- Comparison benchmarks (hardcoded: Czech govt bonds ~4.2%, S&P avg ~10%)

**Step 4: Implement time-on-market**

`analyzeTimeOnMarket(listings: ReasListing[])` → returns:
- Days listed = `(new Date(soldAt) - new Date(firstVisibleAt)) / 86400000`
- Median, mean, min, max days
- Filter out negative/zero values (data quality)

**Step 5: Implement discount analysis**

`analyzeDiscount(listings: ReasListing[])` → returns:
- Per listing: `(soldPrice - originalPrice) / originalPrice * 100`
- Skip listings where `originalPrice === 0` or `originalPrice === soldPrice`
- Stats: avg, median, max discount, count with no discount

**Step 6: Commit**

```bash
git add src/internal/commands/reas/analysis/
git commit -m "feat(internal/reas): analysis modules — comparables, trends, yield, time-on-market, discount"
```

---

### Task 8: Report Renderer

**Files:**
- Create: `src/internal/commands/reas/analysis/report.ts`

**Step 1: Implement the report**

`renderReport(result: AnalysisResult)` — prints the full terminal report as described in the design doc.

7 sections:
1. **Sold Comparables** — detailed table of all listings + aggregate stats + target percentile
2. **Rental Listings** — detailed table of relevant rentals + multi-source rental stats
3. **Price Trend** — quarterly table with QoQ change
4. **Time on Market** — stats
5. **Discount Analysis** — stats + negotiation hint
6. **Investment Yield** — gross/net yield, payback, comparisons, at-market-price variant
7. **Verdict** — market value estimate, premium %, recommendation

Use `picocolors` for styling. Use `src/utils/table.ts` if it exists for table formatting, otherwise manual padding with `String.padEnd()`.

Also support `--output <path>` — write plain-text (no ANSI) version to file.

**Step 2: Verify**

Create mock data matching the design doc's example numbers. Call `renderReport()`. Visually verify output matches the design.

**Step 3: Commit**

```bash
git add src/internal/commands/reas/analysis/report.ts
git commit -m "feat(internal/reas): terminal report renderer with 7 analysis sections"
```

---

### Task 9: Interactive Wizard

**Files:**
- Modify: `src/internal/commands/reas/index.ts`

**Step 1: Implement the interactive flow**

When no CLI flags are provided (or insufficient), launch the Clack wizard:

1. **District selection** — `p.select` with hardcoded options + "Search..." option that calls sreality suggest API
2. **Property type** — `p.select`: Flat-Panel, Flat-Brick, House
3. **Disposition** — `p.select`: 3+1, 3+kk, 2+1, All, etc.
4. **Periods** — `p.multiselect`: 2025, 2024, Last 6 months, Custom
5. **Target property** — series of `p.text` prompts: price, area, rent, costs

Then call the API clients, run analysis, render report.

When CLI flags ARE provided, skip wizard, go straight to fetch + analyze.

Wire up the spinner (`p.spinner()`) for fetch operations.

**Step 2: Verify end-to-end**

Run: `tools internal reas`
Walk through the wizard with HK panel 3+1 settings. Verify data fetches and report renders.

Then run with flags:
```bash
tools internal reas --district "Hradec Králové" --type panel --disposition 3+1 --periods 2025 --price 7000000 --area 72 --rent 20000 --monthly-costs 6000
```
Verify same output.

**Step 3: Commit**

```bash
git add src/internal/commands/reas/index.ts
git commit -m "feat(internal/reas): interactive wizard + non-interactive CLI flow"
```

---

### Task 10: Polish + Final Verification

**Files:**
- Modify: various (bug fixes, edge cases)

**Step 1: Run tsgo**

Run: `tsgo --noEmit 2>&1 | rg "internal/"`
Fix any type errors.

**Step 2: Test edge cases**

- Empty results from reas.cz (different city with no data)
- Network failure handling (timeout, 500 errors)
- Cache miss → fetch → cache hit on second run
- `--refresh` flag clears cache correctly

**Step 3: Run the full analysis for the actual use case**

```bash
tools internal reas \
  --district "Hradec Králové" \
  --type panel \
  --disposition 3+1 \
  --periods 2024,2025 \
  --price 7000000 \
  --area 72 \
  --rent 20000 \
  --monthly-costs 6000
```

Verify the report makes sense with real data.

**Step 4: Commit + push**

```bash
git add -A
git commit -m "feat(internal/reas): polish, edge cases, and type fixes"
git push -u origin feat/reas
```
