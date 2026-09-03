import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { isolateAgentHomeEnv } from "../drivers/test-env";
import { DEFAULT_PRICING } from "../pricing";
import { identifySessionBlocks } from "./blocks";
import { isValidTimeZone, resolveRelativeSince } from "./dates";
import { firstFinite, optionalFinite } from "./jsonl";
import { loadEvents } from "./load";
import { buildPeriodReport } from "./period";
import { buildSessionReport } from "./session";
import { parseStatuslineHook, renderStatusline } from "./statusline";
import type { SpendEvent } from "./types";

isolateAgentHomeEnv();

describe("resolveRelativeSince", () => {
    it("subtracts civil days in the report timezone, not UTC", () => {
        const now = new Date("2026-06-02T04:00:00.000Z");
        expect(resolveRelativeSince("0d", now, "UTC")).toBe("2026-06-02");
        expect(resolveRelativeSince("0d", now, "America/Los_Angeles")).toBe("2026-06-01");
        expect(resolveRelativeSince("1d", now, "America/Los_Angeles")).toBe("2026-05-31");
    });
});

describe("isValidTimeZone", () => {
    it("accepts IANA names and rejects unknown ones", () => {
        expect(isValidTimeZone("UTC")).toBe(true);
        expect(isValidTimeZone("America/Los_Angeles")).toBe(true);
        expect(isValidTimeZone("Not/AZone")).toBe(false);
        expect(isValidTimeZone("")).toBe(false);
    });
});

describe("optionalFinite", () => {
    it("keeps a present zero and skips absent fields", () => {
        expect(optionalFinite(0)).toBe(0);
        expect(optionalFinite("0")).toBe(0);
        expect(optionalFinite(undefined)).toBeUndefined();
        expect(optionalFinite("")).toBeUndefined();
        expect(firstFinite(0, 9)).toBe(0);
        expect(firstFinite(undefined, 9)).toBe(9);
        expect(firstFinite(undefined, undefined)).toBe(0);
    });
});

function ev(over: Partial<SpendEvent>): SpendEvent {
    return {
        source: "claude",
        id: "m",
        model: "claude-3-5-haiku",
        timestamp: "2026-06-01T10:00:00.000Z",
        sessionId: "sess-a",
        project: "proj",
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        ...over,
    };
}

const now = new Date("2026-06-02T12:00:00.000Z");
const common = {
    timezone: "UTC",
    now,
    pricing: DEFAULT_PRICING,
    mode: "calculate" as const,
};

describe("buildPeriodReport", () => {
    it("groups daily rows and totals the four token fields from the fixture arithmetic", () => {
        const events: SpendEvent[] = [
            ev({ id: "a", inputTokens: 100, outputTokens: 20, cacheCreationTokens: 10, cacheReadTokens: 5 }),
            ev({
                id: "b",
                timestamp: "2026-06-02T09:00:00.000Z",
                inputTokens: 50,
                outputTokens: 5,
                cacheCreationTokens: 0,
                cacheReadTokens: 15,
                model: "claude-sonnet-4-6",
            }),
        ];
        const report = buildPeriodReport(events, { ...common, grain: "daily" });
        const daily = report.daily as Array<{
            period: string;
            inputTokens: number;
            outputTokens: number;
            cacheCreationTokens: number;
            cacheReadTokens: number;
            totalTokens: number;
        }>;
        expect(daily).toHaveLength(2);
        expect(daily[0].period).toBe("2026-06-01");
        expect(daily[0].inputTokens).toBe(100);
        expect(daily[0].outputTokens).toBe(20);
        expect(daily[0].cacheCreationTokens).toBe(10);
        expect(daily[0].cacheReadTokens).toBe(5);
        expect(daily[0].totalTokens).toBe(135);
        expect(daily[1].period).toBe("2026-06-02");
        expect(daily[1].totalTokens).toBe(70);
        const totals = report.totals as Record<string, number>;
        expect(totals.inputTokens).toBe(150);
        expect(totals.outputTokens).toBe(25);
        expect(totals.cacheCreationTokens).toBe(10);
        expect(totals.cacheReadTokens).toBe(20);
        expect(totals.totalTokens).toBe(205);
    });

    it("weekly keys land on Monday and monthly keys are YYYY-MM", () => {
        const events = [ev({ id: "a", timestamp: "2026-06-03T10:00:00.000Z", inputTokens: 1 })];
        const weekly = buildPeriodReport(events, { ...common, grain: "weekly" });
        const monthly = buildPeriodReport(events, { ...common, grain: "monthly" });
        expect((weekly.weekly as Array<{ period: string }>)[0].period).toBe("2026-06-01");
        expect((monthly.monthly as Array<{ period: string }>)[0].period).toBe("2026-06");
    });

    it("focused claude daily uses date not period", () => {
        const report = buildPeriodReport([ev({ id: "a", inputTokens: 7 })], {
            ...common,
            grain: "daily",
            source: "claude",
        });
        const daily = report.daily as Array<Record<string, unknown>>;
        expect(daily[0].date).toBe("2026-06-01");
        expect(daily[0].period).toBeUndefined();
        expect(daily[0].inputTokens).toBe(7);
    });

    it("--breakdown model rows split tokens per model", () => {
        const events = [
            ev({ id: "a", model: "claude-3-5-haiku", inputTokens: 10, outputTokens: 2 }),
            ev({ id: "b", model: "claude-sonnet-4-6", inputTokens: 30, outputTokens: 4 }),
        ];
        const report = buildPeriodReport(events, { ...common, grain: "daily" });
        const daily = report.daily as Array<{ modelBreakdowns: Array<{ modelName: string; inputTokens: number }> }>;
        const names = daily[0].modelBreakdowns.map((row) => row.modelName).sort();
        expect(names).toEqual(["claude-3-5-haiku", "claude-sonnet-4-6"]);
        expect(daily[0].modelBreakdowns.find((row) => row.modelName === "claude-3-5-haiku")?.inputTokens).toBe(10);
    });
});

