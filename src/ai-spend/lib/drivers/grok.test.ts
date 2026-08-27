import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { DEFAULT_PRICING } from "../pricing";
import { billedCost, collectEvents } from "./driver-test-helpers";
import { grokDriver } from "./grok";

const turnCompleted = (eventId: string, usage: Record<string, unknown>): string =>
    SafeJSON.stringify({
        timestamp: 1_787_418_712,
        method: "_x.ai/session/update",
        params: {
            sessionId: "sess-grok-1",
            update: { sessionUpdate: "turn_completed", prompt_id: "prompt-1", stop_reason: "end_turn", usage },
            _meta: { eventId, agentTimestampMs: 1_787_418_712_439 },
        },
    });

describe("grok driver", () => {
    test("splits inputTokens into uncached/read/write and trusts costUsdTicks", () => {
        const events = collectEvents(grokDriver, [
            turnCompleted("evt-1", {
                inputTokens: 89_502,
                outputTokens: 936,
                totalTokens: 90_438,
                cachedReadTokens: 59_008,
                cacheCreationTokens: 0,
                reasoningTokens: 793,
                costUsdTicks: 163_383_600,
                modelUsage: {
                    "grok-4.6-build": {
                        inputTokens: 89_502,
                        outputTokens: 936,
                        cachedReadTokens: 59_008,
                        cacheCreationTokens: 0,
                        reasoningTokens: 793,
                        costUsdTicks: 163_383_600,
                    },
                },
            }),
        ]);

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            id: "evt-1|grok-4.6-build",
            model: "grok-4.6-build",
            inputTokens: 30_494,
            outputTokens: 936,
            cacheCreationTokens: 0,
            cacheReadTokens: 59_008,
        });
        // One tick is 1e-10 USD: 163383600 / 1e10 = $0.01633836.
        expect(events[0].recordedCostUsd).toBeCloseTo(0.01633836, 12);
        expect(billedCost(grokDriver, events[0])).toBeCloseTo(0.01633836, 12);
        // The agent's own figure survives even though xai carries no catalog rate.
        expect(DEFAULT_PRICING["grok-4.6"]).toBeUndefined();
    });

    test("the envelope timestamp is Unix SECONDS, `_meta.agentTimestampMs` is millis", () => {
        const withMeta = collectEvents(grokDriver, [turnCompleted("evt-ms", { inputTokens: 10, outputTokens: 1 })]);
        expect(withMeta[0].timestamp).toBe(new Date(1_787_418_712_439).toISOString());

        const secondsOnly = collectEvents(grokDriver, [
            SafeJSON.stringify({
                timestamp: 1_787_418_712,
                params: {
                    sessionId: "sess-grok-1",
                    update: { sessionUpdate: "turn_completed", usage: { inputTokens: 10, outputTokens: 1 } },
                },
            }),
        ]);
        expect(secondsOnly[0].timestamp).toBe(new Date(1_787_418_712_000).toISOString());
    });

    test("cacheCreationTokens is a sibling subset, not an extra bucket", () => {
        const events = collectEvents(grokDriver, [
            turnCompleted("evt-2", {
                modelUsage: {
                    "grok-4.5-build": {
                        inputTokens: 100,
                        outputTokens: 20,
                        cachedReadTokens: 40,
                        cacheCreationTokens: 25,
                        reasoningTokens: 10,
                    },
                },
            }),
        ]);

        expect(events[0]).toMatchObject({ inputTokens: 35, cacheReadTokens: 40, cacheCreationTokens: 25 });
        // The three parts sum back to inputTokens.
        expect(events[0].inputTokens + events[0].cacheReadTokens + events[0].cacheCreationTokens).toBe(100);
        // No ticks recorded and xai is unpriced → $0.
        expect(events[0].recordedCostUsd).toBeUndefined();
        expect(billedCost(grokDriver, events[0])).toBe(0);
    });

    test("one turn billing two models yields two events, sorted by model id", () => {
        const events = collectEvents(grokDriver, [
            turnCompleted("evt-3", {
                modelUsage: {
                    "model-b": { inputTokens: 20, outputTokens: 4, cachedReadTokens: 5, costUsdTicks: 20_000_000 },
                    "model-a": { inputTokens: 10, outputTokens: 2, costUsdTicks: 10_000_000 },
                },
            }),
        ]);

        expect(events.map((event) => event.model)).toEqual(["model-a", "model-b"]);
        expect(events.map((event) => event.id)).toEqual(["evt-3|model-a", "evt-3|model-b"]);
        expect(events[0].recordedCostUsd).toBeCloseTo(0.001, 12);
        expect(events[1].recordedCostUsd).toBeCloseTo(0.002, 12);
    });

    test("no modelUsage map falls back to summary.json's current_model_id", () => {
        const dir = mkdtempSync(join(tmpdir(), "ai-spend-grok-"));
        const sessionDir = join(dir, "sess-x");
        mkdirSync(sessionDir, { recursive: true });
        writeFileSync(
            join(sessionDir, "summary.json"),
            SafeJSON.stringify({ info: { id: "sess-x" }, current_model_id: "grok-4.6" })
        );

        const events = collectEvents(
            grokDriver,
            [turnCompleted("evt-4", { inputTokens: 50, outputTokens: 5, cachedReadTokens: 10 })],
            join(sessionDir, "updates.jsonl")
        );

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ model: "grok-4.6", inputTokens: 40, cacheReadTokens: 10, outputTokens: 5 });
    });

    test("non-usage updates, zero rows and hook lines are skipped", () => {
        const events = collectEvents(grokDriver, [
            SafeJSON.stringify({
                timestamp: 1_787_798_628,
                params: { update: { sessionUpdate: "hook_execution", event_name: "session_start" } },
            }),
            SafeJSON.stringify({ timestamp: 1, params: { update: { sessionUpdate: "turn_completed" } } }),
            turnCompleted("evt-zero", {
                modelUsage: {
                    "grok-4.5": { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, reasoningTokens: 0 },
                },
            }),
            "",
        ]);

        expect(events).toEqual([]);
    });

    test("only updates.jsonl counts, and GROK_HOME moves the root", async () => {
        expect(grokDriver.isTranscript("updates.jsonl")).toBe(true);
        expect(grokDriver.isTranscript("events.jsonl")).toBe(false);
        expect(grokDriver.isTranscript("chat_history.jsonl")).toBe(false);
        expect(grokDriver.roots("/home/u")).toEqual(["/home/u/.grok/sessions"]);

        await env.testing.withOverrides({ GROK_HOME: "/elsewhere/grok" }, () => {
            expect(grokDriver.roots("/home/u")).toEqual(["/elsewhere/grok/sessions"]);
        });
    });

    test("price candidates peel the -build suffix", () => {
        expect(grokDriver.priceCandidates("grok-4.6-build")).toEqual(["grok-4.6-build", "grok-4.6"]);
        expect(grokDriver.priceCandidates("grok-3-fast-latest")).toEqual(["grok-3-fast-latest", "grok-3-fast"]);
    });
});
