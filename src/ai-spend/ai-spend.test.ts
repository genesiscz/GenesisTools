import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { Storage } from "@app/utils/storage/storage";
import { aggregate } from "./lib/aggregate";
import { loadPricing } from "./lib/config";
import { findTranscriptFiles, readEvents } from "./lib/discover";
import { parseTranscriptLine } from "./lib/parse";
import { costOf, DEFAULT_PRICING, priceFor } from "./lib/pricing";
import { renderSummary } from "./lib/render";
import { resolveSince } from "./lib/since";
import type { UsageEvent } from "./lib/types";

describe("parseTranscriptLine", () => {
    const assistantLine = SafeJSON.stringify({
        type: "assistant",
        timestamp: "2026-06-01T09:52:38.815Z",
        cwd: "/Users/x/Projects/Foo",
        sessionId: "sess-1",
        message: {
            id: "msg_abc",
            model: "claude-opus-4-8",
            usage: {
                input_tokens: 100,
                output_tokens: 20,
                cache_creation_input_tokens: 300,
                cache_read_input_tokens: 4000,
                iterations: [{ input_tokens: 100, output_tokens: 20 }],
            },
        },
    });

    it("extracts a UsageEvent from an assistant line", () => {
        const ev = parseTranscriptLine(assistantLine);
        expect(ev).not.toBeNull();
        expect(ev?.messageId).toBe("msg_abc");
        expect(ev?.model).toBe("claude-opus-4-8");
        expect(ev?.project).toBe("/Users/x/Projects/Foo");
        expect(ev?.inputTokens).toBe(100);
        expect(ev?.outputTokens).toBe(20);
        expect(ev?.cacheCreationTokens).toBe(300);
        expect(ev?.cacheReadTokens).toBe(4000);
    });

    it("returns null for non-assistant lines", () => {
        expect(parseTranscriptLine(SafeJSON.stringify({ type: "user", message: {} }))).toBeNull();
    });

    it("returns null for assistant lines without usage", () => {
        expect(
            parseTranscriptLine(SafeJSON.stringify({ type: "assistant", message: { id: "m", model: "x" } }))
        ).toBeNull();
    });

    it("returns null for malformed JSON", () => {
        expect(parseTranscriptLine("{not json")).toBeNull();
        expect(parseTranscriptLine("")).toBeNull();
    });

    it("returns null for a bare null line instead of throwing", () => {
        expect(parseTranscriptLine("null")).toBeNull();
    });
});

describe("pricing", () => {
    it("prices the four token classes separately", () => {
        const price = { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 };
        const cost = costOf(
            { input: 1_000_000, output: 1_000_000, cacheWrite: 1_000_000, cacheRead: 1_000_000 },
            price
        );
        expect(cost).toBeCloseTo(15 + 75 + 18.75 + 1.5, 6);
    });

    it("knows the canonical Claude models", () => {
        expect(priceFor("claude-opus-4-8", DEFAULT_PRICING)).not.toBeNull();
        expect(priceFor("claude-sonnet-4-6", DEFAULT_PRICING)).not.toBeNull();
    });

    it("matches by longest known prefix so versioned ids resolve", () => {
        expect(priceFor("claude-opus-4-8-20260101", DEFAULT_PRICING)).not.toBeNull();
    });

    it("returns null for genuinely unknown models", () => {
        expect(priceFor("glm-4.6", DEFAULT_PRICING)).toBeNull();
    });
});

describe("resolveSince", () => {
    const now = new Date("2026-06-02T12:00:00.000Z");

    it("parses Nd as N days back (UTC day)", () => {
        expect(resolveSince("7d", now)).toBe("2026-05-26");
        expect(resolveSince("0d", now)).toBe("2026-06-02");
    });

    it("passes through a YYYY-MM-DD literal", () => {
        expect(resolveSince("2026-05-01", now)).toBe("2026-05-01");
    });

    it("defaults nonsense to undefined (caller applies its own default)", () => {
        expect(resolveSince("garbage", now)).toBeUndefined();
    });

    it("rejects shape-valid but impossible dates", () => {
        expect(resolveSince("2026-02-30", now)).toBeUndefined();
        expect(resolveSince("2026-13-01", now)).toBeUndefined();
    });
});

function ev(over: Partial<UsageEvent>): UsageEvent {
    return {
        messageId: "m",
        model: "claude-opus-4-8",
        timestamp: "2026-06-01T10:00:00.000Z",
        project: "/p/Foo",
        sessionId: "s1",
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        ...over,
    };
}

