# REAS Real Estate Analyzer — Full Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Expand the existing REAS MVP (3 districts, 3 providers, terminal-only) into a multi-provider, multi-city, dashboard-ready real estate analysis platform with investment scoring, address resolution, and JSON export.

**Architecture:** Provider-registry pattern where each data source (REAS, Sreality, eReality, Bezrealitky, MF) implements a common interface. A master district database replaces hardcoded maps. Analysis modules consume unified listing types. JSON export enables a React dashboard served via Bun.serve().

**Tech Stack:** Bun runtime, Commander CLI, @clack/prompts wizard, picocolors terminal output, xlsx parsing, SHA256 file cache, Bun.serve() for dashboard API.

---

## Existing Codebase Reference

All files live under `src/Internal/commands/reas/`:

| File | Lines | Key Exports |
|---|---|---|
| `index.ts` | 459 | `registerReasCommand()` — CLI wizard + orchestrator |
| `types.ts` | 82 | 8 interfaces: `ReasListing`, `SrealityRental`, `MfRentalBenchmark`, `TargetProperty`, `AnalysisFilters`, `DateRange`, `CacheEntry<T>`, `AnalysisResult` |
| `api/reas-client.ts` | 148 | `fetchSoldListings()`, `fetchSoldCount()` — catalog.reas.cz paginated API |
| `api/sreality-client.ts` | 239 | `fetchRentalListings()`, `parseSrealityName()`, `suggestLocality()` — sreality.cz API |
| `api/mf-rental.ts` | 203 | `fetchMfRentalData()`, `getLatestMfUrl()` — MF government XLSX |
| `cache/index.ts` | 67 | `cacheKey()`, `getCached()`, `setCache()`, `clearCache()` — SHA256 file cache |
| `analysis/comparables.ts` | 104 | `analyzeComparables()`, `median()`, `percentile()` |
| `analysis/trends.ts` | 121 | `analyzeTrends()` — quarterly grouping, YoY, direction |
| `analysis/rental-yield.ts` | 58 | `analyzeRentalYield()` — gross/net yield, payback |
| `analysis/time-on-market.ts` | 34 | `analyzeTimeOnMarket()` — days to sell stats |
| `analysis/discount.ts` | 45 | `analyzeDiscount()` — listing-to-sold discount |
| `analysis/report.ts` | 416 | `renderReport()` — 7-section ANSI terminal report |

### Known Bugs
- `index.ts:41` — Brno `reasId: 3602` is **wrong** (duplicate of Hradec Králové)
- Only 3 districts hardcoded (HK, Praha, Brno)
- Praha uses city-level ID (`3100`) — no Praha 1-22 breakdown
- `--search` is REAS-only, no cross-provider search

### API Endpoints (already implemented)

| Provider | Endpoint | Params | Response |
|---|---|---|---|
| REAS | `catalog.reas.cz/catalog/listings` | `estateTypes`, `constructionType`, `soldDateRange`, `locality.districtId`, `clientId`, `page`, `limit` | `{ data: ReasListing[], nextPage }` |
| REAS | `catalog.reas.cz/catalog/listings/count` | same minus pagination | `{ data: { count } }` |
| Sreality | `sreality.cz/api/cs/v2/estates` | `category_main_cb=1`, `category_type_cb=2`, `locality_district_id`, `per_page=60`, `page` | `{ _embedded: { estates }, result_size }` |
| Sreality | `sreality.cz/api/cs/v2/suggest` | `phrase`, `tms` | `{ data: [{ userData: { entityType, municipality_id, district_id } }] }` |
| MF | `mf.gov.cz/assets/attachments/{date}_Cenova-mapa.xlsx` | none (direct download) | XLSX with VK1-VK4 rental benchmarks |

### Data Source Provenance (from artifact session)

These are the actual sources that produced the dashboard data:

| Source | Endpoint | Data Produced | Status in Tool |
|---|---|---|---|
| REAS catalog API | `catalog.reas.cz/catalog/listings?locality.districtId=3100` | 17 sold properties in Praha 9 | ✅ Implemented |
| Sreality rentals API | `sreality.cz/api/cs/v2/estates?category_type_cb=2` | 4 rental listings in Letňany | ✅ Implemented |
| eReality HTML scrape | `ereality.cz/pronajem/byty/praha_9/Letňany` | 20 rental listings (bigger sample) | ❌ Not implemented |
| Vencovský web scrape | `realityvencovsky.cz/prumerne-ceny-nemovitosti-v-praze-podle-lokalit/` | Praha 1-10 avg CZK/m² benchmarks | ❌ Not implemented |
| WebSearch (Bezrealitky/Sreality/Financia) | Various listing detail pages | 7 specific sales on Miroslava Hajna street | ❌ Not stable API |
| MF cenová mapa | `mf.gov.cz/.../Cenova-mapa.xlsx` | Government rental benchmarks | ✅ Implemented (not used in artifact) |
| Training knowledge | n/a | S&P 500 10%, Czech bonds 4.2%, Prague avg yield 3.5% | ✅ Hardcoded in rental-yield.ts |

---

## Phase 1: Consolidation & District Database

**Goal:** Fix bugs, create comprehensive district mapping, extract hardcoded data, add unit tests.

---

### Task 1: Fix Brno District ID

**Files:**
- Modify: `src/Internal/commands/reas/index.ts:38-42`
- Test: `src/Internal/commands/reas/__tests__/districts.test.ts`

**Step 1: Research correct Brno REAS district ID**

Call the REAS count endpoint with candidate IDs to find which one returns Brno data:

```bash
# Test current (wrong) ID 3602
curl -s "https://catalog.reas.cz/catalog/listings/count?estateTypes=%5B%22flat%22%5D&constructionType=%5B%22brick%22%5D&soldDateRange=%7B%22from%22%3A%222024-01-01T00%3A00%3A00.000Z%22%2C%22to%22%3A%222024-12-31T23%3A59%3A59.999Z%22%7D&linkedToTransfer=true&locality=%7B%22districtId%22%3A3602%7D&clientId=6988cb437c5b9d2963280369" | tools json

# Try common Brno IDs: 3200, 3201, 3202 (Brno-město, Brno-venkov patterns)
for id in 3200 3201 3202 3203 3204 3205 3206 3700 3702; do
  count=$(curl -s "https://catalog.reas.cz/catalog/listings/count?estateTypes=%5B%22flat%22%5D&constructionType=%5B%22brick%22%5D&soldDateRange=%7B%22from%22%3A%222024-01-01T00%3A00%3A00.000Z%22%2C%22to%22%3A%222024-12-31T23%3A59%3A59.999Z%22%7D&linkedToTransfer=true&locality=%7B%22districtId%22%3A${id}%7D&clientId=6988cb437c5b9d2963280369" | jq -r '.data.count // 0')
  echo "districtId=$id → count=$count"
done
```

**Step 2: Write the failing test**

```typescript
// src/Internal/commands/reas/__tests__/districts.test.ts
import { test, expect } from "bun:test";

test("Brno reasId should NOT equal Hradec Králové reasId", () => {
    // Import will be from data/districts.ts after Task 2
    // For now, test the inline map
    const DISTRICTS = {
        "Hradec Králové": { reasId: 3602 },
        "Brno": { reasId: 3602 }, // BUG: same as HK
    };

    expect(DISTRICTS["Brno"].reasId).not.toBe(DISTRICTS["Hradec Králové"].reasId);
});
```

**Step 3: Run test to verify it fails**

Run: `bun test src/Internal/commands/reas/__tests__/districts.test.ts`
Expected: FAIL — both are 3602.

**Step 4: Fix the Brno reasId in index.ts**

Replace `reasId: 3602` for Brno with the correct ID discovered in Step 1. In `index.ts:41`:

```typescript
// Before:
"Brno": { name: "Brno", reasId: 3602, srealityId: 4 },
// After (example — use actual discovered ID):
"Brno": { name: "Brno", reasId: 3702, srealityId: 4 },
```

**Step 5: Update test with correct ID and run**

Run: `bun test src/Internal/commands/reas/__tests__/districts.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/Internal/commands/reas/__tests__/districts.test.ts src/Internal/commands/reas/index.ts
git commit -m "fix(reas): correct Brno district ID (was duplicating Hradec Králové)"
```

---

### Task 2: Create Master District Database

**Files:**
- Create: `src/Internal/commands/reas/data/districts.ts`
- Test: `src/Internal/commands/reas/__tests__/districts.test.ts` (extend)

**Step 1: Research district IDs via REAS API**

Systematically probe the REAS API for major Czech cities. Use the count endpoint to verify each ID returns data:

```bash
# Script to discover REAS district IDs for major Czech cities
# Run ranges around known patterns (3100=Praha, 3602=HK)
for id in $(seq 3100 3120) $(seq 3200 3210) $(seq 3300 3310) $(seq 3400 3410) $(seq 3500 3520) $(seq 3600 3610) $(seq 3700 3720) $(seq 3800 3810); do
  count=$(curl -s "https://catalog.reas.cz/catalog/listings/count?estateTypes=%5B%22flat%22%5D&soldDateRange=%7B%22from%22%3A%222023-01-01T00%3A00%3A00.000Z%22%2C%22to%22%3A%222025-12-31T23%3A59%3A59.999Z%22%7D&linkedToTransfer=true&locality=%7B%22districtId%22%3A${id}%7D&clientId=6988cb437c5b9d2963280369" 2>/dev/null | jq -r '.data.count // 0' 2>/dev/null)
  if [ "$count" -gt "0" ] 2>/dev/null; then
    echo "districtId=$id → count=$count"
  fi
done
```

Also research Sreality IDs using suggest API:

```bash
# Discover sreality IDs for major cities
for city in "Ostrava" "Plzeň" "Liberec" "Olomouc" "České Budějovice" "Ústí nad Labem" "Pardubice" "Zlín" "Karlovy Vary" "Jihlava" "Opava" "Teplice" "Kladno" "Most" "Frýdek-Místek"; do
  echo "=== $city ==="
  curl -s "https://www.sreality.cz/api/cs/v2/suggest?phrase=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$city'))")&tms=$(date +%s)000" | jq '.data[] | select(.userData.entityType == "municipality") | { name: .userData.suggestFirstRow, districtId: .userData.district_id, municipalityId: .userData.municipality_id }' 2>/dev/null
done
```

And Praha sub-districts:

```bash
for i in $(seq 1 22); do
  echo "=== Praha $i ==="
  curl -s "https://www.sreality.cz/api/cs/v2/suggest?phrase=$(python3 -c "import urllib.parse; print(urllib.parse.quote('Praha $i'))")&tms=$(date +%s)000" | jq '.data[0].userData | { name: .suggestFirstRow, entityType, districtId: .district_id, municipalityId: .municipality_id, regionId: .region_id }' 2>/dev/null
done
```

**Step 2: Write the failing tests**

```typescript
// Extend src/Internal/commands/reas/__tests__/districts.test.ts
import { test, expect, describe } from "bun:test";
import { DISTRICTS, PRAHA_DISTRICTS, getDistrict, searchDistricts } from "../data/districts";

describe("District Database", () => {
    test("has at least 13 major Czech cities", () => {
        expect(Object.keys(DISTRICTS).length).toBeGreaterThanOrEqual(13);
    });

    test("every district has reasId and srealityId", () => {
        for (const [name, info] of Object.entries(DISTRICTS)) {
            expect(info.reasId, `${name} missing reasId`).toBeGreaterThan(0);
            expect(info.srealityId, `${name} missing srealityId`).toBeGreaterThan(0);
        }
    });

    test("no duplicate reasIds", () => {
        const ids = Object.values(DISTRICTS).map((d) => d.reasId);
        const unique = new Set(ids);
        expect(unique.size).toBe(ids.length);
    });

    test("Praha sub-districts cover Praha 1-10", () => {
        for (let i = 1; i <= 10; i++) {
            expect(PRAHA_DISTRICTS[`Praha ${i}`], `Missing Praha ${i}`).toBeDefined();
        }
    });

    test("getDistrict returns exact match", () => {
        const result = getDistrict("Praha");
        expect(result).toBeDefined();
        expect(result!.name).toBe("Praha");
    });

    test("searchDistricts finds partial matches", () => {
        const results = searchDistricts("Hrad");
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].name).toContain("Hradec");
    });
});
```

