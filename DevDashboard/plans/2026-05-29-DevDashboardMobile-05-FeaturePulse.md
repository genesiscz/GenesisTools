# 05 — Feature: Pulse metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`. Read
> `…-00-Overview.md` and `…-ADR.md` first. Work in the `feat/dev-dashboard-mobile` worktree.
> **Depends on 04-MobileFoundation** (Expo SDK 55 scaffold: expo-router native tabs, the
> TanStack Query provider, the constructed `@devdashboard/contract` client instance, the theme
> color-resolver, and the shared expo-sqlite db handle). This plan does NOT re-scaffold any of
> those — it consumes them. The exact names of the plan-04 seams it assumes are listed in
> **Assumed plan-04 seams** below and surfaced as open questions for the 04 author to align.
>
> **ADR standing-rule #1 (search docs on demand):** the victory-native XL code in Task 5 was
> verified against context7 `/formidablelabs/victory-native-xl` on 2026-05-29 (`Area`/`CartesianChart`
> /`LinearGradient`/`useFont` shapes). Before editing any chart code, re-query context7
> (`/formidablelabs/victory-native-xl`) and `expo:building-native-ui` — victory-native XL moves fast.

**Goal:** Ship the mobile home screen at full parity with the web Pulse UI — 6 KPI cards
(CPU / memory / swap / battery / disk / wifi), live area charts + a sparkline row, a top-process
table, and network + weather cards — driven by ~1 Hz TanStack Query polling of `/api/system/pulse`
and `/api/system/pulse/history` through the `@devdashboard/contract` client, with recent history
persisted to expo-sqlite for instant cold-load and offline display.

**Architecture:** A single `app/(tabs)/index.tsx` Pulse route composes presentational components
(`KpiCard`, `MetricChart`, `SparklineRow`, `ProcessTable`, `NetworkInfo`, `WeatherCard`). Server
state comes from `usePulse()` / `usePulseHistory()` hooks wrapping TanStack Query `useQuery`
(`refetchInterval` ~1 Hz / ~10 s) over `client.system.pulse()` and
`client.system.pulseHistory(metric, minutes)`. Charts render behind a **`MetricChart`** interface
(ADR §6) with one concrete `VictoryMetricChart` (Skia GPU canvas via victory-native XL) used for both
the full area panels and the compact sparkline variant; `GraphMetricChart` / `SkiaMetricChart` are
*noted as swappable but unbuilt*. History is mirrored into a `PulseHistoryStore` (interface) whose
**pure** merge/dedupe/trim-window logic is unit-tested with `bun:test`, and whose SQLite-backed impl
seeds the chart via `initialData` before the network resolves (offline / cold-load).

**Tech Stack:** Expo SDK 55 / RN 0.83 / React 19.2, expo-router v7, **TanStack Query v5**,
**victory-native (XL v41)** + `@shopify/react-native-skia`, **expo-sqlite**, NativeWind v5 (or v4.2.4
fallback per ADR §6), `@devdashboard/contract` (the published local pkg — **not** the web `@app/*`
alias). Units: `bun:test` for the pure store logic; **Appium** (ADR §8) for the on-device E2E gate.

---

## Assumed plan-04 seams (consumed, not defined here)

These are produced by **04-MobileFoundation**. This plan imports them by the names below; if 04
diverges, update these imports (each is also in `openQuestions` for the 04 author):

| Seam | Assumed import | Used for |
|---|---|---|
| Contract client instance | `import { dashboardClient } from "@/lib/dashboard-client"` | `dashboardClient.system.pulse()` etc. (a `DashboardClient` from `@devdashboard/contract`, built with RN `fetch` + SecureStore `authHeader` + the file-04 SSE factory) |
| Query provider + online/focus wiring | provided by 04's root `_layout.tsx` (`QueryClientProvider` + `onlineManager`/`focusManager` via netinfo + AppState) | polling auto-pauses in background; this plan does NOT re-wire it |
| Theme color resolver | `import { useThemeColors } from "@/lib/theme"` → returns concrete hex/rgb for `--dd-*` tokens | Skia cannot read NativeWind classNames; chart strokes/gradients need concrete colors |
| SQLite db handle | `import { getDb } from "@/lib/db"` → `SQLiteDatabase` (sync API, `expo-sqlite`) | the `PulseHistoryStore` SQLite impl |
| Pulse route location | `app/(tabs)/index.tsx` (home tab of the native tab bar) | the Pulse screen |
| Card/surface primitive | `import { Card } from "@/components/ui/Card"` (NativeWind `dd-panel` equivalent) | every card uses it; do not restyle its surface. **Must forward `testID`, `className`, AND `style`** (KpiCard passes `style={{ flexBasis }}` for the 2-up grid) |

