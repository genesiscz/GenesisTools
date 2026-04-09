# Design: `tools internal reas` — Real Estate Investment Analyzer

**Date:** 2026-03-15
**Branch:** `feat/reas`
**Purpose:** Analyze sold real estate data from reas.cz + rental data from sreality.cz to decide whether to buy a specific property as an investment.

## Context

Sister offers a 3+1 panel flat in Hradec Králové (72m², full reconstruction 2020, floor 9/13) for 7M CZK. Need data-driven analysis: is it a good investment at ~97k CZK/m²?

## Architecture

```
src/internal/
  index.ts                          ← "tools internal" — routes to subcommands via Commander
  commands/
    reas/
      index.ts                      ← "tools internal reas" — interactive wizard + CLI flags
      api/
        reas-client.ts              ← reas.cz catalog API (sold data)
        sreality-client.ts          ← sreality.cz API (rental listings)
        mf-rental.ts                ← MF cenová mapa XLSX parser (govt rental benchmarks)
      analysis/
        comparables.ts              ← price/m² stats: median, mean, P25/P75, percentile rank
        trends.ts                   ← quarterly price trends with QoQ change
        rental-yield.ts             ← gross/net yield, payback period, ROI comparison
        time-on-market.ts           ← days listed before sold (firstVisibleAt → soldAt)
        discount.ts                 ← originalPrice → soldPrice discount analysis
        report.ts                   ← combines all analyses, renders terminal report
      cache/
        index.ts                    ← fetch + cache layer (~/.genesis-tools/internal/reas/)
      types.ts                      ← all types
  vendor/
    sreality-client/                ← reference source from mecv01/sreality-client (already downloaded)
```

## Data Sources

### 1. reas.cz Catalog API (Sold Properties — PRIMARY)

- **Base URL:** `https://catalog.reas.cz/catalog`
- **Endpoints:**
  - `GET /listings/count` — count with filters
  - `GET /listings` — paginated listing data
  - `GET /listings/pointers-and-clusters` — map data (not needed)
- **Auth:** None (public, uses `clientId=6988cb437c5b9d2963280369`)
- **Key filters:** `estateTypes`, `constructionType`, `heatingKind`, `soldDateRange`, `locality.districtId`, `bounds`, `linkedToTransfer=true`
- **Pagination:** `page`/`limit` params, API returns `nextPage`
- **Response fields per listing:**
  - `soldPrice`, `price` (listing), `originalPrice`, `histogramPrice`
  - `disposition`, `floorArea`, `utilityArea`, `displayArea`
  - `soldAt`, `firstVisibleAt`
  - `formattedAddress`, `formattedLocation`
  - `point.coordinates` (GPS)
  - `cadastralAreaSlug`, `municipalitySlug`
- **reas.cz districtId for HK:** `3602`

### 2. sreality.cz API (Rental Listings)

- **Base URL:** `https://www.sreality.cz/api/cs/v2`
- **Endpoints:**
  - `GET /estates` — paginated rental listings
  - `GET /suggest?phrase=...` — location search/autocomplete
  - `GET /estates/count` — count with filters
- **Auth:** None
- **Key params:**
  - `category_main_cb=1` (flats)
  - `category_type_cb=2` (rental)
  - `locality_district_id=28` (okres HK) or `locality_region_id=6`
  - `building_type_search=1` (panel), `=2` (brick)
  - `category_sub_cb` for disposition (4=2+kk, 5=2+1, 6=3+kk, 7=3+1)
  - `per_page`, `page` for pagination
- **Response per listing:** `name` (includes disposition + m²), `price`, `locality`, `gps`, `labels` (building type, features)
- **Note:** Area must be parsed from `name` string (e.g. "Pronájem bytu 3+1 68 m²")
- **HK data:** 147 listings in okres HK (district_id=28)

### 3. MF cenová mapa XLSX (Government Rental Benchmarks)

- **URL pattern:** `https://mf.gov.cz/assets/attachments/YYYY-MM-15_Cenova-mapa.xlsx`
- **Latest:** `2026-02-15_Cenova-mapa.xlsx`
- **Content:** Per-cadastral-district rental data for all Czech municipalities
- **Size categories:** VK1 (studio/1+kk), VK2 (2-room), VK3 (3-room), VK4 (4+room)
- **Fields per row:** reference price CZK/m², 95% confidence interval, new-build price, median, data coverage score
- **HK 3-room data:** 223 CZK/m² reference, median 200, new-build 281
- **Parse with:** XLSX library (e.g. `xlsx` npm package or SheetJS)

