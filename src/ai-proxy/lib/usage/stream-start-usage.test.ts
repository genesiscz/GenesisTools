import { describe, expect, it } from "bun:test";
import {
    contextTokensOf,
    estimateAnthropicBodyTokens,
    streamUsageOptions,
    ThreadContextMemory,
} from "@app/ai-proxy/lib/usage/stream-start-usage";
import { SafeJSON } from "@genesiscz/utils/json";

const SESSION = "11111111-2222-4333-8444-555555555555";

function claudeCodeBody(system: string, text: string): Record<string, unknown> {
    return {
        system,
        metadata: { user_id: SafeJSON.stringify({ session_id: SESSION }) },
        messages: [{ role: "user", content: text }],
    };
}

describe("ThreadContextMemory", () => {
    it("starts a thread it has never seen with the request's estimate", () => {
        const memory = new ThreadContextMemory();

        expect(memory.startUsage("t", 1200)).toEqual({ input_tokens: 1200, output_tokens: 0 });
        expect(memory.startUsage(undefined, 1200)).toEqual({ input_tokens: 1200, output_tokens: 0 });
    });

    it("starts the next turn with the last real count of the thread, without its output", () => {
        const memory = new ThreadContextMemory();
        memory.remember("t", { input_tokens: 548, cache_read_input_tokens: 291_200, output_tokens: 90 });

        const start = memory.startUsage("t", 250_000);
        expect(start).toEqual({ input_tokens: 548, cache_read_input_tokens: 291_200, output_tokens: 0 });
        expect(contextTokensOf(start)).toBe(291_748);
    });

    it("ignores a usage block that counts no input, so a 0 never replaces a real count", () => {
        const memory = new ThreadContextMemory();
        memory.remember("t", { input_tokens: 548, cache_read_input_tokens: 291_200, output_tokens: 0 });
        memory.remember("t", { input_tokens: 0, output_tokens: 12 });

        expect(contextTokensOf(memory.startUsage("t", 250_000))).toBe(291_748);
    });

    it("takes a lower real count as the new one (a compaction shrank the thread)", () => {
        const memory = new ThreadContextMemory();
        memory.remember("t", { input_tokens: 548, cache_read_input_tokens: 291_200, output_tokens: 0 });
        memory.remember("t", { input_tokens: 31_000, output_tokens: 0 });

        expect(memory.startUsage("t", 30_000)).toEqual({ input_tokens: 31_000, output_tokens: 0 });
    });

    it("uses the estimate when the request is less than half the remembered count", () => {
        const memory = new ThreadContextMemory();
        memory.remember("t", { input_tokens: 548, cache_read_input_tokens: 291_200, output_tokens: 0 });

        expect(memory.startUsage("t", 40_000)).toEqual({ input_tokens: 40_000, output_tokens: 0 });
    });

    it("forgets the oldest thread past its capacity", () => {
        const memory = new ThreadContextMemory(2);
        memory.remember("a", { input_tokens: 10, output_tokens: 0 });
        memory.remember("b", { input_tokens: 20, output_tokens: 0 });
        memory.remember("a", { input_tokens: 11, output_tokens: 0 });
        memory.remember("c", { input_tokens: 30, output_tokens: 0 });

        expect(memory.recall("b")).toBeUndefined();
        expect(memory.recall("a")?.input_tokens).toBe(11);
        expect(memory.recall("c")?.input_tokens).toBe(30);
    });
});

describe("streamUsageOptions", () => {
    it("keeps the main loop and a subagent of one session apart, and one client apart from another", () => {
        const memory = new ThreadContextMemory();
        // About 250K tokens by the estimate, and the subagent about 7.5K: neither request is less than half its remembered count.
        const history = "x".repeat(1_000_000);
        const main = claudeCodeBody("You are Claude Code.", history);
        const subagent = claudeCodeBody("You are a code reviewer.", "y".repeat(30_000));

        streamUsageOptions({ scope: "alice", body: main, memory }).onUsage({ input_tokens: 290_000, output_tokens: 1 });
        streamUsageOptions({ scope: "alice", body: subagent, memory }).onUsage({
            input_tokens: 9000,
            output_tokens: 1,
        });

        expect(streamUsageOptions({ scope: "alice", body: main, memory }).startUsage.input_tokens).toBe(290_000);
        expect(streamUsageOptions({ scope: "alice", body: subagent, memory }).startUsage.input_tokens).toBe(9000);
        expect(streamUsageOptions({ scope: "bob", body: main, memory }).startUsage.input_tokens).toBe(
            estimateAnthropicBodyTokens(main)
        );
    });

    it("keeps two subagents of one type apart, and one thread together when a cache mark moves", () => {
        const memory = new ThreadContextMemory();
        const task = (prompt: string, marked: boolean): Record<string, unknown> => ({
            system: "You are a code reviewer.",
            metadata: { user_id: SafeJSON.stringify({ session_id: SESSION }) },
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: prompt, ...(marked ? { cache_control: { type: "ephemeral" } } : {}) },
                    ],
                },
            ],
        });
        const first = task("y".repeat(30_000), true);
        const second = task("z".repeat(30_000), true);

        streamUsageOptions({ scope: "alice", body: first, memory }).onUsage({ input_tokens: 9000, output_tokens: 1 });
        streamUsageOptions({ scope: "alice", body: second, memory }).onUsage({ input_tokens: 8000, output_tokens: 1 });

        const unmarked = task("y".repeat(30_000), false);
        expect(streamUsageOptions({ scope: "alice", body: unmarked, memory }).startUsage.input_tokens).toBe(9000);
        expect(streamUsageOptions({ scope: "alice", body: second, memory }).startUsage.input_tokens).toBe(8000);
    });

    it("remembers nothing for a request that is not a Claude Code thread", () => {
        const memory = new ThreadContextMemory();
        const body = { messages: [{ role: "user", content: "hello" }] };

        streamUsageOptions({ scope: "alice", body, memory }).onUsage({ input_tokens: 290_000, output_tokens: 1 });

        expect(streamUsageOptions({ scope: "alice", body, memory }).startUsage.input_tokens).toBe(
            estimateAnthropicBodyTokens(body)
        );
    });
});