**Step 3: Run tests to verify they fail**

Run: `bun test src/Internal/commands/reas/__tests__/districts.test.ts`
Expected: FAIL — module not found

**Step 4: Create the district database**

```typescript
// src/Internal/commands/reas/data/districts.ts

export interface DistrictInfo {
    name: string;
    reasId: number;
    srealityId: number;
    srealityRegionId?: number;
    cadastralUnits?: string[];
    avgPricePerM2?: number;
}

export interface PrahaDistrictInfo extends DistrictInfo {
    wardNumber: number;
}

// Populate with IDs discovered in Step 1.
// Comments document the source of each ID.
export const DISTRICTS: Record<string, DistrictInfo> = {
    // IDs from REAS API probing + Sreality suggest API
    "Hradec Králové": { name: "Hradec Králové", reasId: 3602, srealityId: 28 },
    "Praha": { name: "Praha", reasId: 3100, srealityId: 1 },
    "Brno": { name: "Brno", reasId: /* discovered */, srealityId: 4 },
    "Ostrava": { name: "Ostrava", reasId: /* discovered */, srealityId: /* discovered */ },
    "Plzeň": { name: "Plzeň", reasId: /* discovered */, srealityId: /* discovered */ },
    "Liberec": { name: "Liberec", reasId: /* discovered */, srealityId: /* discovered */ },
    "Olomouc": { name: "Olomouc", reasId: /* discovered */, srealityId: /* discovered */ },
    "České Budějovice": { name: "České Budějovice", reasId: /* discovered */, srealityId: /* discovered */ },
    "Ústí nad Labem": { name: "Ústí nad Labem", reasId: /* discovered */, srealityId: /* discovered */ },
    "Pardubice": { name: "Pardubice", reasId: /* discovered */, srealityId: /* discovered */ },
    "Zlín": { name: "Zlín", reasId: /* discovered */, srealityId: /* discovered */ },
    "Karlovy Vary": { name: "Karlovy Vary", reasId: /* discovered */, srealityId: /* discovered */ },
    "Jihlava": { name: "Jihlava", reasId: /* discovered */, srealityId: /* discovered */ },
    // ... more cities as discovered
};

export const PRAHA_DISTRICTS: Record<string, PrahaDistrictInfo> = {
    // IDs from Sreality suggest("Praha 1"), suggest("Praha 2"), etc.
    "Praha 1": { name: "Praha 1", reasId: 3101, srealityId: /* discovered */, wardNumber: 1 },
    "Praha 2": { name: "Praha 2", reasId: 3102, srealityId: /* discovered */, wardNumber: 2 },
    // ... Praha 3-22
};

export function getDistrict(name: string): DistrictInfo | undefined {
    return DISTRICTS[name] ?? PRAHA_DISTRICTS[name];
}

export function searchDistricts(query: string): DistrictInfo[] {
    const lower = query.toLowerCase();
    const all = { ...DISTRICTS, ...PRAHA_DISTRICTS };

    return Object.values(all)
        .filter((d) => d.name.toLowerCase().includes(lower))
        .sort((a, b) => {
            const aStarts = a.name.toLowerCase().startsWith(lower) ? 0 : 1;
            const bStarts = b.name.toLowerCase().startsWith(lower) ? 0 : 1;
            return aStarts - bStarts || a.name.localeCompare(b.name, "cs");
        });
}

export function getAllDistrictNames(): string[] {
    return Object.keys(DISTRICTS).sort((a, b) => a.localeCompare(b, "cs"));
}

export function getPrahaDistrictNames(): string[] {
    return Object.keys(PRAHA_DISTRICTS).sort((a, b) => {
        const numA = parseInt(a.replace("Praha ", ""));
        const numB = parseInt(b.replace("Praha ", ""));
        return numA - numB;
    });
}
```

**Step 5: Run tests**

Run: `bun test src/Internal/commands/reas/__tests__/districts.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/Internal/commands/reas/data/districts.ts src/Internal/commands/reas/__tests__/districts.test.ts
git commit -m "feat(reas): add master district database with 13+ Czech cities and Praha 1-22"
```

---

### Task 3: Wire Districts into CLI

**Files:**
- Modify: `src/Internal/commands/reas/index.ts:28-42` (remove hardcoded DISTRICTS)
- Modify: `src/Internal/commands/reas/index.ts:128-170` (wizard district selector)

**Step 1: Replace hardcoded DISTRICTS with import**

In `index.ts`, remove the inline `DISTRICTS` constant (lines 28-42) and replace with:

```typescript
import { DISTRICTS, PRAHA_DISTRICTS, getAllDistrictNames, getPrahaDistrictNames, getDistrict, searchDistricts } from "./data/districts";
```

Update the `DistrictInfo` type reference — it's now imported from `data/districts.ts` instead of inline. Remove the inline `interface DistrictInfo` (lines 33-37).

**Step 2: Update wizard district selector**

Replace the simple district select with a two-level selector. In the wizard function, replace the district selection section:

```typescript
// Step 1: Select city
const districtName = await select({
    message: "Select district",
    options: [
        ...getAllDistrictNames().map((name) => ({ value: name, label: name })),
        { value: "__search__", label: "🔍 Search by name..." },
    ],
});

if (isCancel(districtName)) {
    cancel("Cancelled");
    process.exit(0);
}

let selectedDistrict: DistrictInfo;

if (districtName === "__search__") {
    const query = await text({ message: "Type city name" });
    if (isCancel(query)) {
        cancel("Cancelled");
        process.exit(0);
    }

    const matches = searchDistricts(query);
    if (matches.length === 0) {
        cancel(`No districts found for "${query}"`);
        process.exit(1);
    }

    const picked = await select({
        message: "Select from matches",
        options: matches.map((d) => ({ value: d.name, label: d.name })),
    });
    if (isCancel(picked)) {
        cancel("Cancelled");
        process.exit(0);
    }

    selectedDistrict = getDistrict(picked)!;
} else if (districtName === "Praha") {
    // Sub-district selector for Praha
    const subDistrict = await select({
        message: "Select Praha district (or city-wide)",
        options: [
            { value: "Praha", label: "Praha (celá)" },
            ...getPrahaDistrictNames().map((name) => ({ value: name, label: name })),
        ],
    });

    if (isCancel(subDistrict)) {
        cancel("Cancelled");
        process.exit(0);
    }

    selectedDistrict = getDistrict(subDistrict)!;
} else {
    selectedDistrict = getDistrict(districtName)!;
}
```

**Step 3: Update buildFromFlags to use new district lookup**

In `buildFromFlags()`, replace the hardcoded DISTRICTS lookup:

```typescript
const district = getDistrict(options.district);
if (!district) {
    const matches = searchDistricts(options.district);
    if (matches.length === 1) {
        // Auto-resolve unique partial match
        district = matches[0];
    } else if (matches.length > 1) {
        console.error(`Ambiguous district "${options.district}". Matches: ${matches.map((d) => d.name).join(", ")}`);
        process.exit(1);
    } else {
        console.error(`Unknown district: ${options.district}. Available: ${getAllDistrictNames().join(", ")}`);
        process.exit(1);
    }
}
```

**Step 4: Verify no TypeScript errors**

Run: `bunx --bun tsgo --noEmit 2>&1 | rg "commands/reas/"`
Expected: No errors

**Step 5: Manual smoke test**

Run: `bun src/Internal/index.ts reas --district "Hradec Králové" --type panel --disposition "3+1" --periods 2025 --price 3500000 --area 68 --rent 10000 --monthly-costs 3000`
Expected: Same output as before (regression check)

**Step 6: Commit**

```bash
git add src/Internal/commands/reas/index.ts
git commit -m "refactor(reas): wire master district database into CLI wizard and flags"
```

---

### Task 4: Create Disposition Map

**Files:**
- Create: `src/Internal/commands/reas/data/disposition-map.ts`
- Test: `src/Internal/commands/reas/__tests__/disposition-map.test.ts`

**Step 1: Write the failing test**

```typescript
// src/Internal/commands/reas/__tests__/disposition-map.test.ts
import { test, expect, describe } from "bun:test";
import { normalizeDisposition, DISPOSITIONS, getSrealityCategorySubCb } from "../data/disposition-map";

describe("Disposition Map", () => {
    test("normalizes common Czech variants", () => {
        expect(normalizeDisposition("2+kk")).toBe("2+kk");
        expect(normalizeDisposition("2+KK")).toBe("2+kk");
        expect(normalizeDisposition("3+1")).toBe("3+1");
        expect(normalizeDisposition("garsoniera")).toBe("1+kk");
        expect(normalizeDisposition("garsoniéra")).toBe("1+kk");
    });

    test("getSrealityCategorySubCb maps dispositions to Sreality codes", () => {
        expect(getSrealityCategorySubCb("1+kk")).toBe(2);
        expect(getSrealityCategorySubCb("2+kk")).toBe(4);
        expect(getSrealityCategorySubCb("3+1")).toBe(7);
    });

    test("DISPOSITIONS list has standard Czech dispositions", () => {
        expect(DISPOSITIONS).toContain("1+kk");
        expect(DISPOSITIONS).toContain("1+1");
        expect(DISPOSITIONS).toContain("2+kk");
        expect(DISPOSITIONS).toContain("5+1");
        expect(DISPOSITIONS.length).toBeGreaterThanOrEqual(10);
    });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/Internal/commands/reas/__tests__/disposition-map.test.ts`
Expected: FAIL — module not found

**Step 3: Implement disposition map**

```typescript
// src/Internal/commands/reas/data/disposition-map.ts

// Canonical Czech flat disposition codes
export const DISPOSITIONS = [
    "1+kk", "1+1",
    "2+kk", "2+1",
    "3+kk", "3+1",
    "4+kk", "4+1",
    "5+kk", "5+1",
    "6+kk", "6+1",
] as const;

export type Disposition = (typeof DISPOSITIONS)[number];

// Sreality category_sub_cb codes
const SREALITY_DISPOSITION_MAP: Record<string, number> = {
    "1+kk": 2, "1+1": 3,
    "2+kk": 4, "2+1": 5,
    "3+kk": 6, "3+1": 7,
    "4+kk": 8, "4+1": 9,
    "5+kk": 10, "5+1": 11,
    "6+kk": 12, "6+1": 47,
};

const ALIASES: Record<string, string> = {
    garsoniera: "1+kk",
    garsoniéra: "1+kk",
    "garsonka": "1+kk",
    atypický: "other",
    atypicky: "other",
};

export function normalizeDisposition(raw: string): string {
    const lower = raw.toLowerCase().trim();

    if (ALIASES[lower]) {
        return ALIASES[lower];
    }

    // Match pattern like "2+kk", "3+1"
    const match = lower.match(/^(\d)\+(\d|kk)$/);
    if (match) {
        return `${match[1]}+${match[2]}`;
    }

    return lower;
}

export function getSrealityCategorySubCb(disposition: string): number | undefined {
    return SREALITY_DISPOSITION_MAP[normalizeDisposition(disposition)];
}
```

**Step 4: Run tests**

Run: `bun test src/Internal/commands/reas/__tests__/disposition-map.test.ts`
Expected: PASS