describe("buildSessionReport", () => {
    it("groups by session id and sums tokens", () => {
        const events = [
            ev({ id: "a", sessionId: "one", inputTokens: 8, outputTokens: 1 }),
            ev({ id: "b", sessionId: "one", inputTokens: 2, outputTokens: 3 }),
            ev({ id: "c", sessionId: "two", inputTokens: 4, outputTokens: 0 }),
        ];
        const report = buildSessionReport(events, common);
        const rows = report.session as Array<{ period: string; inputTokens: number; totalTokens: number }>;
        const one = rows.find((row) => row.period === "one");
        expect(one?.inputTokens).toBe(10);
        expect(one?.totalTokens).toBe(14);
        expect(rows).toHaveLength(2);
    });
});

describe("identifySessionBlocks", () => {
    it("splits events more than 5 hours apart into two blocks", () => {
        const events = [
            ev({ id: "a", timestamp: "2026-06-01T10:15:00.000Z", inputTokens: 10, outputTokens: 1 }),
            ev({ id: "b", timestamp: "2026-06-01T16:00:00.000Z", inputTokens: 20, outputTokens: 2 }),
        ];
        const blocks = identifySessionBlocks(events, 5, Date.parse("2026-06-02T00:00:00.000Z"), () => 0);
        const real = blocks.filter((block) => !block.isGap);
        expect(real).toHaveLength(2);
        expect(real[0].startTime).toBe("2026-06-01T10:00:00.000Z");
        expect(real[0].endTime).toBe("2026-06-01T15:00:00.000Z");
        expect(real[0].tokenCounts.inputTokens).toBe(10);
        expect(real[1].startTime).toBe("2026-06-01T16:00:00.000Z");
        expect(real[1].tokenCounts.inputTokens).toBe(20);
        expect(real[0].totalTokens).toBe(11);
        expect(real[1].totalTokens).toBe(22);
        expect(real[0].modelBreakdowns[0]?.modelName).toBe("claude-3-5-haiku");
        expect(real[0].modelBreakdowns[0]?.inputTokens).toBe(10);
    });
});

describe("statusline", () => {
    it("renders one compact line from a hook payload plus events", () => {
        const hook = parseStatuslineHook(
            SafeJSON.stringify({
                session_id: "sess-a",
                transcript_path: "/tmp/x.jsonl",
                model: { id: "claude-sonnet-4", display_name: "Sonnet 4" },
                cost: { total_cost_usd: 1.25 },
                context_window: { total_input_tokens: 25000, context_window_size: 200000 },
            })
        );
        expect(hook?.session_id).toBe("sess-a");
        const line = renderStatusline(hook!, [ev({ id: "a", inputTokens: 100, recordedCostUsd: 0.5 })], {
            timezone: "UTC",
            now,
            pricing: DEFAULT_PRICING,
            mode: "display",
            costSource: "auto",
            visualBurnRate: "off",
        });
        expect(line).toContain("Sonnet 4");
        expect(line).toContain("$1.25 session");
        expect(line).toContain("25,000 (13%)");
        expect(line.split("\n")).toHaveLength(1);
    });

    it("shows the emoji burn-rate indicator when visualBurnRate is emoji", () => {
        const hook = parseStatuslineHook(SafeJSON.stringify({ session_id: "sess-a" }));
        const line = renderStatusline(
            hook!,
            [ev({ id: "a", timestamp: "2026-06-01T10:15:00.000Z", inputTokens: 100, recordedCostUsd: 0.5 })],
            {
                timezone: "UTC",
                now: new Date("2026-06-01T12:00:00.000Z"),
                pricing: DEFAULT_PRICING,
                mode: "display",
                costSource: "auto",
                visualBurnRate: "emoji",
            }
        );
        expect(line).toMatch(/🟢|⚠️|🚨/);
    });
});

