import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { claudeDriver } from "./claude";
import { billedCost, collectEvents } from "./driver-test-helpers";
import { isolateAgentHomeEnv } from "./test-env";

// An ambient CLAUDE_CONFIG_DIR adds a third root and would break the exact list below.
isolateAgentHomeEnv();

function line(id: string, usage: Record<string, number>): string {
    return SafeJSON.stringify({
        type: "assistant",
        timestamp: "2026-08-27T09:00:00.000Z",
        cwd: "/tmp/proj",
        sessionId: "sess-1",
        message: { id, model: "claude-3-5-haiku", usage },
    });
}

describe("claude driver", () => {
    test("reads the four disjoint token fields off an assistant line", () => {
        const events = collectEvents(claudeDriver, [
            line("msg-a", {
                input_tokens: 1_000_000,
                output_tokens: 500_000,
                cache_creation_input_tokens: 200_000,
                cache_read_input_tokens: 4_000_000,
            }),
        ]);

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            id: "msg-a",
            model: "claude-3-5-haiku",
            inputTokens: 1_000_000,
            outputTokens: 500_000,
            cacheCreationTokens: 200_000,
            cacheReadTokens: 4_000_000,
        });
        // claude-3-5-haiku: $0.8 in · $4 out · $1.0 cacheWrite · $0.08 cacheRead per Mtok.
        // 0.80 + 2.00 + 0.20 + 0.32 = $3.32
        expect(billedCost(claudeDriver, events[0])).toBeCloseTo(3.32, 10);
    });

    test("ignores non-assistant lines and lines without usage", () => {
        const events = collectEvents(claudeDriver, [
            SafeJSON.stringify({ type: "user", timestamp: "2026-08-27T09:00:00.000Z", message: { id: "u1" } }),
            SafeJSON.stringify({ type: "assistant", timestamp: "2026-08-27T09:00:00.000Z", message: { id: "m1" } }),
            "",
            "{ not json",
        ]);

        expect(events).toEqual([]);
    });

    test("a line with no timestamp still emits, and the monitor drops it without burning the id", () => {
        // `parseTranscriptLine` defaults a missing timestamp to "". The driver passes
        // that through; rejecting it is `parseChunk`'s job, and it must reject BEFORE
        // recording the id — see monitor.test.ts for the end-to-end assertion.
        const events = collectEvents(claudeDriver, [
            SafeJSON.stringify({
                type: "assistant",
                cwd: "/tmp/p",
                message: { id: "msg-x", usage: { input_tokens: 5 } },
            }),
        ]);

        expect(events).toHaveLength(1);
        expect(events[0].timestamp).toBe("");
        expect(Number.isNaN(new Date(events[0].timestamp).getTime())).toBe(true);
    });

    test("roots cover both fixed trees, and every .jsonl counts", () => {
        expect(claudeDriver.roots("/home/u")).toEqual(["/home/u/.claude/projects", "/home/u/.config/claude/projects"]);
        expect(claudeDriver.isTranscript("s1.jsonl")).toBe(true);
        expect(claudeDriver.isTranscript("notes.txt")).toBe(false);
    });

    test("price candidates strip a dated variant suffix", () => {
        expect(claudeDriver.priceCandidates("claude-opus-4-5-20251101")).toEqual([
            "claude-opus-4-5-20251101",
            "claude-opus-4-5",
        ]);
        expect(claudeDriver.priceCandidates("claude-3-5-haiku")).toEqual(["claude-3-5-haiku"]);
    });
});