**Step 5: Remove duplicate DISPOSITION_MAP from sreality-client.ts**

In `api/sreality-client.ts`, replace the inline `DISPOSITION_MAP` (lines ~12-20) with an import:

```typescript
import { getSrealityCategorySubCb } from "../data/disposition-map";
```

Update `buildSearchParams()` to use `getSrealityCategorySubCb(filters.disposition)` instead of `DISPOSITION_MAP[filters.disposition]`.

**Step 6: Verify no TypeScript errors**

Run: `bunx --bun tsgo --noEmit 2>&1 | rg "commands/reas/"`
Expected: No errors

**Step 7: Commit**

```bash
git add src/Internal/commands/reas/data/disposition-map.ts src/Internal/commands/reas/__tests__/disposition-map.test.ts src/Internal/commands/reas/api/sreality-client.ts
git commit -m "feat(reas): add unified disposition map, deduplicate Sreality mapping"
```

---

### Task 5: Unit Tests for Existing Analysis Modules

**Files:**
- Create: `src/Internal/commands/reas/__tests__/comparables.test.ts`
- Create: `src/Internal/commands/reas/__tests__/trends.test.ts`
- Create: `src/Internal/commands/reas/__tests__/rental-yield.test.ts`
- Create: `src/Internal/commands/reas/__tests__/sreality-client.test.ts`

**Step 1: Write comparables tests**

```typescript
// src/Internal/commands/reas/__tests__/comparables.test.ts
import { test, expect, describe } from "bun:test";
import { median, percentile, analyzeComparables } from "../analysis/comparables";

describe("median()", () => {
    test("odd-length array", () => {
        expect(median([1, 3, 5])).toBe(3);
    });

    test("even-length array", () => {
        expect(median([1, 2, 3, 4])).toBe(2.5);
    });

    test("single element", () => {
        expect(median([42])).toBe(42);
    });

    test("empty array returns NaN", () => {
        expect(median([])).toBeNaN();
    });
});

describe("percentile()", () => {
    test("p50 equals median", () => {
        expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30);
    });

    test("p0 equals min", () => {
        expect(percentile([10, 20, 30], 0)).toBe(10);
    });

    test("p100 equals max", () => {
        expect(percentile([10, 20, 30], 100)).toBe(30);
    });
});

describe("analyzeComparables()", () => {
    const listings = [
        { soldPrice: 3000000, utilityArea: 60, originalPrice: 3200000, soldAt: "2024-06-01", firstVisibleAt: "2024-03-01" },
        { soldPrice: 4000000, utilityArea: 80, originalPrice: 4000000, soldAt: "2024-07-01", firstVisibleAt: "2024-05-01" },
        { soldPrice: 2500000, utilityArea: 50, originalPrice: 2800000, soldAt: "2024-08-01", firstVisibleAt: "2024-06-15" },
    ] as any[];

    test("computes median price per m²", () => {
        const result = analyzeComparables(listings, { price: 3500000, area: 65 } as any);
        expect(result.pricePerM2.median).toBe(50000); // sorted: [50000, 50000, 50000]
    });

    test("computes target percentile", () => {
        const result = analyzeComparables(listings, { price: 3500000, area: 65 } as any);
        // target CZK/m² = 3500000/65 ≈ 53846
        expect(result.targetPercentile).toBeGreaterThan(0);
        expect(result.targetPercentile).toBeLessThanOrEqual(100);
    });

    test("filters out listings with zero area", () => {
        const withZero = [...listings, { soldPrice: 1000000, utilityArea: 0, originalPrice: 1000000, soldAt: "2024-01-01", firstVisibleAt: "2024-01-01" }];
        const result = analyzeComparables(withZero as any[], { price: 3500000, area: 65 } as any);
        expect(result.listings.length).toBe(3);
    });
});
```

**Step 2: Write sreality client tests**

```typescript
// src/Internal/commands/reas/__tests__/sreality-client.test.ts
import { test, expect, describe } from "bun:test";
import { parseSrealityName } from "../api/sreality-client";

describe("parseSrealityName()", () => {
    test("parses standard rental name", () => {
        expect(parseSrealityName("Pronájem bytu 2+kk 54 m²")).toEqual({ disposition: "2+kk", area: 54 });
    });

    test("parses without diacritics", () => {
        expect(parseSrealityName("Pronajem bytu 3+1 68 m²")).toEqual({ disposition: "3+1", area: 68 });
    });

    test("returns undefineds for non-matching input", () => {
        expect(parseSrealityName("Prodej domu 150 m²")).toEqual({ disposition: undefined, area: undefined });
    });

    test("parses 1+kk", () => {
        expect(parseSrealityName("Pronájem bytu 1+kk 28 m²")).toEqual({ disposition: "1+kk", area: 28 });
    });
});
```

**Step 3: Write rental yield tests**

```typescript
// src/Internal/commands/reas/__tests__/rental-yield.test.ts
import { test, expect, describe } from "bun:test";
import { analyzeRentalYield } from "../analysis/rental-yield";

describe("analyzeRentalYield()", () => {
    test("computes gross yield correctly", () => {
        const result = analyzeRentalYield(
            { price: 3000000, area: 60, monthlyRent: 15000, monthlyCosts: 5000 } as any,
            50000, // medianPricePerM2
            undefined,
        );

        // Gross = (15000 * 12 / 3000000) * 100 = 6%
        expect(result.grossYield).toBeCloseTo(6.0, 1);
    });

    test("computes net yield correctly", () => {
        const result = analyzeRentalYield(
            { price: 3000000, area: 60, monthlyRent: 15000, monthlyCosts: 5000 } as any,
            50000,
            undefined,
        );

        // Net = ((15000 - 5000) * 12 / 3000000) * 100 = 4%
        expect(result.netYield).toBeCloseTo(4.0, 1);
    });

    test("computes payback in years", () => {
        const result = analyzeRentalYield(
            { price: 3000000, area: 60, monthlyRent: 15000, monthlyCosts: 5000 } as any,
            50000,
            undefined,
        );

        // Payback = 3000000 / ((15000 - 5000) * 12) = 25 years
        expect(result.paybackYears).toBeCloseTo(25, 0);
    });

    test("includes at-market-price scenario", () => {
        const result = analyzeRentalYield(
            { price: 3000000, area: 60, monthlyRent: 15000, monthlyCosts: 5000 } as any,
            50000,
            undefined,
        );

        // Market price = 50000 * 60 = 3,000,000 (same as target in this case)
        expect(result.atMarketPrice.price).toBe(3000000);
    });
});
```

**Step 4: Write trends tests**

```typescript
// src/Internal/commands/reas/__tests__/trends.test.ts
import { test, expect, describe } from "bun:test";
import { analyzeTrends } from "../analysis/trends";

describe("analyzeTrends()", () => {
    test("groups listings into quarters", () => {
        const listings = [
            { soldAt: "2024-01-15", utilityArea: 60, soldPrice: 3000000 },
            { soldAt: "2024-02-20", utilityArea: 50, soldPrice: 2500000 },
            { soldAt: "2024-04-10", utilityArea: 70, soldPrice: 3500000 },
            { soldAt: "2024-07-05", utilityArea: 65, soldPrice: 3250000 },
        ] as any[];

        const result = analyzeTrends(listings);
        expect(result.periods.length).toBe(3); // Q1, Q2, Q3
        expect(result.periods[0].label).toBe("Q1 2024");
    });

    test("detects rising market", () => {
        const listings = [
            { soldAt: "2024-01-15", utilityArea: 60, soldPrice: 2400000 }, // 40k/m²
            { soldAt: "2024-04-10", utilityArea: 60, soldPrice: 2700000 }, // 45k/m²
            { soldAt: "2024-07-05", utilityArea: 60, soldPrice: 3000000 }, // 50k/m²
        ] as any[];

        const result = analyzeTrends(listings);
        expect(result.direction).toBe("rising");
    });

    test("returns null yoyChange with insufficient data", () => {
        const listings = [
            { soldAt: "2024-01-15", utilityArea: 60, soldPrice: 3000000 },
        ] as any[];

        const result = analyzeTrends(listings);
        expect(result.yoyChange).toBeNull();
    });
});
```

**Step 5: Run all tests**

Run: `bun test src/Internal/commands/reas/__tests__/`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add src/Internal/commands/reas/__tests__/
git commit -m "test(reas): add unit tests for comparables, trends, rental-yield, sreality-client"
```

---

## Phase 2: New Data Providers

**Goal:** Add eReality HTML scraping (proven data source from artifact session) and Bezrealitky. Create unified rental aggregation.

---

### Task 6: Research Bezrealitky API

**Files:**
- Create: `src/Internal/commands/reas/api/bezrealitky-client.ts` (stub)
- Notes: Document findings in commit message

**Step 1: Probe Bezrealitky for API endpoints**

```bash
# Check if bezrealitky has a public API
curl -s "https://www.bezrealitky.cz/api/record/markers" \
  -H "Accept: application/json" \
  -H "User-Agent: Mozilla/5.0" | head -c 500

# Try GraphQL endpoint (bezrealitky uses GraphQL)
curl -s "https://www.bezrealitky.cz/api/graphql" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "User-Agent: Mozilla/5.0" \
  -d '{"query":"{ listEstates(offerType: PRONAJEM, estateType: BYT, regionOsmIds: [\"R435514\"], limit: 5) { list { id uri price { amount } address { street city } surface disposition } } }"}' | tools json

# Check robots.txt
curl -s "https://www.bezrealitky.cz/robots.txt"
```

**Step 2: Document findings**

Based on results, determine whether Bezrealitky has:
- A GraphQL API (most likely — they've used this historically)
- REST endpoints
- Or requires HTML scraping

Record the endpoint structure, required headers, rate limits, and pagination approach.

**Step 3: Create stub client**

```typescript
// src/Internal/commands/reas/api/bezrealitky-client.ts
import type { AnalysisFilters, DateRange } from "../types";
import { cacheKey, getCached, setCache } from "../cache/index";

const BASE_URL = "https://www.bezrealitky.cz/api";
const BEZREALITKY_TTL = 12 * 60 * 60 * 1000; // 12 hours

export interface BezrealitkyListing {
    id: string;
    disposition: string;
    area: number;
    price: number;
    address: string;
    municipality: string;
    type: "sale" | "rent";
    link: string;
    createdAt?: string;
}

// TODO: Implement after API research
export async function fetchBezrealitkyRentals(
    _filters: AnalysisFilters,
    _refresh?: boolean,
): Promise<BezrealitkyListing[]> {
    return [];
}

export async function fetchBezrealitkySales(
    _filters: AnalysisFilters,
    _dateRange?: DateRange,
    _refresh?: boolean,
): Promise<BezrealitkyListing[]> {
    return [];
}
```

**Step 4: Commit**

```bash
git add src/Internal/commands/reas/api/bezrealitky-client.ts
git commit -m "chore(reas): add Bezrealitky client stub, document API research"
```

---

### Task 7: Implement eReality HTML Scraper

This was the most productive additional data source in the artifact session — `ereality.cz/pronajem/byty/praha_9/Letňany` yielded 20 rental listings vs Sreality's 4.

**Files:**
- Create: `src/Internal/commands/reas/api/ereality-client.ts`
- Test: `src/Internal/commands/reas/__tests__/ereality-client.test.ts`

**Step 1: Research eReality URL patterns**

```bash
# Check what the page looks like
curl -s "https://www.ereality.cz/pronajem/byty/praha/" \
  -H "User-Agent: Mozilla/5.0" | head -c 2000

# Check robots.txt
curl -s "https://www.ereality.cz/robots.txt"

