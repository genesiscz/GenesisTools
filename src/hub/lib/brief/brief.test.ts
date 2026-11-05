import { describe, expect, test } from "bun:test";
import type { AccountUsageSnapshot } from "@genesiscz/utils/ai/providers/account-features";
import {
    type BriefDeps,
    briefNoticeLines,
    briefResets,
    buildBrief,
    DEFAULT_BRIEF_CONFIG,
    overnightWindow,
    parseBriefConfig,
} from "./index";

const NOW = new Date(2026, 10, 4, 6, 0, 0);

function snapshot(name: string, resetsAt: string, percentUsed: number): AccountUsageSnapshot {
    return {
        provider: "anthropic-sub",
        accountId: name,
        accountName: name,
        fetchedAt: NOW.toISOString(),
        limits: [
            { key: "five_hour", label: "5h", kind: "session", percentUsed, resetsAt },
            { key: "seven_day", label: "7d", kind: "weekly", percentUsed: 10 },
        ],
    };
}

function fakeDeps(overrides: Partial<BriefDeps> = {}): BriefDeps & { wazeCalls: number } {
    const deps = {
        wazeCalls: 0,
        async commute(trip: { from: string; to: string }) {
            deps.wazeCalls += 1;
            return {
                from: trip.from,
                to: trip.to,
                leaveAt: new Date(2026, 10, 4, 7, 15).toISOString(),
                arriveAt: new Date(2026, 10, 4, 7, 50).toISOString(),
                minutes: 35,
                error: null,
            };
        },
        weather: async () => ({ label: "Home", tempC: 4.4, description: "Fog", error: null }),
        overnight: async (since: Date) => ({
            since: since.toISOString(),
            sessions: 3,
            commits: 7,
            decisionsAnswered: 2,
            titles: ["work"],
        }),
        decisionsWaiting: async () => 4,
        snapshots: async () => [
            snapshot("work", "2026-11-04T09:00:00Z", 81.6),
            snapshot("side", "2026-11-04T07:00:00Z", 5),
        ],
        ...overrides,
    };
    return deps;
}

describe("parseBriefConfig", () => {
    test("an empty config is the defaults, with no trip", () => {
        expect(parseBriefConfig(undefined)).toEqual(DEFAULT_BRIEF_CONFIG);
    });

    test("a bad clock or window falls back per field", () => {
        const config = parseBriefConfig({
            schedule: { at: "25:00" },
            commute: { from: "Home", to: "Office", leaveAfter: "7am", windowHours: 99 },
        });
        expect(config.schedule.at).toBe("06:00");
        expect(config.commute).toEqual({ from: "Home", to: "Office", leaveAfter: "07:00", windowHours: 2 });
    });

    test("a trip without a destination asks Waze nothing", () => {
        expect(parseBriefConfig({ commute: { from: "Home" } }).commute).toBeNull();
    });
});

describe("buildBrief", () => {
    test("one Waze call, the resets soonest first, and the parts filled", async () => {
        const deps = fakeDeps();
        const config = parseBriefConfig({ commute: { from: "Home", to: "Office" } });
        const brief = await buildBrief({ config, deps, now: NOW });

        expect(deps.wazeCalls).toBe(1);
        expect(brief.commute?.minutes).toBe(35);
        expect(brief.decisionsWaiting).toBe(4);
        expect(brief.resets.map((reset) => [reset.account, reset.utilization])).toEqual([
            ["side", 5],
            ["work", 82],
        ]);
        expect(brief.warnings).toEqual([]);
    });

    test("no trip set: no Waze call and a warning that names the fix", async () => {
        const deps = fakeDeps();
        const brief = await buildBrief({ config: DEFAULT_BRIEF_CONFIG, deps, now: NOW });

        expect(deps.wazeCalls).toBe(0);
        expect(brief.commute).toBeNull();
        expect(brief.warnings[0]).toContain("hub brief config");
    });

    test("a broken part is a warning and a null part; the rest still shows", async () => {
        const deps = fakeDeps({
            weather: async () => {
                throw new Error("offline");
            },
        });
        const brief = await buildBrief({ config: DEFAULT_BRIEF_CONFIG, deps, now: NOW });

        expect(brief.weather).toBeNull();
        expect(brief.overnight?.commits).toBe(7);
        expect(brief.warnings).toContain("weather: offline");
    });
});

describe("helpers", () => {
    test("the overnight window starts on the day before", () => {
        const window = overnightWindow("18:00", NOW);
        expect(window.since).toEqual(new Date(2026, 10, 3, 18, 0, 0));
        expect(window.until).toEqual(NOW);
    });

    test("briefResets keeps the session windows only", () => {
        expect(briefResets([snapshot("work", "2026-11-04T09:00:00Z", 50)])).toHaveLength(1);
    });

    test("the push leads with the departure", async () => {
        const config = parseBriefConfig({ commute: { from: "Home", to: "Office" } });
        const brief = await buildBrief({ config, deps: fakeDeps(), now: NOW });
        const lines = briefNoticeLines(brief);

        expect(lines.title).toBe("Leave at 07:15 for Office (35 min)");
        expect(lines.message).toBe("4 °C, Fog · 4 decisions wait · 3 sessions and 7 commits overnight");
    });
});
