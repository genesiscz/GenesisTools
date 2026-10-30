import { describe, expect, it } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { parseStatuslineInput, statuslineInputFrom } from "./statusline-input";

describe("StatuslineInput", () => {
    it("types every field Claude Code sends, from snake_case keys", () => {
        const input = statuslineInputFrom({
            session_id: "sess-a",
            transcript_path: "/fixture/sess-a.jsonl",
            cwd: "/fallback",
            workspace: { current_dir: "/repo/sub", project_dir: "/repo" },
            model: { id: "model-x", display_name: "Model X" },
            cost: { total_cost_usd: 1.25 },
            effort: { level: "high" },
            context_window: {
                total_input_tokens: 25_000,
                context_window_size: 200_000,
                current_usage: { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 },
            },
            agent: { name: "worker" },
        });

        expect(input).toMatchObject({
            sessionId: "sess-a",
            transcriptPath: "/fixture/sess-a.jsonl",
            cwd: "/repo/sub",
            projectDir: "/repo",
            model: { id: "model-x", displayName: "Model X" },
            totalCostUsd: 1.25,
            effortLevel: "high",
            contextWindow: {
                totalInputTokens: 25_000,
                size: 200_000,
                currentUsage: { inputTokens: 1, cacheCreationInputTokens: 2, cacheReadInputTokens: 3 },
            },
            agentName: "worker",
        });
    });

    it("reads the camelCase twins, falls back to the top-level cwd, and drops empty or mistyped values", () => {
        const input = statuslineInputFrom({
            sessionId: "sess-b",
            transcriptPath: "",
            cwd: "/repo",
            model: { displayName: "Model Y", id: 7 },
            contextWindow: { context_window_size: "big" },
        });

        expect(input.sessionId).toBe("sess-b");
        expect(input.transcriptPath).toBeUndefined();
        expect(input.cwd).toBe("/repo");
        expect(input.model).toEqual({ id: undefined, displayName: "Model Y" });
        expect(input.contextWindow).toEqual({ totalInputTokens: undefined, size: undefined, currentUsage: undefined });
        expect(input.agentName).toBeUndefined();
    });

    it("parses stdin text and returns null for empty, malformed or non-object input", () => {
        expect(parseStatuslineInput(SafeJSON.stringify({ session_id: "sess-c" }))?.sessionId).toBe("sess-c");
        expect(parseStatuslineInput("  \n")).toBeNull();
        expect(parseStatuslineInput("{not json")).toBeNull();
        expect(parseStatuslineInput("[1, 2]")).toBeNull();
    });
});