# Check if there's a JSON API
curl -s "https://www.ereality.cz/api/v1/estates?type=pronajem&category=byty&region=praha" \
  -H "Accept: application/json" \
  -H "User-Agent: Mozilla/5.0" | head -c 500
```

**Step 2: Write the failing tests**

```typescript
// src/Internal/commands/reas/__tests__/ereality-client.test.ts
import { test, expect, describe } from "bun:test";
import { parseErealityHtml, buildErealityUrl } from "../api/ereality-client";

describe("buildErealityUrl()", () => {
    test("builds URL for Praha 9 rentals", () => {
        const url = buildErealityUrl({ type: "rent", city: "praha", district: "praha_9" });
        expect(url).toBe("https://www.ereality.cz/pronajem/byty/praha_9/");
    });

    test("builds URL for Brno rentals", () => {
        const url = buildErealityUrl({ type: "rent", city: "brno" });
        expect(url).toBe("https://www.ereality.cz/pronajem/byty/brno/");
    });

    test("builds URL with neighborhood", () => {
        const url = buildErealityUrl({ type: "rent", city: "praha", district: "praha_9", neighborhood: "Letňany" });
        expect(url).toContain("Letňany");
    });
});

describe("parseErealityHtml()", () => {
    // Test with a realistic HTML snippet
    const sampleHtml = `
    <div class="property-list">
      <div class="property-item">
        <h2>Pronájem bytu 2+kk, 54 m², Praha 9 - Letňany</h2>
        <span class="price">15 000 Kč/měsíc</span>
        <a href="/detail/12345">Detail</a>
      </div>
    </div>`;

    test("extracts listings from HTML", () => {
        const listings = parseErealityHtml(sampleHtml);
        // This test will need adjustment based on actual HTML structure
        expect(Array.isArray(listings)).toBe(true);
    });
});
```

**Step 3: Run tests to verify they fail**

Run: `bun test src/Internal/commands/reas/__tests__/ereality-client.test.ts`
Expected: FAIL — module not found

**Step 4: Implement eReality client**

```typescript
// src/Internal/commands/reas/api/ereality-client.ts
import type { SrealityRental, AnalysisFilters } from "../types";
import { cacheKey, getCached, setCache } from "../cache/index";

const BASE_URL = "https://www.ereality.cz";
const EREALITY_TTL = 6 * 60 * 60 * 1000; // 6 hours

interface ErealityUrlParams {
    type: "rent" | "sale";
    city: string;
    district?: string;
    neighborhood?: string;
    page?: number;
}

export function buildErealityUrl(params: ErealityUrlParams): string {
    const category = params.type === "rent" ? "pronajem" : "prodej";
    let path = `${BASE_URL}/${category}/byty/`;

    if (params.district) {
        path += `${params.district}/`;
    } else {
        path += `${params.city}/`;
    }

    if (params.neighborhood) {
        path += `${encodeURIComponent(params.neighborhood)}/`;
    }

    if (params.page && params.page > 1) {
        path += `?strana=${params.page}`;
    }

    return path;
}

export function parseErealityHtml(html: string): SrealityRental[] {
    // Parse using regex (Bun doesn't bundle cheerio by default)
    // The exact selectors depend on eReality's HTML structure — adjust after Step 1 research
    const listings: SrealityRental[] = [];

    // Pattern: look for property cards with price, disposition, area
    // This regex pattern should be adjusted based on actual HTML structure discovered in Step 1
    const cardPattern = /<div[^>]*class="[^"]*property[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
    const pricePattern = /(\d[\d\s]*)\s*Kč/;
    const dispositionPattern = /(\d\+(?:kk|\d))/i;
    const areaPattern = /(\d+)\s*m[²2]/;
    const linkPattern = /href="(\/detail\/[^"]+)"/;

    let match;
    let id = 0;

    while ((match = cardPattern.exec(html)) !== null) {
        const card = match[1];
        const priceMatch = card.match(pricePattern);
        const dispMatch = card.match(dispositionPattern);
        const areaMatch = card.match(areaPattern);
        const linkMatch = card.match(linkPattern);

        if (priceMatch) {
            const price = parseInt(priceMatch[1].replace(/\s/g, ""));
            listings.push({
                hash_id: id++,
                name: card.match(/<h[23][^>]*>(.*?)<\/h[23]>/i)?.[1]?.replace(/<[^>]+>/g, "").trim() ?? "",
                price,
                locality: "",
                gps: { lat: 0, lon: 0 },
                labels: [],
                disposition: dispMatch?.[1],
                area: areaMatch ? parseInt(areaMatch[1]) : undefined,
                link: linkMatch ? `${BASE_URL}${linkMatch[1]}` : undefined,
            });
        }
    }

    return listings;
}

export async function fetchErealityRentals(
    filters: AnalysisFilters,
    refresh?: boolean,
): Promise<SrealityRental[]> {
    const citySlug = filters.district.name.toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, "_");

    const key = cacheKey({ source: "ereality", city: citySlug, type: "rent" });

    if (!refresh) {
        const cached = await getCached<SrealityRental>(key, EREALITY_TTL);
        if (cached) {
            return cached.data;
        }
    }

    const allListings: SrealityRental[] = [];
    let page = 1;
    const maxPages = 5; // Safety limit

    while (page <= maxPages) {
        const url = buildErealityUrl({ type: "rent", city: citySlug, page });
        const response = await fetch(url, {
            headers: { "User-Agent": "Mozilla/5.0 (compatible; GenesisTools/1.0)" },
        });

        if (!response.ok) {
            break;
        }

        const html = await response.text();
        const listings = parseErealityHtml(html);

        if (listings.length === 0) {
            break;
        }

        allListings.push(...listings);
        page++;

        // Rate limit: 1 request per second
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    await setCache(key, {
        fetchedAt: new Date().toISOString(),
        params: { source: "ereality", city: citySlug },
        count: allListings.length,
        data: allListings,
    });

    return allListings;
}
```

**Step 5: Run tests**

Run: `bun test src/Internal/commands/reas/__tests__/ereality-client.test.ts`
Expected: PASS (at least the URL building and basic parsing tests)

**Step 6: Commit**

```bash
git add src/Internal/commands/reas/api/ereality-client.ts src/Internal/commands/reas/__tests__/ereality-client.test.ts
git commit -m "feat(reas): add eReality HTML scraper for rental listings"
```

---

### Task 8: Unified Rental Aggregation

**Files:**
- Create: `src/Internal/commands/reas/analysis/rental-aggregation.ts`
- Test: `src/Internal/commands/reas/__tests__/rental-aggregation.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/Internal/commands/reas/__tests__/rental-aggregation.test.ts
import { test, expect, describe } from "bun:test";
import { aggregateRentals, deduplicateListings } from "../analysis/rental-aggregation";
import type { RentalSource } from "../analysis/rental-aggregation";

describe("deduplicateListings()", () => {
    test("removes same-address same-price duplicates across providers", () => {
        const sources: RentalSource[] = [
            {
                provider: "sreality",
                listings: [{ disposition: "2+kk", area: 54, rent: 15000, address: "Letňany, Praha 9" }],
            },
            {
                provider: "ereality",
                listings: [{ disposition: "2+kk", area: 54, rent: 15000, address: "Letňany, Praha 9" }],
            },
        ];

        const deduped = deduplicateListings(sources);
        expect(deduped.length).toBe(1);
    });

    test("keeps listings with different prices", () => {
        const sources: RentalSource[] = [
            {
                provider: "sreality",
                listings: [{ disposition: "2+kk", area: 54, rent: 15000, address: "Letňany" }],
            },
            {
                provider: "ereality",
                listings: [{ disposition: "2+kk", area: 54, rent: 16000, address: "Letňany" }],
            },
        ];

        const deduped = deduplicateListings(sources);
        expect(deduped.length).toBe(2);
    });
});