> **Flat layout (per project memory `feedback_flat_dashboard_layout`):** the Expo project lives at
> `DevDashboard/mobile/` with `app/`, `components/`, `lib/`, `e2e/` at the root — **no `src/` nesting**.
> The `@/` alias maps to `DevDashboard/mobile/` (set in 04's `tsconfig.json` / `babel` module-resolver).

## File Structure

**Create:**
- `DevDashboard/mobile/lib/format/units.ts` — pure formatters (`pct`, `ratioPct`, `gb`, `formatClock`, `DASH`). No `@app/*` import — reimplemented locally (mobile bundle must not pull web utils).
- `DevDashboard/mobile/lib/format/units.test.ts` — `bun:test` for the formatters.
- `DevDashboard/mobile/lib/pulse/history-store.ts` — `PulseHistoryStore` interface + pure `mergePoints` helper + the expo-sqlite-backed `SqlitePulseHistoryStore` impl.
- `DevDashboard/mobile/lib/pulse/history-store.test.ts` — `bun:test` for the **pure** `mergePoints` logic (the SQLite impl is verified by Appium, not bun).
- `DevDashboard/mobile/lib/pulse/hooks.ts` — `usePulse()`, `usePulseHistory(metric, minutes)`, `useWeather()` (TanStack Query hooks).
- `DevDashboard/mobile/components/pulse/KpiCard.tsx` — labelled KPI card.
- `DevDashboard/mobile/components/pulse/MetricChart.tsx` — the `MetricChart` interface + `VictoryMetricChart` (area + sparkline variants).
- `DevDashboard/mobile/components/pulse/SparklineRow.tsx` — horizontal row of compact sparklines.
- `DevDashboard/mobile/components/pulse/ProcessTable.tsx` — top-RAM process list.
- `DevDashboard/mobile/components/pulse/NetworkInfo.tsx` — Wi-Fi + public IP card.
- `DevDashboard/mobile/components/pulse/WeatherCard.tsx` — weather card.
- `DevDashboard/mobile/components/pulse/RangeSelector.tsx` — history time-range segmented control.
- `DevDashboard/mobile/e2e/pages/Pulse.page.ts` — Appium Page Object for the Pulse screen.
- `DevDashboard/mobile/e2e/specs/pulse.spec.ts` — Appium E2E spec (the done-gate).

**Modify:**
- `DevDashboard/mobile/app/(tabs)/index.tsx` — compose the Pulse screen (created by 04 as a placeholder; this plan fills it in).

---

### Task 1: Pure formatters (`units.ts`)

> The web `PulseGraph`/`index.tsx` pull `formatClock` from `@app/utils/format` and define
> `pct/ratioPct/gb` inline. The mobile bundle must NOT import `@app/*` (it would drag web/server
> code into the RN bundle). Reimplement the small helpers locally and unit-test them.

**Files:**
- Create: `DevDashboard/mobile/lib/format/units.ts`
- Test: `DevDashboard/mobile/lib/format/units.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "bun:test";
import { DASH, formatClock, gb, pct, ratioPct } from "@/lib/format/units";

describe("units formatters", () => {
    it("pct: one decimal with % suffix; null -> em dash", () => {
        expect(pct(12.34)).toBe("12.3%");
        expect(pct(null)).toBe(DASH);
    });

    it("ratioPct: rounded integer %; null/zero-total -> em dash", () => {
        expect(ratioPct(50, 200)).toBe("25%");
        expect(ratioPct(null, 200)).toBe(DASH);
        expect(ratioPct(50, 0)).toBe(DASH);
        expect(ratioPct(50, null)).toBe(DASH);
    });

    it("gb: bytes -> one-decimal GB; null -> em dash", () => {
        expect(gb(1024 ** 3 * 2)).toBe("2.0 GB");
        expect(gb(null)).toBe(DASH);
    });

    it("formatClock: ISO string -> HH:MM 24h; null -> em dash", () => {
        expect(formatClock("2026-05-29T08:05:00.000Z", "UTC")).toBe("08:05");
        expect(formatClock(null)).toBe(DASH);
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test DevDashboard/mobile/lib/format/units.test.ts`
Expected: FAIL — `Cannot find module "@/lib/format/units"`.

- [ ] **Step 3: Implement the formatters (full code)**

```typescript
export const DASH = "—";

export function pct(value: number | null): string {
    if (value === null) {
        return DASH;
    }

    return `${value.toFixed(1)}%`;
}

export function ratioPct(used: number | null, total: number | null): string {
    if (used === null || !total) {
        return DASH;
    }

    return `${Math.round((used / total) * 100)}%`;
}

export function gb(bytes: number | null): string {
    if (bytes === null) {
        return DASH;
    }

    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function formatClock(iso: string | null, timeZone?: string): string {
    if (!iso) {
        return DASH;
    }

    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
        return DASH;
    }

    return new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        ...(timeZone ? { timeZone } : {}),
    }).format(date);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test DevDashboard/mobile/lib/format/units.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add DevDashboard/mobile/lib/format/units.ts DevDashboard/mobile/lib/format/units.test.ts
git commit -m "feat(dd-mobile): pure pulse formatters (no @app/* in RN bundle)"
```

---

### Task 2: Pure history merge logic + `PulseHistoryStore` interface

> **Why split:** you cannot `bun:test` a native module (expo-sqlite). So the **pure** merge /
> dedupe / trim-to-window logic lives in its own exported function `mergePoints` and is fully
> unit-tested; the SQLite-backed `SqlitePulseHistoryStore` is a thin wrapper verified on-device by
> the Appium spec (Task 9). `PulsePoint.ts` is a **string** (ISO) in the contract — `mergePoints`
> dedupes on the `ts` string and trims by parsing it once.

**Files:**
- Create: `DevDashboard/mobile/lib/pulse/history-store.ts`
- Test: `DevDashboard/mobile/lib/pulse/history-store.test.ts`

- [ ] **Step 1: Write the failing test (pure logic only)**

```typescript
import { describe, expect, it } from "bun:test";
import { mergePoints } from "@/lib/pulse/history-store";
import type { PulsePoint } from "@devdashboard/contract";

const p = (ts: string, value: number): PulsePoint => ({ ts, value });

describe("mergePoints", () => {
    it("appends new points after existing ones in ascending ts order", () => {
        const existing = [p("2026-05-29T08:00:00.000Z", 10)];
        const incoming = [p("2026-05-29T08:01:00.000Z", 20)];
        const out = mergePoints({ existing, incoming, windowMinutes: 60, now: Date.parse("2026-05-29T08:01:00.000Z") });
        expect(out.map((x) => x.value)).toEqual([10, 20]);
    });

    it("dedupes on ts, preferring the incoming value", () => {
        const existing = [p("2026-05-29T08:00:00.000Z", 10)];
        const incoming = [p("2026-05-29T08:00:00.000Z", 99)];
        const out = mergePoints({ existing, incoming, windowMinutes: 60, now: Date.parse("2026-05-29T08:00:00.000Z") });
        expect(out).toEqual([p("2026-05-29T08:00:00.000Z", 99)]);
    });

    it("trims points older than windowMinutes relative to now", () => {
        const existing = [
            p("2026-05-29T07:00:00.000Z", 1), // 61 min old -> dropped
            p("2026-05-29T07:30:00.000Z", 2), // 31 min old -> kept
        ];
        const out = mergePoints({ existing, incoming: [], windowMinutes: 60, now: Date.parse("2026-05-29T08:01:00.000Z") });
        expect(out.map((x) => x.value)).toEqual([2]);
    });

    it("sorts mixed-order input ascending by ts", () => {
        const existing = [p("2026-05-29T08:02:00.000Z", 3)];
        const incoming = [p("2026-05-29T08:00:00.000Z", 1), p("2026-05-29T08:01:00.000Z", 2)];
        const out = mergePoints({ existing, incoming, windowMinutes: 60, now: Date.parse("2026-05-29T08:02:00.000Z") });
        expect(out.map((x) => x.value)).toEqual([1, 2, 3]);
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test DevDashboard/mobile/lib/pulse/history-store.test.ts`
Expected: FAIL — `mergePoints` is not exported.

- [ ] **Step 3: Implement `mergePoints` + the interface + SQLite impl (full code)**

```typescript
import type { PulsePoint } from "@devdashboard/contract";
import type { SQLiteDatabase } from "expo-sqlite";

export interface MergePointsArgs {
    existing: PulsePoint[];
    incoming: PulsePoint[];
    windowMinutes: number;
    now: number;
}

/** Pure: union existing+incoming, dedupe by ts (incoming wins), trim to window, sort ascending. */
export function mergePoints({ existing, incoming, windowMinutes, now }: MergePointsArgs): PulsePoint[] {
    const byTs = new Map<string, PulsePoint>();
    for (const point of existing) {
        byTs.set(point.ts, point);
    }

    for (const point of incoming) {
        byTs.set(point.ts, point);
    }

    const cutoff = now - windowMinutes * 60_000;
    const kept: PulsePoint[] = [];
    for (const point of byTs.values()) {
        const t = Date.parse(point.ts);
        if (!Number.isNaN(t) && t >= cutoff) {
            kept.push(point);
        }
    }

    kept.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    return kept;
}

export interface PulseHistoryStore {
    /** Read the cached series for instant cold-load / offline. */
    read(metric: string, windowMinutes: number): PulsePoint[];
    /** Merge a freshly-fetched series into the cache and persist. */
    write(metric: string, points: PulsePoint[], windowMinutes: number): PulsePoint[];
}

const CREATE_TABLE =
    "CREATE TABLE IF NOT EXISTS pulse_history (metric TEXT NOT NULL, ts TEXT NOT NULL, value REAL NOT NULL, PRIMARY KEY (metric, ts))";

export class SqlitePulseHistoryStore implements PulseHistoryStore {
    constructor(private readonly db: SQLiteDatabase) {
        this.db.execSync(CREATE_TABLE);
    }

    read(metric: string, windowMinutes: number): PulsePoint[] {
        const cutoffIso = new Date(Date.now() - windowMinutes * 60_000).toISOString();
        const rows = this.db.getAllSync<{ ts: string; value: number }>(
            "SELECT ts, value FROM pulse_history WHERE metric = ? AND ts >= ? ORDER BY ts ASC",
            [metric, cutoffIso],
        );
        return rows.map((r) => ({ ts: r.ts, value: r.value }));
    }

    write(metric: string, points: PulsePoint[], windowMinutes: number): PulsePoint[] {
        const merged = mergePoints({
            existing: this.read(metric, windowMinutes),
            incoming: points,
            windowMinutes,
            now: Date.now(),
        });

        this.db.withTransactionSync(() => {
            const cutoffIso = new Date(Date.now() - windowMinutes * 60_000).toISOString();
            this.db.runSync("DELETE FROM pulse_history WHERE metric = ? AND ts < ?", [metric, cutoffIso]);
            for (const point of merged) {
                this.db.runSync(
                    "INSERT OR REPLACE INTO pulse_history (metric, ts, value) VALUES (?, ?, ?)",
                    [metric, point.ts, point.value],
                );
            }
        });

        return merged;
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test DevDashboard/mobile/lib/pulse/history-store.test.ts`
Expected: PASS (4 tests). The SQLite class is imported but never instantiated in this test, so
`expo-sqlite` is never loaded — `bun:test` stays green without a native module.

- [ ] **Step 5: Typecheck**

Run: `bunx tsgo --noEmit | rg "pulse/history-store"`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add DevDashboard/mobile/lib/pulse/history-store.ts DevDashboard/mobile/lib/pulse/history-store.test.ts
git commit -m "feat(dd-mobile): pure mergePoints + SqlitePulseHistoryStore (offline pulse cache)"
```

---

### Task 3: TanStack Query hooks (`hooks.ts`)

> ~1 Hz live snapshot (`refetchInterval: 1000`, matching ADR M1 "live Pulse metrics updating ~1 Hz"),
> ~10 s history (60 s for the 24 h range), 10 min weather. History hooks seed the chart from the
> SQLite store via `initialData` so the chart paints instantly on cold launch, then `write` the
> fresh series back on every successful fetch. **Background pause** (online/focus manager) is wired
> by plan-04's provider — do NOT re-implement it here.

**Files:**
- Create: `DevDashboard/mobile/lib/pulse/hooks.ts`

- [ ] **Step 1: Implement the hooks (full code)**

```typescript
import type { PulseSeries, PulseSnapshot, WeatherSnapshot } from "@devdashboard/contract";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { dashboardClient } from "@/lib/dashboard-client";
import { getDb } from "@/lib/db";
import { SqlitePulseHistoryStore } from "@/lib/pulse/history-store";

export const SNAP_INTERVAL_MS = 1000;
export const HISTORY_INTERVAL_MS = 10_000;
export const HISTORY_INTERVAL_LONG_MS = 60_000;
export const WEATHER_INTERVAL_MS = 600_000;

function useHistoryStore(): SqlitePulseHistoryStore {
    return useMemo(() => new SqlitePulseHistoryStore(getDb()), []);
}

export function usePulse() {
    return useQuery<PulseSnapshot>({
        queryKey: ["pulse", "snap"],
        queryFn: () => dashboardClient.system.pulse(),
        refetchInterval: SNAP_INTERVAL_MS,
    });
}

export function usePulseHistory(metric: string, minutes: number) {
    const store = useHistoryStore();

    return useQuery<PulseSeries>({
        queryKey: ["pulse", "history", metric, minutes],
        queryFn: async () => {
            const series = await dashboardClient.system.pulseHistory(metric, minutes);
            const merged = store.write(metric, series.points, minutes);
            return { metric, points: merged };
        },
        // Cold-load / offline: paint the cached series before the network resolves.
        initialData: (): PulseSeries => ({ metric, points: store.read(metric, minutes) }),
        initialDataUpdatedAt: 0,
        refetchInterval: minutes >= 1440 ? HISTORY_INTERVAL_LONG_MS : HISTORY_INTERVAL_MS,
    });
}

export function useWeather() {
    return useQuery<WeatherSnapshot>({
        queryKey: ["weather"],
        queryFn: () => dashboardClient.weather.snapshot(),
        refetchInterval: WEATHER_INTERVAL_MS,
    });
}
```

> **NOTE (soft dependency on 03):** `client.weather.snapshot()` and the `WeatherSnapshot` export
> name are NOT concretely pinned in plan 03 (weather sits inside 03's "…same pattern" comment, and
> 03's `WeatherRes = Weather` conflicts with the lib type `WeatherSnapshot`). This plan assumes
> `client.weather.snapshot(): Promise<WeatherSnapshot>` with the `WeatherSnapshot` shape from
> `src/dev-dashboard/lib/weather/types.ts`. If 03 lands a different method/type name, adjust this
> one call site. Surfaced in `openQuestions`.

- [ ] **Step 2: Typecheck**

Run: `bunx tsgo --noEmit | rg "pulse/hooks"`
Expected: no errors (modulo the assumed plan-04 imports resolving once 04 lands).

- [ ] **Step 3: Commit**

```bash
git add DevDashboard/mobile/lib/pulse/hooks.ts
git commit -m "feat(dd-mobile): pulse/history/weather query hooks (1Hz poll + sqlite seed)"
```

---

### Task 4: `KpiCard`, `NetworkInfo`, `ProcessTable`, `WeatherCard`, `RangeSelector`

> Direct presentational ports of the web `components/pulse/*`. Each carries an **`accessibilityLabel`
> + `testID`** so the Appium `PulsePage` can locate it (Skia/RN canvases are opaque to the a11y tree,
> so testIDs are mandatory — bake them in now). Colors come from `useThemeColors()` (the plan-04
> token resolver), NOT inline `var(--dd-*)` (RN has no CSS vars).

**Files:**
- Create: `DevDashboard/mobile/components/pulse/KpiCard.tsx`
- Create: `DevDashboard/mobile/components/pulse/NetworkInfo.tsx`
- Create: `DevDashboard/mobile/components/pulse/ProcessTable.tsx`
- Create: `DevDashboard/mobile/components/pulse/WeatherCard.tsx`
- Create: `DevDashboard/mobile/components/pulse/RangeSelector.tsx`

- [ ] **Step 1: `KpiCard.tsx` (full code)**

```typescript
import { Text, View } from "react-native";
import { Card } from "@/components/ui/Card";
import { useThemeColors } from "@/lib/theme";

interface KpiCardProps {
    label: string;
    value: string;
    sub?: string;
    testID: string;
}

export function KpiCard({ label, value, sub, testID }: KpiCardProps) {
    const c = useThemeColors();

    return (
        // RN/Yoga note: flex-1 + flexWrap does NOT give the web's grid-cols-2 (it collapses to one
        // card per row). Use a percentage basis so two cards sit per row with `gap` between.
        <Card testID={testID} className="gap-1 p-4" style={{ flexBasis: "48%", flexGrow: 1 }}>
            <Text
                accessibilityLabel={`${label} label`}
                className="text-xs uppercase tracking-widest"
                style={{ color: c.textMuted, fontFamily: "monospace" }}
            >
                {label}
            </Text>
            <Text
                testID={`${testID}-value`}
                className="text-2xl font-bold"
                style={{ color: c.textPrimary, fontFamily: "monospace" }}
            >
                {value}
            </Text>
            {sub ? (
                <Text className="text-xs" style={{ color: c.textSecondary, fontFamily: "monospace" }}>
                    {sub}
                </Text>
            ) : null}
        </Card>
    );
}
```

- [ ] **Step 2: `NetworkInfo.tsx` (full code)**

```typescript
import { Text, View } from "react-native";
import { Card } from "@/components/ui/Card";
import { DASH } from "@/lib/format/units";
import { useThemeColors } from "@/lib/theme";

interface NetworkInfoProps {
    wifiSsid: string | null;
    publicIp: string | null;
}

export function NetworkInfo({ wifiSsid, publicIp }: NetworkInfoProps) {
    const c = useThemeColors();

    function Row({ label, value }: { label: string; value: string | null }) {
        return (
            <View className="flex-row items-center justify-between">
                <Text style={{ color: c.textMuted, fontFamily: "monospace" }}>{label}</Text>
                <Text style={{ color: c.textPrimary, fontFamily: "monospace" }}>{value ?? DASH}</Text>
            </View>
        );
    }

    return (
        <Card testID="pulse-network-card" className="gap-2 p-4">
            <Text accessibilityRole="header" className="mb-1 text-sm font-bold tracking-widest" style={{ color: c.accent }}>
                NETWORK
            </Text>
            <Row label="Wi-Fi" value={wifiSsid} />
            <Row label="Public IP" value={publicIp} />
        </Card>
    );
}
```

- [ ] **Step 3: `ProcessTable.tsx` (full code)**

```typescript
import { Text, View } from "react-native";
import type { TopProcess } from "@devdashboard/contract";
import { Card } from "@/components/ui/Card";
import { DASH } from "@/lib/format/units";
import { useThemeColors } from "@/lib/theme";

interface ProcessTableProps {
    processes: TopProcess[];
}

export function ProcessTable({ processes }: ProcessTableProps) {
    const c = useThemeColors();

    return (
        <Card testID="pulse-process-table" className="p-4">
            <Text accessibilityRole="header" className="mb-3 text-sm font-bold tracking-widest" style={{ color: c.accent }}>
                TOP RAM
            </Text>
            {processes.length === 0 ? (
                <Text style={{ color: c.textMuted, fontFamily: "monospace" }}>{DASH}</Text>
            ) : (
                <View className="gap-2">
                    {processes.map((p) => (
                        <View key={p.pid} className="flex-row items-center justify-between">
                            <Text numberOfLines={1} className="flex-1 pr-2" style={{ color: c.textSecondary, fontFamily: "monospace" }}>
                                {p.name}
                            </Text>
                            <Text style={{ color: c.textPrimary, fontFamily: "monospace" }}>
                                {(p.rssBytes / 1024 / 1024).toFixed(0)} MB
                            </Text>
                        </View>
                    ))}
                </View>
            )}
        </Card>
    );
}
```

- [ ] **Step 4: `WeatherCard.tsx` (full code)**

```typescript
import { Text, View } from "react-native";
import { Card } from "@/components/ui/Card";
import { DASH, formatClock } from "@/lib/format/units";
import { useThemeColors } from "@/lib/theme";

interface WeatherCardProps {
    tempC: number | null;
    description: string;
    sunrise: string | null;
    sunset: string | null;
    label: string;
    error?: string;
}

export function WeatherCard({ tempC, description, sunrise, sunset, label, error }: WeatherCardProps) {
    const c = useThemeColors();

    return (
        <Card testID="pulse-weather-card" className="gap-2 p-4">
            <Text accessibilityRole="header" className="text-sm font-bold tracking-widest" style={{ color: c.accent }}>
                WEATHER
            </Text>
            <Text className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                {label}
            </Text>
            {error ? (
                <Text style={{ color: c.textMuted, fontFamily: "monospace" }}>Unavailable</Text>
            ) : (
                <>
                    <Text className="text-3xl font-bold" style={{ color: c.textPrimary, fontFamily: "monospace" }}>
                        {tempC === null ? DASH : `${tempC.toFixed(1)}°C`}
                    </Text>
                    <Text style={{ color: c.textSecondary, fontFamily: "monospace" }}>{description || DASH}</Text>
                    <View className="mt-1 flex-row justify-between">
                        <Text className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>↑ {formatClock(sunrise)}</Text>
                        <Text className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>↓ {formatClock(sunset)}</Text>
                    </View>
                </>
            )}
        </Card>
    );
}
```

- [ ] **Step 5: `RangeSelector.tsx` (full code)**

```typescript
import { Pressable, Text, View } from "react-native";
import { useThemeColors } from "@/lib/theme";

export const HISTORY_RANGES = [
    { label: "30m", minutes: 30 },
    { label: "2h", minutes: 120 },
    { label: "6h", minutes: 360 },
    { label: "24h", minutes: 1440 },
] as const;

interface RangeSelectorProps {
    value: number;
    onChange: (minutes: number) => void;
}

export function RangeSelector({ value, onChange }: RangeSelectorProps) {
    const c = useThemeColors();

    return (
        <View testID="pulse-range-selector" className="flex-row gap-1 self-end rounded-lg p-1" style={{ backgroundColor: c.bgPanel }}>
            {HISTORY_RANGES.map(({ label, minutes }) => {
                const active = minutes === value;
                return (
                    <Pressable
                        key={minutes}
                        testID={`pulse-range-${minutes}`}
                        accessibilityRole="button"
                        accessibilityState={{ selected: active }}
                        onPress={() => onChange(minutes)}
                        className="rounded-md px-3 py-1"
                        style={{ backgroundColor: active ? c.accentMuted : "transparent" }}
                    >
                        <Text className="text-xs font-bold" style={{ color: active ? c.accent : c.textMuted, fontFamily: "monospace" }}>
                            {label}
                        </Text>
                    </Pressable>
                );
            })}
        </View>
    );
}
```

- [ ] **Step 6: Typecheck**

Run: `bunx tsgo --noEmit | rg "components/pulse/(KpiCard|NetworkInfo|ProcessTable|WeatherCard|RangeSelector)"`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add DevDashboard/mobile/components/pulse/KpiCard.tsx \
  DevDashboard/mobile/components/pulse/NetworkInfo.tsx \
  DevDashboard/mobile/components/pulse/ProcessTable.tsx \
  DevDashboard/mobile/components/pulse/WeatherCard.tsx \
  DevDashboard/mobile/components/pulse/RangeSelector.tsx
git commit -m "feat(dd-mobile): pulse KPI/network/process/weather/range presentational cards"
```

---

### Task 5: `MetricChart` interface + `VictoryMetricChart` (area + sparkline)

> ADR §6: charts sit behind a **`MetricChart`** interface; the concrete impl is **`VictoryMetricChart`**
> (victory-native XL, Skia GPU). `GraphMetricChart` (react-native-graph) and `SkiaMetricChart`
> (hand-drawn Skia) are **swappable but NOT built here** — only noted, with the registration seam
> ready. **Skia cannot read NativeWind classNames** — chart stroke/gradient colors are concrete
> values from `useThemeColors()`. The interface uses **`ts: number`** (epoch ms); the page maps the
> contract's `PulsePoint.ts` (ISO string) → `Date.parse(...)` before passing in (the
> string→number mismatch is handled explicitly at the page, Task 6).
>
> **Install (per ADR install rule — `npx expo install`, NOT `bun add`):**
> `npx expo install victory-native @shopify/react-native-skia react-native-reanimated react-native-worklets react-native-gesture-handler`
victory-native `useFont(require(...))` needs a real font file for axis tick labels. Use the
idiomatic Expo Google Fonts package rather than vendoring a hand-downloaded `.ttf` (verified
`@expo-google-fonts/inter@0.4.2` ships `Inter_500Medium.ttf`, 2026-05-29). Verified victory-native
API shape against context7 `/formidablelabs/victory-native-xl` 2026-05-29 — re-verify before editing.

**Files:**
- Create: `DevDashboard/mobile/components/pulse/MetricChart.tsx`

- [ ] **Step 1: Add the font package**

Run:
```bash
cd DevDashboard/mobile && npx expo install @expo-google-fonts/inter
```
Expected: `@expo-google-fonts/inter` added to `package.json`. The `MetricChart` below imports
`Inter_500Medium.ttf` from it via `require` — no vendored asset file, no guessed download URL.

- [ ] **Step 2: Implement `MetricChart.tsx` (full code)**

```typescript
import { LinearGradient, useFont, vec } from "@shopify/react-native-skia";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { Area, CartesianChart } from "victory-native";
// @expo-google-fonts/inter ships the raw .ttf; require() yields the Metro asset useFont needs.
import interMedium from "@expo-google-fonts/inter/Inter_500Medium.ttf";
import { Card } from "@/components/ui/Card";
import { formatClock } from "@/lib/format/units";
import { useThemeColors } from "@/lib/theme";

/** A single plotted point. ts is epoch ms (page maps ISO -> Date.parse before passing). */
export interface MetricPoint {
    ts: number;
    value: number;
}

/** ADR §6 chart contract. VictoryMetricChart / GraphMetricChart / SkiaMetricChart implement this. */
export interface MetricChartProps {
    title: string;
    points: MetricPoint[];
    unit?: string;
    domain?: [number, number];
    /** "area" = full panel with axes + gradient; "sparkline" = compact, no axes. */
    variant?: "area" | "sparkline";
    /** testID for the chart container (Appium locates this; the Skia canvas itself is opaque). */
    testID: string;
}

const AREA_HEIGHT = 180;
const SPARK_HEIGHT = 56;

export function VictoryMetricChart({ title, points, unit, domain = [0, 100], variant = "area", testID }: MetricChartProps) {
    const c = useThemeColors();
    const font = useFont(interMedium, 10);

    const data = useMemo(() => points.map((p) => ({ ts: p.ts, value: Math.round(p.value * 10) / 10 })), [points]);
    const isSpark = variant === "sparkline";
    const height = isSpark ? SPARK_HEIGHT : AREA_HEIGHT;

    const chart = (
        <View testID={testID} accessibilityLabel={`${title} chart`} style={{ height }}>
            {data.length === 0 ? (
                <View className="flex-1 items-center justify-center">
                    <Text style={{ color: c.textMuted, fontFamily: "monospace" }}>—</Text>
                </View>
            ) : (
                <CartesianChart
                    data={data}
                    xKey="ts"
                    yKeys={["value"]}
                    domain={{ y: domain }}
                    padding={isSpark ? 0 : 4}
                    xAxis={
                        isSpark
                            ? undefined
                            : {
                                  font,
                                  lineColor: c.border,
                                  labelColor: c.textMuted,
                                  // x is epoch-ms; render clock time, not the raw number.
                                  formatXLabel: (ms: number) => formatClock(new Date(ms).toISOString()),
                              }
                    }
                    yAxis={
                        isSpark
                            ? undefined
                            : [{ font, lineColor: c.border, labelColor: c.textMuted, formatYLabel: (v: number) => `${v}${unit ?? ""}` }]
                    }
                >
                    {({ points: chartPoints, chartBounds }) => (
                        <Area
                            points={chartPoints.value}
                            y0={chartBounds.bottom}
                            color={c.accent}
                            curveType="natural"
                            animate={{ type: "timing", duration: 300 }}
                        >
                            <LinearGradient
                                start={vec(0, 0)}
                                end={vec(0, height)}
                                colors={[c.accentGradientFrom, c.accentGradientTo]}
                            />
                        </Area>
                    )}
                </CartesianChart>
            )}
        </View>
    );

    if (isSpark) {
        return (
            <View testID={`${testID}-wrap`} className="flex-1 gap-1">
                <Text className="text-xs uppercase tracking-widest" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                    {title}
                </Text>
                {chart}
            </View>
        );
    }

    return (
        <Card testID={`${testID}-card`} className="p-4">
            <Text accessibilityRole="header" className="mb-3 text-sm font-bold tracking-widest" style={{ color: c.accent }}>
                {title}
            </Text>
            {chart}
        </Card>
    );
}

// MetricChart = the active impl. Swap to GraphMetricChart (react-native-graph, sparklines) or
// SkiaMetricChart (hand-drawn @shopify/react-native-skia escape hatch) here — both implement
// MetricChartProps; neither is built in this plan (ADR §6 "swappable but unbuilt"). The registration
// seam is this single re-export, so a switch touches one line, not feature code.
export const MetricChart = VictoryMetricChart;
```

> **`.ttf` import typing:** RN's Metro bundles `require("*.ttf")` to a numeric asset id; if tsgo
> flags `interMedium`, add `declare module "*.ttf";` to `DevDashboard/mobile/types/assets.d.ts`
> (created by 04; if absent, create it with that single line). victory-native's `useFont` accepts the
> required asset (`DataSourceParam`).

- [ ] **Step 3: Typecheck**

Run: `bunx tsgo --noEmit | rg "components/pulse/MetricChart"`
Expected: no errors (modulo plan-04 imports + the `*.ttf` shim).

- [ ] **Step 4: Commit**

```bash
git add DevDashboard/mobile/components/pulse/MetricChart.tsx DevDashboard/mobile/package.json
git commit -m "feat(dd-mobile): MetricChart interface + VictoryMetricChart (area + sparkline, Skia)"
```

---

### Task 6: `SparklineRow` + compose the Pulse screen (`index.tsx`)

> Assembles everything: 6 KPI cards (CPU / memory / swap / battery / **disk** / **wifi** — the brief
> requires 6; the web renders only 4, so disk + wifi are NEW here), the range selector, the two area
> charts (CPU + memory-free), a sparkline row, weather, network, and process table. **The ISO→epoch
> map happens here** (`PulsePoint.ts` string → `MetricPoint.ts` number).

**Files:**
- Create: `DevDashboard/mobile/components/pulse/SparklineRow.tsx`
- Modify: `DevDashboard/mobile/app/(tabs)/index.tsx`

- [ ] **Step 1: `SparklineRow.tsx` (full code)**

```typescript
import { View } from "react-native";
import { MetricChart, type MetricPoint } from "@/components/pulse/MetricChart";

interface SparklineRowProps {
    cpu: MetricPoint[];
    memFree: MetricPoint[];
    swap: MetricPoint[];
}

export function SparklineRow({ cpu, memFree, swap }: SparklineRowProps) {
    return (
        <View testID="pulse-sparkline-row" className="flex-row gap-3">
            <MetricChart testID="spark-cpu" title="CPU" points={cpu} unit="%" variant="sparkline" />
            <MetricChart testID="spark-mem" title="MEM FREE" points={memFree} unit="%" variant="sparkline" />
            <MetricChart testID="spark-swap" title="SWAP" points={swap} unit="%" variant="sparkline" />
        </View>
    );
}
```

- [ ] **Step 2: Compose `app/(tabs)/index.tsx` (full code)**

```typescript
import { useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { PulsePoint } from "@devdashboard/contract";
import { KpiCard } from "@/components/pulse/KpiCard";
import { type MetricPoint, MetricChart } from "@/components/pulse/MetricChart";
import { NetworkInfo } from "@/components/pulse/NetworkInfo";
import { ProcessTable } from "@/components/pulse/ProcessTable";
import { HISTORY_RANGES, RangeSelector } from "@/components/pulse/RangeSelector";
import { SparklineRow } from "@/components/pulse/SparklineRow";
import { WeatherCard } from "@/components/pulse/WeatherCard";
import { DASH, gb, pct, ratioPct } from "@/lib/format/units";
import { usePulse, usePulseHistory, useWeather } from "@/lib/pulse/hooks";
import { useThemeColors } from "@/lib/theme";

function toMetricPoints(points: PulsePoint[]): MetricPoint[] {
    return points
        .map((p) => ({ ts: Date.parse(p.ts), value: p.value }))
        .filter((p) => !Number.isNaN(p.ts));
}

export default function PulseScreen() {
    const c = useThemeColors();
    const insets = useSafeAreaInsets();
    const [rangeMinutes, setRangeMinutes] = useState<number>(HISTORY_RANGES[0].minutes);

    const snap = usePulse();
    const cpuHistory = usePulseHistory("cpu", rangeMinutes);
    const memHistory = usePulseHistory("mem_free", rangeMinutes);
    const swapHistory = usePulseHistory("swap", rangeMinutes);
    const weather = useWeather();

    const s = snap.data;
    const cpuPoints = useMemo(() => toMetricPoints(cpuHistory.data?.points ?? []), [cpuHistory.data]);
    const memPoints = useMemo(() => toMetricPoints(memHistory.data?.points ?? []), [memHistory.data]);
    const swapPoints = useMemo(() => toMetricPoints(swapHistory.data?.points ?? []), [swapHistory.data]);

    if (snap.isLoading && !s) {
        return (
            <View testID="pulse-loading" className="flex-1 items-center justify-center">
                <ActivityIndicator color={c.accent} />
                <Text className="mt-2" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                    Loading system pulse…
                </Text>
            </View>
        );
    }

    const memValue = s?.memFreePct != null ? `${s.memFreePct}% free` : ratioPct(s?.memUsedBytes ?? null, s?.memTotalBytes ?? null);
    const memSub =
        s?.memFreePct != null
            ? `${gb((s.memTotalBytes ?? 0) * (1 - s.memFreePct / 100))} used · ${gb(s?.memTotalBytes ?? null)} total`
            : `${gb(s?.memUsedBytes ?? null)} / ${gb(s?.memTotalBytes ?? null)}`;

    return (
        <ScrollView
            testID="pulse-screen"
            contentContainerStyle={{ padding: 16, paddingTop: insets.top + 8, gap: 16 }}
            className="flex-1"
        >
            <Text accessibilityRole="header" className="text-2xl font-bold tracking-widest" style={{ color: c.accent }}>
                SYSTEM PULSE_
            </Text>

            <View testID="pulse-kpi-grid" className="flex-row flex-wrap gap-3">
                <KpiCard testID="kpi-cpu" label="CPU" value={pct(s?.cpuPct ?? null)} />
                <KpiCard testID="kpi-mem" label="Memory" value={memValue} sub={memSub} />
                <KpiCard testID="kpi-swap" label="Swap" value={ratioPct(s?.swapUsedBytes ?? null, s?.swapTotalBytes ?? null)} sub={gb(s?.swapUsedBytes ?? null)} />
                <KpiCard testID="kpi-battery" label="Battery" value={s?.batteryPct == null ? DASH : `${s.batteryPct}%`} sub={s?.batteryState ?? undefined} />
                <KpiCard
                    testID="kpi-disk"
                    label="Disk"
                    value={ratioPct(
                        s?.diskTotalBytes != null && s?.diskFreeBytes != null ? s.diskTotalBytes - s.diskFreeBytes : null,
                        s?.diskTotalBytes ?? null,
                    )}
                    sub={`${gb(s?.diskFreeBytes ?? null)} free`}
                />
                <KpiCard testID="kpi-wifi" label="Wi-Fi" value={s?.wifiSsid ?? DASH} sub={s?.publicIp ?? undefined} />
            </View>

            <SparklineRow cpu={cpuPoints} memFree={memPoints} swap={swapPoints} />

            <RangeSelector value={rangeMinutes} onChange={setRangeMinutes} />
            <MetricChart testID="chart-cpu" title="CPU" points={cpuPoints} unit="%" />
            <MetricChart testID="chart-mem" title="MEMORY FREE" points={memPoints} unit="%" />

            <WeatherCard
                tempC={weather.data?.tempC ?? null}
                description={weather.data?.description ?? ""}
                sunrise={weather.data?.sunrise ?? null}
                sunset={weather.data?.sunset ?? null}
                label={weather.data?.label ?? ""}
                error={weather.data?.error}
            />
            <NetworkInfo wifiSsid={s?.wifiSsid ?? null} publicIp={s?.publicIp ?? null} />
            <ProcessTable processes={s?.topProcesses ?? []} />
        </ScrollView>
    );
}
```

> **`swap` history metric (verified persisted):** the sparkline row plots `cpu`, `mem_free`, `swap`.
> The web only requests `cpu` + `mem_free`, but `src/dev-dashboard/lib/system/poller.ts:81` already
> records `history.record("swap", (swapUsed/swapTotal) * 100)` (0–100 %), and
> `/api/system/pulse/history?metric=swap&minutes=…` returns it via `getSeries`. So `metric=swap`
> with `domain [0,100]` is valid — no server change needed. (`mem_free` is also recorded at
> `poller.ts:77`.)

- [ ] **Step 3: Typecheck**

Run: `bunx tsgo --noEmit | rg "(components/pulse/SparklineRow|app/\(tabs\)/index)"`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add DevDashboard/mobile/components/pulse/SparklineRow.tsx "DevDashboard/mobile/app/(tabs)/index.tsx"
git commit -m "feat(dd-mobile): compose Pulse home screen (6 KPI cards + charts + sparklines)"
```

---

### Task 7: Device smoke — Pulse renders + updates against a live Agent

> Manual on-device sanity before the Appium gate. Requires the Agent running on the Mac and the
> mobile dev-client connected (LAN tier from plan 02).

**Files:** none (verification only).

- [ ] **Step 1: Start the Agent**

Run: `tools dev-dashboard agent --foreground` (or the plan-01 standalone Agent entrypoint).
Expected: `/api/system/pulse` serves a `PulseSnapshot` (curl it: `curl -u <user>:<pass> http://<mac-ip>:3042/api/system/pulse | tools json`).

- [ ] **Step 2: Launch the dev-client and open the Pulse tab**

Run: `cd DevDashboard/mobile && npx expo run:ios` (dev-client; Skia/sqlite need native).
Expected: the Pulse tab shows 6 KPI cards with real values, two area charts drawing, the sparkline
row, and the process/network/weather cards. KPI values change as you watch (~1 Hz).

- [ ] **Step 3: Offline cold-load check**

Steps: kill the Agent → force-quit + relaunch the app → open Pulse.
Expected: charts paint the **cached** series instantly from SQLite (the `initialData` seed), KPI
cards show the last values (or `—`), no crash. Restart the Agent → live updates resume.

- [ ] **Step 4: No commit** (verification task). If anything fails, fix in the relevant earlier task and re-commit there.

---

### Task 8: Appium Page Object — `Pulse.page.ts`

> ADR §8: every feature ships a Page Object + spec. Locators are **accessibility-id first**
> (the `testID`s baked into Tasks 4–6 map to iOS accessibility ids). The Skia canvas is opaque, so
> "chart renders" = the chart **container** testID is visible; "values update" = read a KPI's text
> twice with a wait between and assert it changed (or is non-`—`).

**Files:**
- Create: `DevDashboard/mobile/e2e/pages/Pulse.page.ts`

- [ ] **Step 1: Implement the Page Object (full code)**

```typescript
import { appium_find_element, appium_gesture, appium_get_text } from "@/e2e/appium-helpers";

/** Page Object for the Pulse home tab. Locators use accessibility-id (RN testID). */
export class PulsePage {
    private readonly ids = {
        screen: "pulse-screen",
        loading: "pulse-loading",
        kpiGrid: "pulse-kpi-grid",
        kpiCpuValue: "kpi-cpu-value",
        kpiDisk: "kpi-disk",
        kpiWifi: "kpi-wifi",
        chartCpu: "chart-cpu",
        chartMem: "chart-mem",
        sparklineRow: "pulse-sparkline-row",
        processTable: "pulse-process-table",
        networkCard: "pulse-network-card",
        weatherCard: "pulse-weather-card",
        rangeSelector: "pulse-range-selector",
        range2h: "pulse-range-120",
    } as const;

    async isLoaded(): Promise<boolean> {
        return Boolean(await appium_find_element({ strategy: "accessibility id", selector: this.ids.screen }));
    }

    async chartsVisible(): Promise<boolean> {
        const cpu = await appium_find_element({ strategy: "accessibility id", selector: this.ids.chartCpu });
        const mem = await appium_find_element({ strategy: "accessibility id", selector: this.ids.chartMem });
        return Boolean(cpu) && Boolean(mem);
    }

    async allCardsVisible(): Promise<boolean> {
        for (const id of [this.ids.kpiGrid, this.ids.kpiDisk, this.ids.kpiWifi, this.ids.processTable, this.ids.networkCard, this.ids.weatherCard, this.ids.sparklineRow]) {
            const el = await appium_find_element({ strategy: "accessibility id", selector: id });
            if (!el) {
                return false;
            }
        }

        return true;
    }

    async cpuValue(): Promise<string> {
        return appium_get_text({ strategy: "accessibility id", selector: this.ids.kpiCpuValue });
    }

    async selectRange2h(): Promise<void> {
        await appium_gesture({ action: "tap", strategy: "accessibility id", selector: this.ids.range2h });
    }
}
```

> **CRITICAL — `@/e2e/appium-helpers` must be a real WebDriver client, not the MCP tools.** The
> `appium_*` names below mirror the MCP tool surface for readability, but a `bun test` process cannot
> import LLM-invoked MCP tools. For `bun test e2e/specs/pulse.spec.ts` to actually run, plan-04's
> harness must expose `appium-helpers` as a thin **webdriverio → Appium server** client exporting
> `createDriver` / `destroyDriver` / `sleep` / `appium_find_element` / `appium_get_text` /
> `appium_gesture` with these signatures. If 04 instead drives Appium agent-side via the MCP tools
> (no importable client), this spec file is non-runnable and the Page Object methods become the LLM's
> step recipe instead. **Plan 04 must resolve this fork.** Surfaced in `openQuestions`.

- [ ] **Step 2: Typecheck + commit**

Run: `bunx tsgo --noEmit | rg "e2e/pages/Pulse"`
Expected: no errors.

```bash
git add DevDashboard/mobile/e2e/pages/Pulse.page.ts
git commit -m "test(dd-mobile): Pulse Appium Page Object (accessibility-id locators)"
```

---

### Task 9: Appium spec — `pulse.spec.ts` (the done-gate)

> **This feature is "done" only when this spec passes on the iOS simulator/dev-client** (ADR §8).
> The spec asserts: cards visible, charts render (container testIDs), and KPI values update over time.

**Files:**
- Create: `DevDashboard/mobile/e2e/specs/pulse.spec.ts`

- [ ] **Step 1: Write the spec (full code)**

```typescript
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createDriver, destroyDriver, sleep } from "@/e2e/appium-helpers";
import { PulsePage } from "@/e2e/pages/Pulse.page";

describe("Pulse screen (E2E)", () => {
    const pulse = new PulsePage();

    beforeAll(async () => {
        await createDriver(); // appium_session_management (action=create) — see plan-04 harness
    });

    afterAll(async () => {
        await destroyDriver();
    });

    it("loads the Pulse screen", async () => {
        expect(await pulse.isLoaded()).toBe(true);
    });

    it("shows all cards (KPI grid, disk, wifi, process/network/weather, sparklines)", async () => {
        expect(await pulse.allCardsVisible()).toBe(true);
    });

    it("renders the CPU and memory charts (container present)", async () => {
        expect(await pulse.chartsVisible()).toBe(true);
    });

    it("updates KPI values over time (live ~1 Hz polling)", async () => {
        const first = await pulse.cpuValue();
        await sleep(4000); // > a few poll cycles
        const second = await pulse.cpuValue();
        // Either the value moved, or at minimum it is a real reading (not the em-dash placeholder).
        expect(first !== second || (first !== "—" && second !== "—")).toBe(true);
    });

    it("switching the range to 2h keeps the charts mounted", async () => {
        await pulse.selectRange2h();
        await sleep(500);
        expect(await pulse.chartsVisible()).toBe(true);
    });
});
```

- [ ] **Step 2: Run the spec on the simulator/dev-client**

Pre-req: Agent running + dev-client built + Appium driver session available (plan-04 harness).
Run: `cd DevDashboard/mobile && bun test e2e/specs/pulse.spec.ts`
Expected: PASS (5 tests). If "values update" flakes because CPU is genuinely flat, the non-`—`
fallback assertion still passes — the gate is "real readings render + charts mount", not "CPU moved".

- [ ] **Step 3: Commit**

```bash
git add DevDashboard/mobile/e2e/specs/pulse.spec.ts
git commit -m "test(dd-mobile): Pulse E2E spec — cards visible, charts render, values update (done-gate)"
```

---

## Self-Review checklist

1. **Parity with web Pulse:** CPU/memory/swap/battery KPI cards (web's 4) + **disk + wifi** (brief's
   extra 2) = 6; two area charts (CPU + memory-free); sparkline row; weather + network + process
   cards; range selector. Matches `ui/src/routes/index.tsx` plus the brief's additions.
2. **No `@app/*` in the mobile bundle:** formatters reimplemented in `lib/format/units.ts`; the only
   cross-boundary import is `@devdashboard/contract` (the published pure pkg, per ADR §1/§3). No
   `var(--dd-*)` (RN has no CSS vars) — colors via `useThemeColors()`.
3. **Type names match 03:** `client.system.pulse(): PulseSnapshot`,
   `client.system.pulseHistory(metric, minutes): PulseSeries`, `PulsePoint`, `TopProcess` — exact.
   The chart's `ts: number` vs contract's `PulsePoint.ts: string` mismatch is resolved explicitly by
   `toMetricPoints()` (ISO → `Date.parse`) at the page, not hidden.
4. **MetricChart interface (ADR §6):** one concrete `VictoryMetricChart` (area + sparkline variants);
   `GraphMetricChart`/`SkiaMetricChart` noted as swappable-but-unbuilt with a one-line registration
   seam (`export const MetricChart = VictoryMetricChart`). Skia colors are concrete JS values.
5. **Offline / cold-load:** `SqlitePulseHistoryStore` seeds the chart via `initialData` before the
   network resolves; every successful history fetch `write`s back. The **pure** `mergePoints` logic
   is `bun:test`-covered (dedupe / trim-window / sort); the native SQLite impl is Appium-verified.
6. **1 Hz polling:** `usePulse` `refetchInterval: 1000` (ADR M1); history 10 s (60 s for 24 h);
   weather 10 min. Background pause is plan-04's `onlineManager`/`focusManager` — referenced, not
   re-implemented.
7. **No placeholders:** every step shows full code or an exact command + expected output. Install
   uses `npx expo install` (ADR rule), never `bun add`, for native modules.
8. **TDD order honored:** failing test → confirm fail → implement → confirm pass → commit, for the
   two pure modules (`units`, `mergePoints`); presentational/native components are verified by tsgo
   + the device smoke + the Appium gate (native modules can't be `bun:test`ed).

## Appium E2E (ADR §8) — required, the done-gate

- **Spec:** `DevDashboard/mobile/e2e/specs/pulse.spec.ts`.
- **Page Object:** `DevDashboard/mobile/e2e/pages/Pulse.page.ts` — `PulsePage` with
  `isLoaded()`, `allCardsVisible()`, `chartsVisible()`, `cpuValue()`, `selectRange2h()`.
- **Locators (accessibility-id / RN testID):** `pulse-screen`, `pulse-kpi-grid`, `kpi-cpu` …
  `kpi-wifi` (+ `kpi-cpu-value` for the readable text), `chart-cpu`, `chart-mem`,
  `pulse-sparkline-row`, `pulse-process-table`, `pulse-network-card`, `pulse-weather-card`,
  `pulse-range-selector`, `pulse-range-120`.
- **MCP tools:** `appium_session_management` (create/destroy driver), `appium_find_element`
  (accessibility-id strategy), `appium_get_text` (read KPI value), `appium_gesture`
  (`action: "tap"` for the range selector). Scroll off-screen cards into view with
  `appium_gesture` `action: "scroll_to_element"` if the device viewport clips the lower cards.
- **Done criterion:** the feature is **not done** until `pulse.spec.ts` passes on the iOS
  simulator/dev-client with the Agent live: cards visible, both charts' containers present, and KPI
  values are real readings that update (or are non-`—`) across poll cycles.

## Hand-off

- **To plan 06 (Terminals):** the `MetricChart` swappable pattern (interface + one-line registration
  seam) is the template for the `TerminalRenderer` driver registry.
- **Open dependencies on plan 03/04** are in `openQuestions` — the 03 author should pin the concrete
  `client.weather.*` method + `WeatherSnapshot` type name, and 04 should confirm the seam import
  names (`@/lib/dashboard-client`, `@/lib/theme`, `@/lib/db`, `@/components/ui/Card`, the
  `@/e2e/appium-helpers` harness, and the `app/(tabs)/index.tsx` route slot).