describe("claude advisor iterations", () => {
    it("emits a second event for advisor_message iterations", () => {
        const home = mkdtempSync(join(tmpdir(), "ai-spend-advisor-"));
        const claudeDir = join(home, ".claude", "projects", "proj");
        mkdirSync(claudeDir, { recursive: true });
        writeFileSync(
            join(claudeDir, "sess-adv.jsonl"),
            `${SafeJSON.stringify({
                type: "assistant",
                timestamp: "2026-06-01T10:00:00.000Z",
                sessionId: "sess-adv",
                message: {
                    id: "msg-parent",
                    model: "main-model",
                    usage: {
                        input_tokens: 1,
                        output_tokens: 2,
                        iterations: [
                            {
                                type: "advisor_message",
                                model: "advisor-model",
                                input_tokens: 0,
                                output_tokens: 50,
                                cache_creation_input_tokens: 0,
                                cache_read_input_tokens: 0,
                            },
                        ],
                    },
                },
            })}\n`
        );
        const events = loadEvents({ home, sources: ["claude"] });
        expect(events).toHaveLength(2);
        expect(events.map((event) => event.outputTokens).sort((a, b) => a - b)).toEqual([2, 50]);
        expect(events.reduce((sum, event) => sum + event.outputTokens, 0)).toBe(52);
    });
});

describe("claude nested progress lines", () => {
    it("counts usage nested under data.message.message", () => {
        const home = mkdtempSync(join(tmpdir(), "ai-spend-nested-"));
        const claudeDir = join(home, ".claude", "projects", "proj");
        mkdirSync(claudeDir, { recursive: true });
        writeFileSync(
            join(claudeDir, "sess-nested.jsonl"),
            `${SafeJSON.stringify({
                data: {
                    message: {
                        timestamp: "2026-06-01T10:00:00.000Z",
                        requestId: "req-1",
                        message: {
                            id: "msg-nested",
                            model: "claude-3-5-haiku",
                            usage: {
                                input_tokens: 0,
                                output_tokens: 99,
                                cache_creation_input_tokens: 0,
                                cache_read_input_tokens: 0,
                            },
                        },
                    },
                },
            })}\n`
        );
        const events = loadEvents({ home, sources: ["claude"] });
        expect(events).toHaveLength(1);
        expect(events[0].outputTokens).toBe(99);
        expect(events[0].id).toBe("msg-nested");
    });
});

describe("loadEvents from a fixture HOME", () => {
    it("reads a claude transcript and a grok updates file under the injected home", () => {
        const home = mkdtempSync(join(tmpdir(), "ai-spend-ccusage-"));
        const claudeDir = join(home, ".claude", "projects", "proj");
        mkdirSync(claudeDir, { recursive: true });
        writeFileSync(
            join(claudeDir, "sess-fix.jsonl"),
            `${SafeJSON.stringify({
                type: "assistant",
                timestamp: "2026-06-01T10:00:00.000Z",
                cwd: "/p/fix",
                sessionId: "sess-fix",
                message: {
                    id: "msg-fix",
                    model: "claude-3-5-haiku",
                    usage: {
                        input_tokens: 11,
                        output_tokens: 3,
                        cache_creation_input_tokens: 2,
                        cache_read_input_tokens: 7,
                    },
                },
            })}\n`
        );
        const events = loadEvents({ home, sources: ["claude"] });
        expect(events).toHaveLength(1);
        expect(events[0].inputTokens).toBe(11);
        expect(events[0].outputTokens).toBe(3);
        expect(events[0].cacheCreationTokens).toBe(2);
        expect(events[0].cacheReadTokens).toBe(7);
        expect(
            events[0].inputTokens + events[0].outputTokens + events[0].cacheCreationTokens + events[0].cacheReadTokens
        ).toBe(23);
        const report = buildPeriodReport(events, { ...common, grain: "daily", source: "claude" });
        expect((report.totals as { totalTokens: number }).totalTokens).toBe(23);
    });
});
