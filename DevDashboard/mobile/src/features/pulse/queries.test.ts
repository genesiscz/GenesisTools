import type { PulseRes } from "@dd/contract";
import { describe, expect, it } from "bun:test";
import { mockDashboardClient } from "@/api/mock-client";
import {
    HISTORY_INTERVAL_LONG_MS,
    HISTORY_INTERVAL_MS,
    pulseHistoryQuery,
    pulseKeys,
    pulseQuery,
    SNAP_INTERVAL_MS,
    WEATHER_INTERVAL_MS,
    weatherQuery,
} from "@/features/pulse/queries";

/**
 * Proves data flows through the D32 data layer WITHOUT a React renderer (none is installed; adding
 * one would be a D20 lib decision). We exercise the mock client directly and the `queryOptions`
 * factories' `queryFn` against that mock — which is exactly what `useQuery` calls. This validates:
 * the mock returns believable fixtures, the factories produce the right keys, and the queryFn
 * round-trips the fixture untouched. The thin hooks (`usePulse` = `useQuery(pulseQuery(client))`)
 * add no logic, so this is the meaningful seam to test.
 */

describe("mock dashboard client", () => {
    it("pulse returns a believable snapshot in range", async () => {
        const snap = await mockDashboardClient.system.pulse();
        expect(snap.cpuPct).not.toBeNull();
        expect(snap.cpuPct as number).toBeGreaterThanOrEqual(0);
        expect(snap.cpuPct as number).toBeLessThanOrEqual(100);
        expect(snap.memTotalBytes).toBeGreaterThan(0);
        expect(snap.topProcesses.length).toBeGreaterThan(0);
        expect(typeof snap.capturedAt).toBe("string");
    });

    it("pulseHistory returns ascending points within the window", async () => {
        const series = await mockDashboardClient.system.pulseHistory("cpu", 30);
        expect(series.metric).toBe("cpu");
        expect(series.points.length).toBeGreaterThan(1);
        const times = series.points.map((p) => Date.parse(p.ts));
        for (let i = 1; i < times.length; i++) {
            expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
        }

        for (const p of series.points) {
            expect(p.value).toBeGreaterThanOrEqual(0);
            expect(p.value).toBeLessThanOrEqual(100);
        }
    });

    it("weather returns a labelled snapshot", async () => {
        const w = await mockDashboardClient.weather();
        expect(w.label).toContain("mock");
        expect(typeof w.description).toBe("string");
    });

    it("covers the endpoints parallel features consume (tmux/ttyd/cmux/obsidian/qa)", async () => {
        expect((await mockDashboardClient.tmux.sessions()).sessions.length).toBeGreaterThan(0);
        expect((await mockDashboardClient.ttyd.list()).sessions.length).toBeGreaterThan(0);
        expect((await mockDashboardClient.cmux.snapshot()).snapshot.available).toBe(true);
        expect((await mockDashboardClient.cmux.layout()).layout.windows.length).toBeGreaterThan(0);
        expect((await mockDashboardClient.obsidian.tree()).entries.length).toBeGreaterThan(0);
        expect((await mockDashboardClient.qa.log()).entries.length).toBeGreaterThan(0);
    });

    it("qa.subscribe emits a fixture entry then can be closed", async () => {
        const received = await new Promise<boolean>((resolve) => {
            const sub = mockDashboardClient.qa.subscribe(() => resolve(true));
            setTimeout(() => {
                sub.close();
                resolve(false);
            }, 2_000);
        });
        expect(received).toBe(true);
    });

    it("get/post escape hatch path-switches the deferred routes", async () => {
        const containers = await mockDashboardClient.get<{ dockerAvailable: boolean }>("/api/containers");
        expect(typeof containers.dockerAvailable).toBe("boolean");
        const unknown = await mockDashboardClient.get<Record<string, unknown>>("/api/nope");
        expect(unknown).toEqual({});
    });
});

describe("pulse query factories", () => {
    // The factory's job is to wire key + polling + queryFn over the injected client. We assert the
    // wiring directly and prove the data-flow via the client method the queryFn calls — no React
    // renderer, no awkward QueryFunctionContext construction.

    it("pulseQuery builds the snap key + interval + a queryFn that calls the client", async () => {
        const opts = pulseQuery(mockDashboardClient);
        expect([...opts.queryKey]).toEqual([...pulseKeys.snap]);
        expect(opts.refetchInterval).toBe(SNAP_INTERVAL_MS);
        expect(typeof opts.queryFn).toBe("function");
        // Invoke the factory's queryFn to prove it actually routes to the client. Our queryFns
        // genuinely ignore TanStack's QueryFunctionContext, so the cast (around the context-typed
        // signature) is honest — feature agents copying this should keep this assertion.
        const data = await (opts.queryFn as unknown as () => Promise<PulseRes>)();
        expect(data.memTotalBytes).toBeGreaterThan(0);
    });

    it("pulseHistoryQuery encodes metric + minutes into the key", () => {
        const opts = pulseHistoryQuery(mockDashboardClient, "mem_free", 120);
        expect([...opts.queryKey]).toEqual(["pulse", "history", "mem_free", 120]);
    });

    it("pulseHistoryQuery uses the long interval only for the 24h range", () => {
        expect(pulseHistoryQuery(mockDashboardClient, "cpu", 30).refetchInterval).toBe(HISTORY_INTERVAL_MS);
        expect(pulseHistoryQuery(mockDashboardClient, "cpu", 1440).refetchInterval).toBe(HISTORY_INTERVAL_LONG_MS);
    });

    it("weatherQuery builds the weather key + interval", () => {
        const opts = weatherQuery(mockDashboardClient);
        expect([...opts.queryKey]).toEqual([...pulseKeys.weather]);
        expect(opts.refetchInterval).toBe(WEATHER_INTERVAL_MS);
        expect(typeof opts.queryFn).toBe("function");
    });
});