describe("aggregateRentals()", () => {
    test("groups by disposition and computes stats", () => {
        const sources: RentalSource[] = [
            {
                provider: "sreality",
                listings: [
                    { disposition: "2+kk", area: 50, rent: 14000, address: "A" },
                    { disposition: "2+kk", area: 55, rent: 16000, address: "B" },
                    { disposition: "3+1", area: 70, rent: 18000, address: "C" },
                ],
            },
        ];

        const result = aggregateRentals(sources);
        const twoKk = result.find((r) => r.disposition === "2+kk");
        expect(twoKk).toBeDefined();
        expect(twoKk!.count).toBe(2);
        expect(twoKk!.medianRent).toBe(15000);
    });

    test("assigns confidence based on sample size", () => {
        const manyListings = Array.from({ length: 15 }, (_, i) => ({
            disposition: "2+kk", area: 50 + i, rent: 14000 + i * 500, address: `Addr ${i}`,
        }));

        const result = aggregateRentals([{ provider: "sreality", listings: manyListings }]);
        expect(result[0].confidence).toBe("high");
    });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/Internal/commands/reas/__tests__/rental-aggregation.test.ts`
Expected: FAIL

**Step 3: Implement rental aggregation**

```typescript
// src/Internal/commands/reas/analysis/rental-aggregation.ts
import { median } from "./comparables";

export interface RentalSource {
    provider: "sreality" | "ereality" | "bezrealitky";
    listings: Array<{ disposition: string; area: number; rent: number; address: string }>;
}

export interface AggregatedRentalStats {
    disposition: string;
    count: number;
    medianRent: number;
    meanRent: number;
    minRent: number;
    maxRent: number;
    rentPerM2: number;
    sources: Record<string, { count: number; median: number }>;
    confidence: "high" | "medium" | "low";
}

interface UnifiedListing {
    disposition: string;
    area: number;
    rent: number;
    address: string;
    provider: string;
}

export function deduplicateListings(sources: RentalSource[]): UnifiedListing[] {
    const all: UnifiedListing[] = [];

    for (const source of sources) {
        for (const listing of source.listings) {
            all.push({ ...listing, provider: source.provider });
        }
    }

    const seen = new Set<string>();
    return all.filter((listing) => {
        // Dedupe key: normalized address + price (±500 CZK tolerance)
        const addrNorm = listing.address.toLowerCase().replace(/\s+/g, " ").trim();
        const priceGroup = Math.round(listing.rent / 500) * 500;
        const key = `${addrNorm}|${listing.disposition}|${priceGroup}`;

        if (seen.has(key)) {
            return false;
        }

        seen.add(key);
        return true;
    });
}

export function aggregateRentals(sources: RentalSource[]): AggregatedRentalStats[] {
    const deduped = deduplicateListings(sources);

    // Group by disposition
    const groups = new Map<string, UnifiedListing[]>();

    for (const listing of deduped) {
        if (!listing.disposition) {
            continue;
        }

        const existing = groups.get(listing.disposition) ?? [];
        existing.push(listing);
        groups.set(listing.disposition, existing);
    }

    const results: AggregatedRentalStats[] = [];

    for (const [disposition, listings] of groups) {
        const rents = listings.map((l) => l.rent).sort((a, b) => a - b);
        const areas = listings.filter((l) => l.area > 0).map((l) => l.area);
        const meanArea = areas.length > 0 ? areas.reduce((a, b) => a + b, 0) / areas.length : 0;
        const medianRent = median(rents);

        // Per-provider stats
        const providerGroups = new Map<string, number[]>();

        for (const listing of listings) {
            const existing = providerGroups.get(listing.provider) ?? [];
            existing.push(listing.rent);
            providerGroups.set(listing.provider, existing);
        }

        const sourcesMap: Record<string, { count: number; median: number }> = {};

        for (const [provider, provRents] of providerGroups) {
            sourcesMap[provider] = {
                count: provRents.length,
                median: median(provRents.sort((a, b) => a - b)),
            };
        }

        results.push({
            disposition,
            count: listings.length,
            medianRent,
            meanRent: rents.reduce((a, b) => a + b, 0) / rents.length,
            minRent: rents[0],
            maxRent: rents[rents.length - 1],
            rentPerM2: meanArea > 0 ? medianRent / meanArea : 0,
            sources: sourcesMap,
            confidence: listings.length >= 10 ? "high" : listings.length >= 5 ? "medium" : "low",
        });
    }

    return results.sort((a, b) => a.disposition.localeCompare(b.disposition));
}
```

**Step 4: Run tests**

Run: `bun test src/Internal/commands/reas/__tests__/rental-aggregation.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/Internal/commands/reas/analysis/rental-aggregation.ts src/Internal/commands/reas/__tests__/rental-aggregation.test.ts
git commit -m "feat(reas): add multi-source rental aggregation with dedup and confidence scoring"
```

---

## Phase 3: Address Resolution & Enhanced Search

**Goal:** Use Sreality's suggest API (already implemented but unused) to resolve addresses, enable cross-provider search.

---

### Task 9: Address Resolver

**Files:**
- Create: `src/Internal/commands/reas/lib/address-resolver.ts`
- Test: `src/Internal/commands/reas/__tests__/address-resolver.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/Internal/commands/reas/__tests__/address-resolver.test.ts
import { test, expect, describe } from "bun:test";
import { parseResolvedAddress, buildSearchFilters } from "../lib/address-resolver";

describe("parseResolvedAddress()", () => {
    test("parses Sreality suggest response into ResolvedAddress", () => {
        const suggestItem = {
            value: "Praha 9 - Letňany",
            regionType: "municipality",
            regionId: 13717,
            districtId: 5009,
            municipality: "Praha 9",
        };

        const result = parseResolvedAddress(suggestItem);
        expect(result.municipality).toBe("Praha 9");
        expect(result.srealityRegionId).toBe(13717);
    });
});

describe("buildSearchFilters()", () => {
    test("creates AnalysisFilters from resolved address", () => {
        const resolved = {
            query: "Letňany",
            municipality: "Praha 9",
            srealityId: 5009,
            reasId: 3109,
        };

        const filters = buildSearchFilters(resolved as any);
        expect(filters.district.name).toBe("Praha 9");
        expect(filters.district.srealityId).toBe(5009);
    });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/Internal/commands/reas/__tests__/address-resolver.test.ts`
Expected: FAIL

**Step 3: Implement address resolver**

```typescript
// src/Internal/commands/reas/lib/address-resolver.ts
import { suggestLocality } from "../api/sreality-client";
import { getDistrict, searchDistricts } from "../data/districts";
import type { AnalysisFilters } from "../types";

export interface ResolvedAddress {
    query: string;
    municipality: string;
    district?: string;
    neighborhood?: string;
    street?: string;
    reasId?: number;
    srealityId?: number;
    srealityRegionId?: number;
    coordinates?: { lat: number; lng: number };
}

interface SuggestItem {
    value: string;
    regionType: string;
    regionId: number;
    districtId: number;
    municipality: string;
}

export function parseResolvedAddress(item: SuggestItem): ResolvedAddress {
    return {
        query: item.value,
        municipality: item.municipality,
        srealityId: item.districtId,
        srealityRegionId: item.regionId,
    };
}

export async function resolveAddress(query: string): Promise<ResolvedAddress[]> {
    const suggestions = await suggestLocality(query);

    return suggestions.map((s) => {
        const resolved = parseResolvedAddress(s);

        // Cross-reference with master district DB
        const district = getDistrict(resolved.municipality);

        if (district) {
            resolved.reasId = district.reasId;

            if (!resolved.srealityId) {
                resolved.srealityId = district.srealityId;
            }
        }

        return resolved;
    });
}

export function buildSearchFilters(resolved: ResolvedAddress): Partial<AnalysisFilters> {
    return {
        estateType: "flat",
        district: {
            name: resolved.municipality,
            reasId: resolved.reasId ?? 0,
            srealityId: resolved.srealityId ?? 0,
        },
    };
}
```

**Step 4: Run tests**

Run: `bun test src/Internal/commands/reas/__tests__/address-resolver.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/Internal/commands/reas/lib/address-resolver.ts src/Internal/commands/reas/__tests__/address-resolver.test.ts
git commit -m "feat(reas): add address resolver using Sreality suggest + district DB cross-reference"
```

---

### Task 10: Wire Address Search into CLI

**Files:**
- Modify: `src/Internal/commands/reas/index.ts`

**Step 1: Add address search flow to wizard**

After the district selection in `runInteractiveWizard()`, add an alternative "Search by address" option. Insert before the existing district selector:

```typescript
const searchMode = await select({
    message: "How do you want to search?",
    options: [
        { value: "district", label: "By district (dropdown)" },
        { value: "address", label: "By address (type to search)" },
    ],
});

if (isCancel(searchMode)) {
    cancel("Cancelled");
    process.exit(0);
}

if (searchMode === "address") {
    const query = await text({ message: "Enter address or neighborhood" });
    if (isCancel(query)) {
        cancel("Cancelled");
        process.exit(0);
    }

    const { resolveAddress, buildSearchFilters } = await import("./lib/address-resolver");
    const results = await resolveAddress(query);

    if (results.length === 0) {
        cancel(`No locations found for "${query}"`);
        process.exit(1);
    }

    const picked = await select({
        message: "Select location",
        options: results.map((r) => ({
            value: r,
            label: `${r.municipality}${r.neighborhood ? ` - ${r.neighborhood}` : ""} (sreality: ${r.srealityId})`,
        })),
    });

    if (isCancel(picked)) {
        cancel("Cancelled");
        process.exit(0);
    }

    const partialFilters = buildSearchFilters(picked);
    // Merge with rest of wizard flow...
}
```

**Step 2: Add `--address` CLI flag**

In the command registration section, add:

```typescript
.option("--address <query>", "Search by address/neighborhood (uses Sreality suggest)")
```

In `runReasAnalysis()`, add address resolution before the flags path:

```typescript
if (options.address) {
    const { resolveAddress, buildSearchFilters } = await import("./lib/address-resolver");
    const results = await resolveAddress(options.address);

    if (results.length === 0) {
        console.error(`No locations found for "${options.address}"`);
        process.exit(1);
    }

    // Use first result, override district
    const resolved = results[0];
    const partialFilters = buildSearchFilters(resolved);
    options.district = resolved.municipality;
    // Continue with normal flags flow...
}
```

**Step 3: Verify no TypeScript errors**

Run: `bunx --bun tsgo --noEmit 2>&1 | rg "commands/reas/"`
Expected: No errors

**Step 4: Commit**

```bash
git add src/Internal/commands/reas/index.ts
git commit -m "feat(reas): add --address flag and wizard search-by-address flow"
```

---

### Task 11: Advanced Filter Options

**Files:**
- Modify: `src/Internal/commands/reas/types.ts`
- Modify: `src/Internal/commands/reas/index.ts`

**Step 1: Extend AnalysisFilters type**

In `types.ts`, add new optional fields to `AnalysisFilters`:

```typescript
export interface AnalysisFilters {
    // existing fields...
    estateType: "flat";
    constructionType: string;
    disposition?: string;
    periods: DateRange[];
    district: { name: string; reasId: number; srealityId: number };

    // NEW optional filters
    priceMin?: number;
    priceMax?: number;
    areaMin?: number;
    areaMax?: number;
    providers?: Array<"reas" | "sreality" | "ereality" | "bezrealitky" | "mf">;
}
```

**Step 2: Add CLI flags**

In the command registration:

```typescript
.option("--price-min <czk>", "Minimum price filter", parseInt)
.option("--price-max <czk>", "Maximum price filter", parseInt)
.option("--area-min <m2>", "Minimum area filter", parseInt)
.option("--area-max <m2>", "Maximum area filter", parseInt)
.option("--providers <list>", "Comma-separated providers (reas,sreality,ereality,bezrealitky)")
```

**Step 3: Apply filters in fetchAndAnalyze**

After fetching listings, apply the new filters:

```typescript
if (filters.priceMin) {
    listings = listings.filter((l) => l.soldPrice >= filters.priceMin!);
}

if (filters.priceMax) {
    listings = listings.filter((l) => l.soldPrice <= filters.priceMax!);
}

if (filters.areaMin) {
    listings = listings.filter((l) => l.utilityArea >= filters.areaMin!);
}

if (filters.areaMax) {
    listings = listings.filter((l) => l.utilityArea <= filters.areaMax!);
}
```

**Step 4: Verify no TypeScript errors**

Run: `bunx --bun tsgo --noEmit 2>&1 | rg "commands/reas/"`
Expected: No errors

**Step 5: Commit**

```bash
git add src/Internal/commands/reas/types.ts src/Internal/commands/reas/index.ts
git commit -m "feat(reas): add price/area range filters and --providers flag"
```

---

## Phase 4: JSON Export & Dashboard API

**Goal:** Structured JSON output for React dashboard consumption, Bun.serve() API.

---

### Task 12: Define Export Schema & Build Export Function

**Files:**
- Create: `src/Internal/commands/reas/lib/api-export.ts`
- Test: `src/Internal/commands/reas/__tests__/api-export.test.ts`

**Step 1: Write the failing test**

```typescript
// src/Internal/commands/reas/__tests__/api-export.test.ts
import { test, expect, describe } from "bun:test";
import { buildDashboardExport } from "../lib/api-export";
import type { DashboardExport } from "../lib/api-export";

describe("buildDashboardExport()", () => {
    const mockAnalysis = {
        comparables: {
            pricePerM2: { median: 55000, mean: 57000, p25: 48000, p75: 62000, min: 40000, max: 75000 },
            targetPercentile: 45,
            listings: [],
        },
        trends: { periods: [], yoyChange: 5.2, direction: "rising" as const },
        timeOnMarket: { median: 45, mean: 52, min: 10, max: 120, count: 15 },
        discount: { avgDiscount: -3.5, medianDiscount: -2.8, maxDiscount: -12, noDiscountCount: 3, totalCount: 15, discounts: [] },
        yield: { grossYield: 5.2, netYield: 3.8, paybackYears: 26, atMarketPrice: { price: 3300000, grossYield: 5.5, netYield: 4.0, paybackYears: 25 }, benchmarks: [] },
        rentals: [],
        mfBenchmarks: [],
        filters: { estateType: "flat" as const, constructionType: "panel", periods: [], district: { name: "Praha", reasId: 3100, srealityId: 1 } },
        target: { price: 3500000, area: 65, disposition: "2+kk", constructionType: "panel", monthlyRent: 15000, monthlyCosts: 5000, district: "Praha", districtId: 3100, srealityDistrictId: 1 },
    };

    test("produces valid DashboardExport structure", () => {
        const result = buildDashboardExport(mockAnalysis as any);
        expect(result.meta.version).toBe("1.0");
        expect(result.meta.generatedAt).toBeTruthy();
        expect(result.analysis.comparables.median).toBe(55000);
    });

    test("includes target property in meta", () => {
        const result = buildDashboardExport(mockAnalysis as any);
        expect(result.meta.target.price).toBe(3500000);
    });

    test("serializes to valid JSON", () => {
        const result = buildDashboardExport(mockAnalysis as any);
        const json = JSON.stringify(result);
        expect(() => JSON.parse(json)).not.toThrow();
    });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/Internal/commands/reas/__tests__/api-export.test.ts`
Expected: FAIL

**Step 3: Implement export schema and builder**

```typescript
// src/Internal/commands/reas/lib/api-export.ts
import type { ReasListing, SrealityRental, MfRentalBenchmark, TargetProperty, AnalysisFilters } from "../types";
import type { AggregatedRentalStats } from "../analysis/rental-aggregation";

export interface DashboardExport {
    meta: {
        generatedAt: string;
        version: "1.0";
        filters: AnalysisFilters;
        target: TargetProperty;
        providers: string[];
    };
    listings: {
        sold: Array<{
            disposition: string;
            area: number;
            price: number;
            pricePerM2: number;
            address: string;
            soldAt?: string;
            daysOnMarket?: number;
            discount?: number;
            link: string;
            source: string;
        }>;
        rentals: Array<{
            disposition: string;
            area: number;
            rent: number;
            rentPerM2: number;
            address: string;
            link: string;
            source: string;
        }>;
    };
    analysis: {
        comparables: {
            median: number;
            mean: number;
            p25: number;
            p75: number;
            count: number;
            targetPercentile: number;
        };
        trends: Array<{
            period: string;
            medianPricePerM2: number;
            count: number;
            qoqChange?: number;
        }>;
        yield: {
            grossYield: number;
            netYield: number;
            paybackYears: number;
            atMarketPrice: {
                price: number;
                grossYield: number;
                netYield: number;
                paybackYears: number;
            };
        };
        timeOnMarket: {
            median: number;
            mean: number;
            min: number;
            max: number;
        };
        discount: {
            avgDiscount: number;
            medianDiscount: number;
            maxDiscount: number;
        };
        rentalAggregation?: AggregatedRentalStats[];
        investmentScore?: {
            overall: number;
            grade: string;
            factors: Record<string, number>;
            recommendation: string;
        };
    };
    benchmarks: {
        mf: MfRentalBenchmark[];
        investmentBenchmarks: Array<{ name: string; annualReturn: number }>;
    };
}

interface FullAnalysis {
    comparables: any;
    trends: any;
    timeOnMarket: any;
    discount: any;
    yield: any;
    rentals: SrealityRental[];
    mfBenchmarks: MfRentalBenchmark[];
    filters: AnalysisFilters;
    target: TargetProperty;
    rentalAggregation?: AggregatedRentalStats[];
}

export function buildDashboardExport(analysis: FullAnalysis): DashboardExport {
    const { comparables, trends, timeOnMarket, discount, yield: yieldResult } = analysis;

    return {
        meta: {
            generatedAt: new Date().toISOString(),
            version: "1.0",
            filters: analysis.filters,
            target: analysis.target,
            providers: analysis.filters.providers ?? ["reas", "sreality", "mf"],
        },
        listings: {
            sold: (comparables.listings ?? []).map((l: any) => ({
                disposition: l.disposition,
                area: l.utilityArea ?? l.displayArea,
                price: l.soldPrice,
                pricePerM2: l.pricePerM2,
                address: l.formattedAddress,
                soldAt: l.soldAt,
                daysOnMarket: l.daysOnMarket,
                discount: l.discount,
                link: l.link ?? "",
                source: "reas",
            })),
            rentals: analysis.rentals.map((r) => ({
                disposition: r.disposition ?? "",
                area: r.area ?? 0,
                rent: r.price,
                rentPerM2: r.area ? r.price / r.area : 0,
                address: r.locality,
                link: r.link ?? "",
                source: "sreality",
            })),
        },
        analysis: {
            comparables: {
                median: comparables.pricePerM2.median,
                mean: comparables.pricePerM2.mean,
                p25: comparables.pricePerM2.p25,
                p75: comparables.pricePerM2.p75,
                count: comparables.listings?.length ?? 0,
                targetPercentile: comparables.targetPercentile,
            },
            trends: (trends.periods ?? []).map((p: any) => ({
                period: p.label,
                medianPricePerM2: p.medianPerM2,
                count: p.count,
                qoqChange: p.change,
            })),
            yield: {
                grossYield: yieldResult.grossYield,
                netYield: yieldResult.netYield,
                paybackYears: yieldResult.paybackYears,
                atMarketPrice: yieldResult.atMarketPrice,
            },
            timeOnMarket: {
                median: timeOnMarket.median,
                mean: timeOnMarket.mean,
                min: timeOnMarket.min,
                max: timeOnMarket.max,
            },
            discount: {
                avgDiscount: discount.avgDiscount,
                medianDiscount: discount.medianDiscount,
                maxDiscount: discount.maxDiscount,
            },
            rentalAggregation: analysis.rentalAggregation,
        },
        benchmarks: {
            mf: analysis.mfBenchmarks,
            investmentBenchmarks: [
                { name: "Czech govt bonds", annualReturn: 4.2 },
                { name: "S&P 500 avg", annualReturn: 10 },
                { name: "Prague avg yield", annualReturn: 3.5 },
            ],
        },
    };
}
```

**Step 4: Run tests**

Run: `bun test src/Internal/commands/reas/__tests__/api-export.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/Internal/commands/reas/lib/api-export.ts src/Internal/commands/reas/__tests__/api-export.test.ts
git commit -m "feat(reas): add JSON export schema and builder for dashboard consumption"
```

---

### Task 13: Add `--format` Flag

**Files:**
- Modify: `src/Internal/commands/reas/index.ts`

**Step 1: Add format flag to CLI**

In command registration:

```typescript
.option("--format <format>", "Output format: terminal (default), json, markdown", "terminal")
```

**Step 2: Add format routing in fetchAndAnalyze**

After running all analysis modules, before `renderReport()`:

```typescript
if (format === "json") {
    const { buildDashboardExport } = await import("./lib/api-export");
    const exportData = buildDashboardExport(fullAnalysis);
    const json = JSON.stringify(exportData, null, 2);

    if (outputPath) {
        await Bun.write(outputPath, json);
        console.log(`JSON export written to ${outputPath}`);
    } else {
        console.log(json);
    }

    return;
}

// Default: terminal report
const report = renderReport(fullAnalysis);
// ... existing output logic
```

**Step 3: Verify no TypeScript errors**

Run: `bunx --bun tsgo --noEmit 2>&1 | rg "commands/reas/"`
Expected: No errors

**Step 4: Commit**

```bash
git add src/Internal/commands/reas/index.ts
git commit -m "feat(reas): add --format json|terminal flag for dashboard export"
```

---

### Task 14: Bun.serve() Dashboard API

**Files:**
- Create: `src/Internal/commands/reas/server.ts`

**Step 1: Implement API server**

```typescript
// src/Internal/commands/reas/server.ts
import { DISTRICTS, PRAHA_DISTRICTS, getAllDistrictNames, searchDistricts } from "./data/districts";
import { buildDashboardExport } from "./lib/api-export";

const DEFAULT_PORT = 3456;

export async function startServer(port = DEFAULT_PORT) {
    const server = Bun.serve({
        port,
        async fetch(req) {
            const url = new URL(req.url);

            // CORS headers for local dev
            const headers = {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, OPTIONS",
                "Content-Type": "application/json",
            };

            if (req.method === "OPTIONS") {
                return new Response(null, { headers });
            }

            if (url.pathname === "/api/districts") {
                return Response.json(
                    { districts: getAllDistrictNames(), praha: Object.keys(PRAHA_DISTRICTS) },
                    { headers },
                );
            }

            if (url.pathname === "/api/search") {
                const q = url.searchParams.get("q") ?? "";
                const results = searchDistricts(q);
                return Response.json(results, { headers });
            }

            if (url.pathname === "/api/analysis") {
                const district = url.searchParams.get("district") ?? "Praha";
                const type = url.searchParams.get("type") ?? "brick";
                const disposition = url.searchParams.get("disposition");
                const periods = url.searchParams.get("periods")?.split(",") ?? ["2025"];
                const price = parseInt(url.searchParams.get("price") ?? "0");
                const area = parseInt(url.searchParams.get("area") ?? "0");
                const rent = parseInt(url.searchParams.get("rent") ?? "0");
                const costs = parseInt(url.searchParams.get("costs") ?? "0");

                try {
                    // Dynamically import to avoid circular deps
                    const { buildFromFlags, fetchAndAnalyze } = await import("./index");
                    const config = buildFromFlags({
                        district,
                        type,
                        disposition: disposition ?? undefined,
                        periods: periods.join(","),
                        price: price.toString(),
                        area: area.toString(),
                        rent: rent.toString(),
                        monthlyCosts: costs.toString(),
                    });

                    const analysis = await fetchAndAnalyze(config);
                    const exportData = buildDashboardExport(analysis);

                    return Response.json(exportData, { headers });
                } catch (error) {
                    return Response.json(
                        { error: error instanceof Error ? error.message : String(error) },
                        { status: 500, headers },
                    );
                }
            }

            return Response.json({ error: "Not found" }, { status: 404, headers });
        },
    });

    console.log(`REAS Dashboard API running at http://localhost:${server.port}`);
    console.log(`  GET /api/districts — list all districts`);
    console.log(`  GET /api/search?q=... — search districts`);
    console.log(`  GET /api/analysis?district=Praha&type=brick&... — run analysis`);

    return server;
}
```

**Step 2: Add `--server` flag to CLI**

In `index.ts` command registration:

```typescript
.option("--server", "Start dashboard API server")
.option("--port <port>", "Server port (default: 3456)", parseInt)
```

In `runReasAnalysis()`:

```typescript
if (options.server) {
    const { startServer } = await import("./server");
    await startServer(options.port);
    return; // Server keeps running
}
```

**Step 3: Refactor fetchAndAnalyze to be importable**

Currently `fetchAndAnalyze` is a local function in `index.ts`. Export it and `buildFromFlags` so the server can use them:

```typescript
export async function fetchAndAnalyze(config: { filters: AnalysisFilters; target: TargetProperty; refresh: boolean }): Promise<FullAnalysis> {
    // ... existing implementation
}

export function buildFromFlags(options: Record<string, any>): { filters: AnalysisFilters; target: TargetProperty; refresh: boolean } {
    // ... existing implementation
}
```

**Step 4: Verify no TypeScript errors**

Run: `bunx --bun tsgo --noEmit 2>&1 | rg "commands/reas/"`
Expected: No errors

**Step 5: Commit**

```bash
git add src/Internal/commands/reas/server.ts src/Internal/commands/reas/index.ts
git commit -m "feat(reas): add Bun.serve() dashboard API with /api/analysis, /api/districts, /api/search"
```

---

## Phase 5: Advanced Analysis

**Goal:** Investment scoring, market momentum, provider comparison.

---

### Task 15: Investment Scoring System

**Files:**
- Create: `src/Internal/commands/reas/analysis/investment-score.ts`
- Test: `src/Internal/commands/reas/__tests__/investment-score.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/Internal/commands/reas/__tests__/investment-score.test.ts
import { test, expect, describe } from "bun:test";
import { computeInvestmentScore } from "../analysis/investment-score";
import type { InvestmentScore } from "../analysis/investment-score";

describe("computeInvestmentScore()", () => {
    test("high yield + discount + rising = A grade", () => {
        const result = computeInvestmentScore({
            netYield: 5.5,        // well above bonds (4.2%)
            discount: -8,         // 8% below asking
            trendDirection: "rising",
            trendYoY: 6,          // 6% annual growth
            medianDaysOnMarket: 25, // fast selling
            districtMedianDays: 45,
        });

        expect(result.grade).toBe("A");
        expect(result.overall).toBeGreaterThanOrEqual(80);
        expect(result.recommendation).toBe("strong-buy");
    });

    test("low yield + premium + declining = D/F grade", () => {
        const result = computeInvestmentScore({
            netYield: 2.0,
            discount: 5,          // 5% premium over market
            trendDirection: "declining",
            trendYoY: -3,
            medianDaysOnMarket: 90,
            districtMedianDays: 45,
        });

        expect(["D", "F"]).toContain(result.grade);
        expect(result.overall).toBeLessThan(40);
    });

    test("average everything = B/C grade", () => {
        const result = computeInvestmentScore({
            netYield: 3.8,
            discount: -2,
            trendDirection: "stable",
            trendYoY: 1,
            medianDaysOnMarket: 50,
            districtMedianDays: 45,
        });

        expect(["B", "C"]).toContain(result.grade);
    });

    test("includes reasoning array", () => {
        const result = computeInvestmentScore({
            netYield: 5.0,
            discount: -5,
            trendDirection: "rising",
            trendYoY: 4,
            medianDaysOnMarket: 30,
            districtMedianDays: 45,
        });

        expect(result.reasoning.length).toBeGreaterThan(0);
    });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/Internal/commands/reas/__tests__/investment-score.test.ts`
Expected: FAIL

**Step 3: Implement scoring**

```typescript
// src/Internal/commands/reas/analysis/investment-score.ts

export interface InvestmentScore {
    overall: number;       // 0-100
    grade: "A" | "B" | "C" | "D" | "F";
    factors: {
        yieldScore: number;
        discountScore: number;
        trendScore: number;
        marketVelocityScore: number;
    };
    reasoning: string[];
    recommendation: "strong-buy" | "buy" | "hold" | "avoid" | "strong-avoid";
}

interface ScoreInput {
    netYield: number;
    discount: number;            // negative = below market (good)
    trendDirection: "rising" | "stable" | "declining";
    trendYoY: number;            // % year-over-year
    medianDaysOnMarket: number;
    districtMedianDays: number;
}

const BOND_YIELD = 4.2;
const PRAGUE_AVG_YIELD = 3.5;

// Weight distribution
const W_YIELD = 0.30;
const W_DISCOUNT = 0.25;
const W_TREND = 0.25;
const W_VELOCITY = 0.20;

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function scoreYield(netYield: number): { score: number; reasoning: string } {
    // 0% yield → 0 score, bond rate → 50, 2x bonds → 100
    const score = clamp((netYield / (BOND_YIELD * 2)) * 100, 0, 100);

    let reasoning: string;

    if (netYield >= BOND_YIELD * 1.5) {
        reasoning = `Excellent yield (${netYield.toFixed(1)}%) — well above bonds (${BOND_YIELD}%)`;
    } else if (netYield >= BOND_YIELD) {
        reasoning = `Good yield (${netYield.toFixed(1)}%) — above bonds (${BOND_YIELD}%)`;
    } else if (netYield >= PRAGUE_AVG_YIELD) {
        reasoning = `Average yield (${netYield.toFixed(1)}%) — near Prague average (${PRAGUE_AVG_YIELD}%)`;
    } else {
        reasoning = `Low yield (${netYield.toFixed(1)}%) — below Prague average (${PRAGUE_AVG_YIELD}%)`;
    }

    return { score, reasoning };
}

function scoreDiscount(discount: number): { score: number; reasoning: string } {
    // -15% discount → 100, 0% → 50, +15% premium → 0
    const score = clamp(50 - (discount / 15) * 50, 0, 100);

    let reasoning: string;

    if (discount <= -8) {
        reasoning = `Strong discount (${discount.toFixed(1)}%) — significant negotiation margin`;
    } else if (discount <= -3) {
        reasoning = `Moderate discount (${discount.toFixed(1)}%)`;
    } else if (discount <= 3) {
        reasoning = `Near asking price (${discount > 0 ? "+" : ""}${discount.toFixed(1)}%)`;
    } else {
        reasoning = `Premium over market (+${discount.toFixed(1)}%) — overpaying`;
    }

    return { score, reasoning };
}

function scoreTrend(direction: string, yoy: number): { score: number; reasoning: string } {
    let score: number;

    if (direction === "rising") {
        score = clamp(60 + yoy * 4, 60, 100);
    } else if (direction === "stable") {
        score = 50;
    } else {
        score = clamp(40 + yoy * 4, 0, 40);
    }

    let reasoning: string;

    if (yoy > 5) {
        reasoning = `Strong appreciation (+${yoy.toFixed(1)}% YoY) — market momentum`;
    } else if (yoy > 0) {
        reasoning = `Moderate appreciation (+${yoy.toFixed(1)}% YoY)`;
    } else if (yoy > -3) {
        reasoning = `Flat/slight decline (${yoy.toFixed(1)}% YoY)`;
    } else {
        reasoning = `Declining market (${yoy.toFixed(1)}% YoY) — capital risk`;
    }

    return { score, reasoning };
}

function scoreVelocity(days: number, districtMedian: number): { score: number; reasoning: string } {
    const ratio = days / districtMedian;
    // Faster than median → high score
    const score = clamp((1 - (ratio - 1)) * 70 + 30, 0, 100);

    let reasoning: string;

    if (days < 30) {
        reasoning = `Hot market — properties sell in ${days} days (district median: ${districtMedian})`;
    } else if (days <= districtMedian) {
        reasoning = `Normal velocity — ${days} days (district median: ${districtMedian})`;
    } else {
        reasoning = `Slow market — ${days} days (district median: ${districtMedian})`;
    }

    return { score, reasoning };
}

function gradeFromScore(score: number): "A" | "B" | "C" | "D" | "F" {
    if (score >= 80) {
        return "A";
    }

    if (score >= 65) {
        return "B";
    }

    if (score >= 50) {
        return "C";
    }

    if (score >= 35) {
        return "D";
    }

    return "F";
}

function recommendationFromScore(score: number): InvestmentScore["recommendation"] {
    if (score >= 80) {
        return "strong-buy";
    }

    if (score >= 65) {
        return "buy";
    }

    if (score >= 50) {
        return "hold";
    }

    if (score >= 35) {
        return "avoid";
    }

    return "strong-avoid";
}

export function computeInvestmentScore(input: ScoreInput): InvestmentScore {
    const yieldResult = scoreYield(input.netYield);
    const discountResult = scoreDiscount(input.discount);
    const trendResult = scoreTrend(input.trendDirection, input.trendYoY);
    const velocityResult = scoreVelocity(input.medianDaysOnMarket, input.districtMedianDays);

    const overall = Math.round(
        yieldResult.score * W_YIELD +
        discountResult.score * W_DISCOUNT +
        trendResult.score * W_TREND +
        velocityResult.score * W_VELOCITY,
    );

    return {
        overall,
        grade: gradeFromScore(overall),
        factors: {
            yieldScore: Math.round(yieldResult.score),
            discountScore: Math.round(discountResult.score),
            trendScore: Math.round(trendResult.score),
            marketVelocityScore: Math.round(velocityResult.score),
        },
        reasoning: [
            yieldResult.reasoning,
            discountResult.reasoning,
            trendResult.reasoning,
            velocityResult.reasoning,
        ],
        recommendation: recommendationFromScore(overall),
    };
}
```

**Step 4: Run tests**

Run: `bun test src/Internal/commands/reas/__tests__/investment-score.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/Internal/commands/reas/analysis/investment-score.ts src/Internal/commands/reas/__tests__/investment-score.test.ts
git commit -m "feat(reas): add A-F investment scoring system (yield, discount, trend, velocity)"
```

---

### Task 16: Market Momentum Detection

**Files:**
- Create: `src/Internal/commands/reas/analysis/market-momentum.ts`
- Test: `src/Internal/commands/reas/__tests__/market-momentum.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/Internal/commands/reas/__tests__/market-momentum.test.ts
import { test, expect, describe } from "bun:test";
import { detectMomentum } from "../analysis/market-momentum";

describe("detectMomentum()", () => {
    test("detects accelerating rise", () => {
        // Each quarter grows more than previous
        const periods = [
            { medianPerM2: 50000, count: 10 },
            { medianPerM2: 52000, count: 12 }, // +4%
            { medianPerM2: 55000, count: 11 }, // +5.8%
            { medianPerM2: 59000, count: 13 }, // +7.3%
        ];

        const result = detectMomentum(periods);
        expect(result.direction).toBe("rising");
        expect(result.momentum).toBe("accelerating");
    });

    test("detects decelerating rise", () => {
        const periods = [
            { medianPerM2: 50000, count: 10 },
            { medianPerM2: 55000, count: 12 }, // +10%
            { medianPerM2: 57000, count: 11 }, // +3.6%
            { medianPerM2: 58000, count: 13 }, // +1.8%
        ];

        const result = detectMomentum(periods);
        expect(result.direction).toBe("rising");
        expect(result.momentum).toBe("decelerating");
    });

    test("returns low confidence with < 3 periods", () => {
        const periods = [{ medianPerM2: 50000, count: 10 }];
        const result = detectMomentum(periods);
        expect(result.confidence).toBe("low");
    });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/Internal/commands/reas/__tests__/market-momentum.test.ts`
Expected: FAIL

**Step 3: Implement momentum detection**

```typescript
// src/Internal/commands/reas/analysis/market-momentum.ts

export interface MarketMomentum {
    priceVelocity: number;
    direction: "rising" | "stable" | "declining";
    momentum: "accelerating" | "linear" | "decelerating";
    confidence: "high" | "medium" | "low";
    interpretation: string;
}

interface TrendPeriodInput {
    medianPerM2: number;
    count: number;
}

export function detectMomentum(periods: TrendPeriodInput[]): MarketMomentum {
    if (periods.length < 2) {
        return {
            priceVelocity: 0,
            direction: "stable",
            momentum: "linear",
            confidence: "low",
            interpretation: "Insufficient data — need at least 2 quarters",
        };
    }

    // Calculate period-over-period changes
    const changes: number[] = [];

    for (let i = 1; i < periods.length; i++) {
        const prev = periods[i - 1].medianPerM2;
        const curr = periods[i].medianPerM2;

        if (prev > 0) {
            changes.push(((curr - prev) / prev) * 100);
        }
    }

    if (changes.length === 0) {
        return {
            priceVelocity: 0,
            direction: "stable",
            momentum: "linear",
            confidence: "low",
            interpretation: "No valid price changes to analyze",
        };
    }

    // Average velocity (% per period)
    const avgChange = changes.reduce((a, b) => a + b, 0) / changes.length;
    const lastChange = changes[changes.length - 1];

    // Direction
    let direction: MarketMomentum["direction"];

    if (avgChange > 1) {
        direction = "rising";
    } else if (avgChange < -1) {
        direction = "declining";
    } else {
        direction = "stable";
    }

    // Momentum: compare rate of change
    let momentum: MarketMomentum["momentum"] = "linear";

    if (changes.length >= 2) {
        const recentChanges = changes.slice(-2);
        const acceleration = recentChanges[1] - recentChanges[0];

        if (Math.abs(acceleration) < 0.5) {
            momentum = "linear";
        } else if ((direction === "rising" && acceleration > 0) || (direction === "declining" && acceleration < 0)) {
            momentum = "accelerating";
        } else {
            momentum = "decelerating";
        }
    }

    // Confidence based on sample sizes and period count
    const totalSamples = periods.reduce((sum, p) => sum + p.count, 0);
    let confidence: MarketMomentum["confidence"];

    if (periods.length >= 4 && totalSamples >= 30) {
        confidence = "high";
    } else if (periods.length >= 3 && totalSamples >= 15) {
        confidence = "medium";
    } else {
        confidence = "low";
    }

    // Human-readable interpretation
    const dirLabel = direction === "rising" ? "rising" : direction === "declining" ? "falling" : "flat";
    const momLabel = momentum === "accelerating" ? "accelerating" : momentum === "decelerating" ? "slowing" : "steady";

    return {
        priceVelocity: Math.round(avgChange * 10) / 10,
        direction,
        momentum,
        confidence,
        interpretation: `Market is ${dirLabel} at ${Math.abs(avgChange).toFixed(1)}%/quarter (${momLabel}). Last quarter: ${lastChange > 0 ? "+" : ""}${lastChange.toFixed(1)}%.`,
    };
}
```

**Step 4: Run tests**

Run: `bun test src/Internal/commands/reas/__tests__/market-momentum.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/Internal/commands/reas/analysis/market-momentum.ts src/Internal/commands/reas/__tests__/market-momentum.test.ts
git commit -m "feat(reas): add market momentum detection (direction + acceleration)"
```

---

### Task 17: Wire Scoring & Momentum into Report

**Files:**
- Modify: `src/Internal/commands/reas/analysis/report.ts`
- Modify: `src/Internal/commands/reas/index.ts`

**Step 1: Add investment score section to report**

In `report.ts`, add a new render function after `renderVerdict()`:

```typescript
function renderInvestmentScore(score: InvestmentScore): string {
    const gradeColors: Record<string, (s: string) => string> = {
        A: pc.green, B: pc.cyan, C: pc.yellow, D: pc.red, F: pc.red,
    };
    const colorFn = gradeColors[score.grade] ?? pc.dim;

    const lines: string[] = [
        sectionHeader("INVESTMENT SCORE"),
        "",
        `  ${pc.bold("Overall:")} ${colorFn(`${score.grade} (${score.overall}/100)`)}  —  ${pc.bold(score.recommendation.toUpperCase())}`,
        "",
        `  ${pc.dim("Factor")}                ${pc.dim("Score")}`,
        `  Yield (30%)            ${score.factors.yieldScore}/100`,
        `  Discount (25%)         ${score.factors.discountScore}/100`,
        `  Trend (25%)            ${score.factors.trendScore}/100`,
        `  Market velocity (20%)  ${score.factors.marketVelocityScore}/100`,
        "",
        ...score.reasoning.map((r) => `  • ${r}`),
    ];

    return lines.join("\n");
}
```

**Step 2: Add momentum section to report**

```typescript
function renderMomentum(momentum: MarketMomentum): string {
    const dirIcon = momentum.direction === "rising" ? "↑" : momentum.direction === "declining" ? "↓" : "→";
    const momIcon = momentum.momentum === "accelerating" ? "⚡" : momentum.momentum === "decelerating" ? "🔻" : "—";

    return [
        sectionHeader("MARKET MOMENTUM"),
        "",
        `  ${pc.bold("Direction:")} ${dirIcon} ${momentum.direction}  |  ${pc.bold("Momentum:")} ${momIcon} ${momentum.momentum}  |  ${pc.bold("Confidence:")} ${momentum.confidence}`,
        `  ${pc.bold("Velocity:")} ${momentum.priceVelocity > 0 ? "+" : ""}${momentum.priceVelocity}%/quarter`,
        "",
        `  ${pc.dim(momentum.interpretation)}`,
    ].join("\n");
}
```

**Step 3: Wire into fetchAndAnalyze in index.ts**

After existing analysis steps, add:

```typescript
import { computeInvestmentScore } from "./analysis/investment-score";
import { detectMomentum } from "./analysis/market-momentum";

// After trends and discount analysis...
const momentum = detectMomentum(trends.periods.map((p) => ({ medianPerM2: p.medianPerM2, count: p.count })));

const investmentScore = computeInvestmentScore({
    netYield: yieldResult.netYield,
    discount: discount.medianDiscount,
    trendDirection: trends.direction,
    trendYoY: trends.yoyChange ?? 0,
    medianDaysOnMarket: timeOnMarket.median,
    districtMedianDays: timeOnMarket.median, // TODO: replace with district-level data when available
});
```

Pass both to `renderReport()` and include in the output.

**Step 4: Verify no TypeScript errors**

Run: `bunx --bun tsgo --noEmit 2>&1 | rg "commands/reas/"`
Expected: No errors

**Step 5: Commit**

```bash
git add src/Internal/commands/reas/analysis/report.ts src/Internal/commands/reas/index.ts
git commit -m "feat(reas): wire investment score and market momentum into terminal report"
```

---

## Phase 6: Polish

**Goal:** Error handling, help text, final integration test.

---

### Task 18: Graceful Provider Degradation

**Files:**
- Modify: `src/Internal/commands/reas/index.ts`

**Step 1: Wrap each provider fetch in try/catch**

In `fetchAndAnalyze()`, wrap each data fetch so failure of one provider doesn't kill the whole analysis:

```typescript
const warnings: string[] = [];

// REAS sold data
let soldListings: ReasListing[] = [];
try {
    soldListings = await fetchSoldListings(filters, dateRange, refresh);
} catch (error) {
    warnings.push(`REAS: ${error instanceof Error ? error.message : String(error)}`);
}

// Sreality rentals
let rentalListings: SrealityRental[] = [];
try {
    rentalListings = await fetchRentalListings(filters, refresh);
} catch (error) {
    warnings.push(`Sreality: ${error instanceof Error ? error.message : String(error)}`);
}

// MF benchmarks
let mfData: MfRentalBenchmark[] = [];
try {
    mfData = await fetchMfRentalData(filters.district.name, refresh);
} catch (error) {
    warnings.push(`MF cenová mapa: ${error instanceof Error ? error.message : String(error)}`);
}

// Print warnings if any provider failed
if (warnings.length > 0) {
    console.log(pc.yellow(`\n⚠ Some providers returned errors (analysis continues with available data):`));
    for (const w of warnings) {
        console.log(pc.dim(`  • ${w}`));
    }
    console.log();
}
```

**Step 2: Verify no TypeScript errors**

Run: `bunx --bun tsgo --noEmit 2>&1 | rg "commands/reas/"`
Expected: No errors

**Step 3: Commit**

```bash
git add src/Internal/commands/reas/index.ts
git commit -m "feat(reas): add graceful provider degradation — continue analysis if one source fails"
```

---

### Task 19: Integration Smoke Test

**Files:**
- Create: `src/Internal/commands/reas/__tests__/integration.test.ts`

**Step 1: Write integration test**

```typescript
// src/Internal/commands/reas/__tests__/integration.test.ts
import { test, expect, describe } from "bun:test";
import { buildDashboardExport } from "../lib/api-export";

describe("Integration: full analysis → JSON export", () => {
    test("buildDashboardExport produces valid schema from mock data", () => {
        const mockAnalysis = {
            comparables: {
                pricePerM2: { median: 55000, mean: 57000, p25: 48000, p75: 62000, min: 40000, max: 75000 },
                targetPercentile: 45,
                listings: [
                    { disposition: "3+1", utilityArea: 68, soldPrice: 3740000, pricePerM2: 55000, formattedAddress: "Test 1", soldAt: "2024-06-01", daysOnMarket: 45, discount: -3, link: "https://example.com/1" },
                ],
            },
            trends: { periods: [{ label: "Q1 2024", medianPerM2: 52000, count: 8, change: null }], yoyChange: null, direction: "stable" },
            timeOnMarket: { median: 45, mean: 52, min: 10, max: 120, count: 15 },
            discount: { avgDiscount: -3.5, medianDiscount: -2.8, maxDiscount: -12, noDiscountCount: 3, totalCount: 15, discounts: [] },
            yield: { grossYield: 5.2, netYield: 3.8, paybackYears: 26, atMarketPrice: { price: 3740000, grossYield: 4.8, netYield: 3.5, paybackYears: 28 }, benchmarks: [] },
            rentals: [{ hash_id: 1, name: "Pronájem bytu 3+1 68 m²", price: 15000, locality: "Letňany", gps: { lat: 50.1, lon: 14.5 }, labels: [], disposition: "3+1", area: 68, link: "https://sreality.cz/1" }],
            mfBenchmarks: [],
            filters: { estateType: "flat" as const, constructionType: "panel", periods: [{ from: new Date("2024-01-01"), to: new Date("2024-12-31") }], district: { name: "Hradec Králové", reasId: 3602, srealityId: 28 } },
            target: { price: 3500000, area: 68, disposition: "3+1", constructionType: "panel", monthlyRent: 15000, monthlyCosts: 5000, district: "Hradec Králové", districtId: 3602, srealityDistrictId: 28 },
        };

        const exported = buildDashboardExport(mockAnalysis as any);

        // Schema validation
        expect(exported.meta.version).toBe("1.0");
        expect(exported.meta.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(exported.listings.sold.length).toBe(1);
        expect(exported.listings.rentals.length).toBe(1);
        expect(exported.analysis.comparables.median).toBe(55000);
        expect(exported.analysis.yield.grossYield).toBe(5.2);
        expect(exported.benchmarks.investmentBenchmarks.length).toBe(3);

        // Round-trip JSON
        const json = JSON.stringify(exported);
        const parsed = JSON.parse(json);
        expect(parsed.meta.version).toBe("1.0");
    });
});
```

**Step 2: Run all tests**

Run: `bun test src/Internal/commands/reas/__tests__/`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add src/Internal/commands/reas/__tests__/integration.test.ts
git commit -m "test(reas): add integration smoke test for full analysis → JSON export pipeline"
```

---

### Task 20: Final TypeScript & Lint Check

**Step 1: TypeScript check**

Run: `bunx --bun tsgo --noEmit 2>&1 | rg "commands/reas/"`
Expected: No errors

**Step 2: Run all tests**

Run: `bun test src/Internal/commands/reas/__tests__/`
Expected: ALL PASS

**Step 3: Commit any fixes if needed**

---

## Summary

| Task | Files | Phase | What |
|---|---|---|---|
| 1 | index.ts, tests | 1 | Fix Brno district ID |
| 2 | data/districts.ts, tests | 1 | Master district database (13+ cities, Praha 1-22) |
| 3 | index.ts | 1 | Wire districts into CLI wizard |
| 4 | data/disposition-map.ts, tests | 1 | Unified disposition codes |
| 5 | tests/* | 1 | Unit tests for existing analysis modules |
| 6 | api/bezrealitky-client.ts | 2 | Research + stub Bezrealitky API |
| 7 | api/ereality-client.ts, tests | 2 | eReality HTML scraper |
| 8 | analysis/rental-aggregation.ts, tests | 2 | Multi-source rental merge + dedup |
| 9 | lib/address-resolver.ts, tests | 3 | Address resolution via Sreality suggest |
| 10 | index.ts | 3 | Wire address search into CLI |
| 11 | types.ts, index.ts | 3 | Advanced filter options |
| 12 | lib/api-export.ts, tests | 4 | JSON export schema + builder |
| 13 | index.ts | 4 | `--format json` flag |
| 14 | server.ts, index.ts | 4 | Bun.serve() dashboard API |
| 15 | analysis/investment-score.ts, tests | 5 | A-F investment scoring |
| 16 | analysis/market-momentum.ts, tests | 5 | Trend velocity detection |
| 17 | report.ts, index.ts | 5 | Wire scoring + momentum into report |
| 18 | index.ts | 6 | Graceful provider degradation |
| 19 | tests/integration.test.ts | 6 | Integration smoke test |
| 20 | — | 6 | Final TS + lint check |

**Parallelizable groups:**
- Tasks 1-5 (Phase 1) are sequential
- Tasks 6, 7, 8 (Phase 2) can run in parallel after Phase 1
- Tasks 9-11 (Phase 3) depend on Task 2 (districts)
- Tasks 12-14 (Phase 4) depend on Phase 1
- Tasks 15-17 (Phase 5) can run in parallel after Phase 1
- Tasks 18-20 (Phase 6) run last

**Dependencies (ordered):**
```
Task 1 → Task 2 → Task 3
Task 2 → Task 4
Task 2 → Task 5
Task 5 → Tasks 6, 7, 8 (parallel)
Task 2 → Tasks 9, 10, 11
Tasks 5, 8 → Tasks 12, 13, 14
Task 5 → Tasks 15, 16 (parallel)
Tasks 15, 16 → Task 17
All → Tasks 18, 19, 20
```