### 4. realitymix.cz (Monthly Trend Cross-Check)

- **URL:** `https://realitymix.cz/statistika-nemovitosti/byty-pronajem-prumerna-cena-pronajmu-1m2-mesic.html`
- **Format:** HTML table — scrape with fetch + regex/cheerio
- **Content:** Monthly avg CZK/m² for 13 cities. HK: 302 CZK/m² (03/2026)
- **Use:** Cross-check rental estimates, show monthly trend chart

## Interactive Flow (Clack prompts)

```
$ tools internal reas

┌  REAS Investment Analyzer
│
◆  Select district
│  ○ Hradec Králové (saved)
│  ○ Search...
│
◆  Property type?
│  ● Flat - Panel
│  ○ Flat - Brick
│  ○ House
│
◆  Disposition?
│  ● 3+1
│  ○ 3+kk
│  ○ 2+1
│  ○ All
│
◆  Analyze periods? (multi-select)
│  ☑ 2025 (full year)
│  ☑ 2024 (full year)
│  ☐ Last 6 months
│  ☐ Custom range...
│
◆  Your target property:
│  Price:         7,000,000 CZK
│  Area:          72 m²
│  Monthly rent:  20,000 CZK
│  Monthly costs: 6,000 CZK
│
◇  Fetching sold data from reas.cz... (32 listings)
◇  Fetching rental data from sreality.cz... (147 listings)
◇  Loading MF rental benchmarks...
│
└  Report ready.
```

## CLI Flags (non-interactive / re-run)

```
tools internal reas \
  --district "Hradec Králové" \
  --type panel \
  --disposition 3+1 \
  --periods 2024,2025 \
  --price 7000000 \
  --area 72 \
  --rent 20000 \
  --monthly-costs 6000 \
  --output report.md \
  --refresh
```

## Report Structure

The report includes both **detailed listings** and **aggregate analysis**.

### Section 1: Sold Comparables (Detailed)

```
══════════════════════════════════════════════════════════════════
  SOLD COMPARABLES — 3+1 Panel, Hradec Králové, 2025 (N=32)
══════════════════════════════════════════════════════════════════

  #   Address                              m²   Sold Price    CZK/m²   Listed→Sold   Discount
  1   Brožíkova 610, Nový HK              72   3,200,000     44,444   45 days       -5.2%
  2   Třída SNP 1422, Slezské P.          68   2,950,000     43,382   32 days       -3.1%
  3   Labská 1205, Slezské P.             75   3,500,000     46,667   60 days       -8.0%
  ...

  Stats:
    Median:    44,000 CZK/m²
    Mean:      45,200 CZK/m²
    P25-P75:   42,000 - 48,000 CZK/m²
    Min/Max:   38,000 - 55,000 CZK/m²

  ► YOUR PRICE: 97,222 CZK/m² — P99 (above 99% of comparables)
```

### Section 2: Current Rental Listings (Detailed)

```
══════════════════════════════════════════════════════════════════
  RENTAL LISTINGS — Flats, Hradec Králové (N=147, showing relevant)
══════════════════════════════════════════════════════════════════

  #   Address                              m²   Disp  Rent/mo    CZK/m²   Type
  1   K Sokolovně, Pouchov                68   3+1   18,500     272      Panel
  2   Gočárova třída, Pražské P.          57   2+kk  15,000     263      Brick
  3   Kollárova, Pražské P.               56   2+kk  17,500     313      Brick
  ...

  Rental stats (3+1 panel, HK):
    Sreality avg:    18,500 CZK/month (272 CZK/m²)
    MF official:     16,056 CZK/month (223 CZK/m²)
    realitymix:      21,744 CZK/month (302 CZK/m²)
    Your estimate:   20,000 CZK/month (278 CZK/m²)
```

### Section 3: Price Trend

```
══════════════════════════════════════════════════════════════════
  PRICE TREND — 3+1 Panel, Hradec Králové
══════════════════════════════════════════════════════════════════

  Period     Median CZK/m²   Change     N
  Q1 2024    38,000          —          8
  Q2 2024    40,500          +6.6%      10
  Q3 2024    41,200          +1.7%      7
  Q4 2024    42,000          +1.9%      9
  Q1 2025    44,000          +4.8%      12
  ...

  YoY trend: +15.8% (2024→2025)
  Direction: ▲ Rising
```

### Section 4: Time on Market