describe("aggregate", () => {
    const now = new Date("2026-06-02T00:00:00.000Z");

    it("dedups by messageId — identical triplicate events count once", () => {
        const dup = ev({ messageId: "dup", inputTokens: 100, outputTokens: 10 });
        const report = aggregate({ events: [dup, { ...dup }, { ...dup }], pricing: DEFAULT_PRICING, now });
        expect(report.total.tokens.input).toBe(100);
        expect(report.total.tokens.output).toBe(10);
    });

    it("computes four-component cost against hand numbers (two models, two days)", () => {
        const events: UsageEvent[] = [
            ev({
                messageId: "a",
                model: "claude-opus-4-8",
                timestamp: "2026-06-01T10:00:00.000Z",
                inputTokens: 1_000_000,
                outputTokens: 1_000_000,
                cacheCreationTokens: 1_000_000,
                cacheReadTokens: 1_000_000,
            }),
            ev({
                messageId: "b",
                model: "claude-sonnet-4-6",
                timestamp: "2026-06-02T10:00:00.000Z",
                inputTokens: 1_000_000,
                outputTokens: 0,
                cacheCreationTokens: 0,
                cacheReadTokens: 0,
            }),
        ];
        const report = aggregate({ events, pricing: DEFAULT_PRICING, now });
        // opus: 15+75+18.75+1.5 = 110.25 ; sonnet: 3 ; total 113.25
        expect(report.total.cost).toBeCloseTo(113.25, 6);
        expect(report.days.map((d) => d.day)).toEqual(["2026-06-01", "2026-06-02"]);
        expect(report.models.find((m) => m.model === "claude-opus-4-8")?.cost).toBeCloseTo(110.25, 6);
    });

    it("computes cache-hit rate = cacheRead / (input + cacheRead)", () => {
        const report = aggregate({
            events: [ev({ messageId: "c", inputTokens: 100, cacheReadTokens: 900 })],
            pricing: DEFAULT_PRICING,
            now,
        });
        expect(report.total.cacheHitRate).toBeCloseTo(0.9, 6);
    });

    it("counts tokens but $0 for an unpriced model, marked priced=false", () => {
        const report = aggregate({
            events: [ev({ messageId: "u", model: "glm-4.6", inputTokens: 5000 })],
            pricing: DEFAULT_PRICING,
            now,
        });
        const m = report.models.find((x) => x.model === "glm-4.6");
        expect(m?.priced).toBe(false);
        expect(m?.tokens.input).toBe(5000);
        expect(m?.cost).toBe(0);
        expect(report.total.cost).toBe(0);
    });

    it("applies since/model/project filters in-core", () => {
        const events: UsageEvent[] = [
            ev({ messageId: "old", timestamp: "2026-05-01T10:00:00.000Z", inputTokens: 1 }),
            ev({ messageId: "new", timestamp: "2026-06-01T10:00:00.000Z", inputTokens: 2 }),
            ev({ messageId: "other-proj", project: "/p/Bar", inputTokens: 4 }),
            ev({ messageId: "sonnet", model: "claude-sonnet-4-6", inputTokens: 8 }),
        ];
        const r = aggregate({
            events,
            pricing: DEFAULT_PRICING,
            now,
            sinceDay: "2026-05-15",
            project: "foo",
            model: "opus",
        });
        // keeps only events on/after 2026-05-15, project contains "foo", model contains "opus"
        expect(r.total.tokens.input).toBe(2);
    });

    it("UTC day keys are TZ-independent", () => {
        const prev = process.env.TZ;
        process.env.TZ = "Pacific/Kiritimati"; // UTC+14
        try {
            const r = aggregate({
                events: [ev({ messageId: "tz", timestamp: "2026-06-01T23:30:00.000Z", inputTokens: 1 })],
                pricing: DEFAULT_PRICING,
                now,
            });
            expect(r.days[0].day).toBe("2026-06-01");
        } finally {
            process.env.TZ = prev;
        }
    });
});

describe("discover + readEvents", () => {
    it("finds *.jsonl under <home>/.claude/projects and parses events", () => {
        const home = mkdtempSync(join(tmpdir(), "ai-spend-home-"));
        const projDir = join(home, ".claude", "projects", "-Users-x-Foo");
        mkdirSync(projDir, { recursive: true });
        const line = SafeJSON.stringify({
            type: "assistant",
            timestamp: "2026-06-01T10:00:00.000Z",
            cwd: "/Users/x/Foo",
            sessionId: "s1",
            message: { id: "m1", model: "claude-opus-4-8", usage: { input_tokens: 10, output_tokens: 2 } },
        });
        writeFileSync(join(projDir, "sess.jsonl"), `${line}\n{garbage}\n\n`);

        const files = findTranscriptFiles(home);
        expect(files.length).toBe(1);

        const events = readEvents(files);
        expect(events.length).toBe(1);
        expect(events[0].messageId).toBe("m1");
    });

    it("returns [] when the projects dir is absent", () => {
        const home = mkdtempSync(join(tmpdir(), "ai-spend-empty-"));
        expect(findTranscriptFiles(home)).toEqual([]);
    });
});

describe("loadPricing", () => {
    it("merges user config pricing over defaults", async () => {
        const home = mkdtempSync(join(tmpdir(), "ai-spend-cfg-"));
        const prev = process.env.GENESIS_TOOLS_HOME;
        process.env.GENESIS_TOOLS_HOME = home;
        try {
            const storage = new Storage("ai-spend");
            await storage.setConfigValue("pricing", {
                "glm-4.6": { input: 1, output: 2, cacheWrite: 1, cacheRead: 0.1 },
            });
            const pricing = await loadPricing(storage);
            expect(pricing["glm-4.6"]).toEqual({ input: 1, output: 2, cacheWrite: 1, cacheRead: 0.1 });
            expect(pricing["claude-opus-4"]).toBeDefined();
        } finally {
            process.env.GENESIS_TOOLS_HOME = prev;
        }
    });
});

describe("renderSummary", () => {
    it("renders totals, model and project sections from a Report", () => {
        const report = aggregate({
            events: [
                ev({ messageId: "r1", model: "claude-opus-4-8", inputTokens: 1_000_000, outputTokens: 1_000_000 }),
                ev({ messageId: "r2", model: "glm-4.6", project: "/p/Bar", inputTokens: 1000 }),
            ],
            pricing: DEFAULT_PRICING,
            now: new Date("2026-06-02T00:00:00.000Z"),
        });
        const text = renderSummary(report);
        expect(text).toContain("TOTAL");
        expect(text).toContain("claude-opus-4-8");
        expect(text).toContain("(unpriced)");
    });
});
