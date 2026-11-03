import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { claudeHistoryReader, codexHistoryReader, grokHistoryReader } from "../compact-readers";

function transcript(name: string, rows: readonly unknown[]): string {
    const dir = mkdtempSync(join(tmpdir(), "gt-analysis-"));
    const path = join(dir, name);
    writeFileSync(path, `${rows.map((row) => SafeJSON.stringify(row)).join("\n")}\n`);
    return path;
}

describe("the analysis members of the three readers", () => {
    test("Claude: one call per message id, synthetic notices skipped, a compact boundary, no quota readings", async () => {
        const usage = {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 900,
            cache_creation_input_tokens: 0,
        };
        const path = transcript("s1.jsonl", [
            { type: "user", timestamp: "2026-11-01T10:00:00Z", message: { content: "hi" } },
            { type: "assistant", timestamp: "2026-11-01T10:00:05Z", message: { id: "m1", model: "m-a", usage } },
            { type: "assistant", timestamp: "2026-11-01T10:00:06Z", message: { id: "m1", model: "m-a", usage } },
            { type: "assistant", timestamp: "2026-11-01T10:00:07Z", message: { id: "x", model: "<synthetic>", usage } },
            {
                type: "system",
                subtype: "compact_boundary",
                timestamp: "2026-11-01T10:30:00Z",
                compactMetadata: { trigger: "auto", preTokens: 160_000 },
            },
            {
                type: "assistant",
                isSidechain: true,
                timestamp: "2026-11-01T10:31:00Z",
                message: { id: "m2", model: "m-a", usage: { ...usage, cache_creation_input_tokens: 40_000 } },
            },
        ]);

        const calls = await claudeHistoryReader.analysis.callTrace(path);
        const compactions = await claudeHistoryReader.analysis.compactions(path);
        const quota = await claudeHistoryReader.analysis.quotaReadings(path);

        expect(calls.supported && calls.items.map((call) => [call.id, call.cacheWrite, call.sidechain])).toEqual([
            ["m1", 0, false],
            ["m2", 40_000, true],
        ]);
        expect(compactions).toEqual({
            supported: true,
            items: [{ t: "2026-11-01T10:30:00.000Z", trigger: "auto", preTokens: 160_000 }],
        });
        expect(quota.supported).toBe(false);
    });

    test("Codex: token_count calls, a compacted item and each change of a rate_limits reading", async () => {
        const limits = (used: number) => ({
            primary: { used_percent: used, window_minutes: 10_080, resets_at: 1_793_802_282 },
            secondary: null,
        });
        const count = (t: string, total: number, used: number) => ({
            timestamp: t,
            type: "event_msg",
            payload: {
                type: "token_count",
                info: {
                    total_token_usage: { input_tokens: total, cached_input_tokens: total / 2, output_tokens: 10 },
                    last_token_usage: { input_tokens: 1000, cached_input_tokens: 500, output_tokens: 10 },
                },
                rate_limits: limits(used),
            },
        });
        const path = transcript("rollout-2026-11-01T10-00-00-thread.jsonl", [
            { timestamp: "2026-11-01T10:00:00Z", type: "turn_context", payload: { model: "m-codex" } },
            count("2026-11-01T10:00:10Z", 1000, 18),
            count("2026-11-01T10:00:20Z", 2000, 18),
            { timestamp: "2026-11-01T10:05:00Z", type: "compacted", payload: { message: "" } },
            count("2026-11-01T10:06:00Z", 3000, 19),
        ]);

        const calls = await codexHistoryReader.analysis.callTrace(path);
        const compactions = await codexHistoryReader.analysis.compactions(path);
        const quota = await codexHistoryReader.analysis.quotaReadings(path);

        expect(calls.supported && calls.items.map((call) => [call.model, call.input, call.cacheRead])).toEqual([
            ["m-codex", 500, 500],
            ["m-codex", 500, 500],
            ["m-codex", 500, 500],
        ]);
        expect(compactions.supported && compactions.items.map((item) => item.t)).toEqual(["2026-11-01T10:05:00.000Z"]);
        expect(quota.supported && quota.items.map((item) => [item.slot, item.usedPercent, item.windowMinutes])).toEqual(
            [
                ["primary", 18, 10_080],
                ["primary", 19, 10_080],
            ]
        );
    });

    test("Codex: with both slots filled, a repeated reading is kept once per slot", async () => {
        const count = (t: string, primary: number, secondary: number) => ({
            timestamp: t,
            type: "event_msg",
            payload: {
                type: "token_count",
                rate_limits: {
                    primary: { used_percent: primary, window_minutes: 300, resets_at: 1_793_802_282 },
                    secondary: { used_percent: secondary, window_minutes: 10_080, resets_at: 1_794_000_000 },
                },
            },
        });
        const path = transcript("rollout-2026-11-01T11-00-00-both.jsonl", [
            count("2026-11-01T11:00:10Z", 5, 40),
            count("2026-11-01T11:00:20Z", 5, 40),
            count("2026-11-01T11:00:30Z", 6, 40),
        ]);

        const quota = await codexHistoryReader.analysis.quotaReadings(path);

        expect(quota.supported && quota.items.map((item) => [item.slot, item.usedPercent])).toEqual([
            ["primary", 5],
            ["secondary", 40],
            ["primary", 6],
        ]);
    });

    test("a transcript that cannot be read is unsupported with the reason, never an empty list", async () => {
        const missing = join(mkdtempSync(join(tmpdir(), "gt-analysis-")), "gone.jsonl");

        for (const reader of [claudeHistoryReader, codexHistoryReader, grokHistoryReader]) {
            const calls = await reader.analysis.callTrace(missing);

            expect(calls.supported).toBe(false);
            expect(calls.supported ? "" : calls.reason).toContain("could not be read");
        }

        for (const reader of [claudeHistoryReader, codexHistoryReader]) {
            expect((await reader.analysis.compactions(missing)).supported).toBe(false);
        }

        expect((await codexHistoryReader.analysis.quotaReadings(missing)).supported).toBe(false);
    });

    test("Grok: turn usage from updates.jsonl beside the chat history; no compaction times and no quota", async () => {
        const chat = transcript("chat_history.jsonl", [{ role: "user", content: "hi" }]);
        writeFileSync(
            join(chat, "..", "updates.jsonl"),
            `${SafeJSON.stringify({
                timestamp: 1_787_418_712,
                params: {
                    sessionId: "g1",
                    update: { sessionUpdate: "turn_completed", usage: { inputTokens: 10, outputTokens: 1 } },
                    _meta: { eventId: "e1", agentTimestampMs: 1_787_418_712_439 },
                },
            })}\n`
        );
        writeFileSync(join(chat, "..", "summary.json"), SafeJSON.stringify({ current_model_id: "m-grok" }));

        const calls = await grokHistoryReader.analysis.callTrace(chat);

        expect(calls.supported && calls.items.map((call) => [call.model, call.output])).toEqual([["m-grok", 1]]);
        expect((await grokHistoryReader.analysis.compactions(chat)).supported).toBe(false);
        expect((await grokHistoryReader.analysis.quotaReadings(chat)).supported).toBe(false);
    });
});