```
══════════════════════════════════════════════════════════════════
  TIME ON MARKET
══════════════════════════════════════════════════════════════════

  Median days to sell:  42
  Mean:                 51
  Fastest:              7 days
  Slowest:              120 days

  Interpretation: Moderate demand — properties move in ~6 weeks
```

### Section 5: Discount Analysis

```
══════════════════════════════════════════════════════════════════
  LISTING → SOLD PRICE DISCOUNT
══════════════════════════════════════════════════════════════════

  Avg discount:     -4.2%
  Median discount:  -3.5%
  Max discount:     -15.0%
  No discount:      8 of 32 (25%)

  Negotiation potential: If 7M is listing price, expect ~6.7M final
```

### Section 6: Investment Yield

```
══════════════════════════════════════════════════════════════════
  INVESTMENT ANALYSIS — 7,000,000 CZK target
══════════════════════════════════════════════════════════════════

  Monthly rent:          20,000 CZK
  Monthly costs:         -6,000 CZK (fond oprav + teplo + voda)
  Net monthly income:    14,000 CZK

  Gross yield:           3.43% (240,000 / 7,000,000)
  Net yield:             2.40% (168,000 / 7,000,000)
  Payback period:        41.7 years

  Comparison:
    Czech govt bonds:    ~4.2%
    S&P 500 avg:         ~10%
    Prague avg yield:    ~3.5%
    HK panel avg yield:  ~4.8% (at market price)

  ► AT MARKET PRICE (~3.2M): Net yield = 5.25%, payback = 19 years
```

### Section 7: Verdict

```
══════════════════════════════════════════════════════════════════
  VERDICT
══════════════════════════════════════════════════════════════════

  Market value estimate: ~3,200,000 CZK (median × area)
  Asked price:           7,000,000 CZK
  Premium:               +118% above market

  ⚠ The asking price is significantly above comparable sold prices.
  At 7M CZK, the net yield (2.4%) underperforms govt bonds (4.2%).
  At market price (~3.2M), the investment would yield 5.25% net.

  Recommendation: Negotiate substantially or pass.
```

## Cache Strategy

- **Location:** `~/.genesis-tools/internal/reas/`
- **Cache key:** SHA256 hash of normalized filter params
- **Files:** `{hash}.json` with metadata header (fetchedAt, params, count)
- **TTL:** 24h for reas.cz (sold data), 6h for sreality.cz (rental), 7d for MF XLSX
- **`--refresh` flag:** Force re-fetch regardless of TTL

## Types

```typescript
interface ReasListing {
    _id: string;
    formattedAddress: string;
    formattedLocation: string;
    soldPrice: number;
    price: number;           // listing price
    originalPrice: number;
    disposition: string;     // "3+1", "2+kk", etc.
    floorArea: number;
    displayArea: number;
    soldAt: string;          // ISO date
    firstVisibleAt: string;  // ISO date
    point: { type: string; coordinates: [number, number] };
    cadastralAreaSlug: string;
    municipalitySlug: string;
}

interface SrealityRental {
    hash_id: number;
    name: string;            // "Pronájem bytu 3+1 68 m²"
    price: number;           // monthly rent CZK
    locality: string;
    gps: { lat: number; lon: number };
    labels: string[];        // ["Balkon", "Panelová", ...]
    // parsed from name:
    disposition?: string;
    area?: number;
}

interface MfRentalBenchmark {
    cadastralUnit: string;
    municipality: string;
    sizeCategory: "VK1" | "VK2" | "VK3" | "VK4";
    referencePrice: number;  // CZK/m²/month
    confidenceMin: number;
    confidenceMax: number;
    median: number;
    newBuildPrice: number;
    coverageScore: number;
}

interface TargetProperty {
    price: number;           // asking price CZK
    area: number;            // m²
    disposition: string;
    constructionType: string;
    monthlyRent: number;     // estimated or known
    monthlyCosts: number;    // fond oprav + teplo + voda
    district: string;
    districtId: number;      // reas districtId
    srealityDistrictId: number; // sreality district_id
}

interface AnalysisFilters {
    estateType: string;
    constructionType: string;
    disposition?: string;
    periods: DateRange[];
    district: { name: string; reasId: number; srealityId: number };
}
```

## Dependencies

- `@clack/prompts` — interactive wizard (already in project)
- `commander` — CLI flags (already in project)
- `chalk` / `picocolors` — terminal styling (already in project)
- `xlsx` or `sheetjs` — parse MF XLSX (new dependency, `bun add xlsx`)
- No new external API dependencies — all sources are public/unauthenticated
