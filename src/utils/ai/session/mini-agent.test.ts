import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelUsage, ModelMessage } from "ai";
import { createJsonFilesBackend } from "./backends/json-files";
import type { AgentTransport, AgentTransportRequest, AgentTransportResult } from "./mini-agent";
import { createMiniAgent, toModelMessages } from "./mini-agent";
import { createSessionStore } from "./store";
import { SessionBusyError } from "./types";

/** Replies from a script; each entry sees the request it was given. */
function scripted(steps: Array<(request: AgentTransportRequest) => Promise<AgentTransportResult>>): {
    transport: AgentTransport;
    seen: AgentTransportRequest[];
} {
    const seen: AgentTransportRequest[] = [];
    let index = 0;

    return {
        seen,
        transport: {
            async run(request) {
                seen.push({ ...request, messages: [...request.messages] });
                const step = steps[index++];

                if (!step) {
                    throw new Error(`transport called ${index} times, script has ${steps.length}`);
                }

                return step(request);
            },
        },
    };
}

const reply =
    (text: string, extra: Partial<AgentTransportResult> = {}) =>
    async (): Promise<AgentTransportResult> => ({
        text,
        toolCalls: 0,
        ...extra,
    });

/** The SDK's usage record wants its detail breakdowns present even when empty. */
function usage(counts: { inputTokens?: number; outputTokens?: number; totalTokens?: number }): LanguageModelUsage {
    return {
        inputTokens: counts.inputTokens,
        outputTokens: counts.outputTokens,
        totalTokens: counts.totalTokens,
        inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    };
}

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gt-agent-"));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe("mini-agent", () => {
    test("a turn carries the system prompt, tools and prior context to the transport", async () => {
        const tools = { search: { description: "s", inputSchema: { type: "object" } } };
        const { transport, seen } = scripted([reply("first"), reply("second")]);
        const agent = createMiniAgent({
            transport,
            system: "be terse",
            maxSteps: 3,
            // biome-ignore lint/suspicious/noExplicitAny: a tool stub, not a real ToolSet member
            tools: tools as any,
        });

        expect(await agent.send("q1")).toMatchObject({ text: "first", toolCalls: 0 });
        expect(await agent.send("q2")).toMatchObject({ text: "second" });

        expect(seen[0].system).toBe("be terse");
        expect(seen[0].maxSteps).toBe(3);
        expect(seen[0].tools).toBe(tools as never);
        expect(seen[0].messages).toEqual([{ role: "user", content: "q1" }]);
        expect(seen[1].messages).toEqual([
            { role: "user", content: "q1" },
            { role: "assistant", content: "first" },
            { role: "user", content: "q2" },
        ]);
    });

    test("tool calls and usage aggregate across the turn", async () => {
        const { transport } = scripted([
            reply("done", { toolCalls: 2, usage: usage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }) }),
        ]);
        const agent = createMiniAgent({ transport });

        const turn = await agent.send("q");
        expect(turn.toolCalls).toBe(2);
        expect(turn.usage).toEqual(usage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }));
    });

    test("interject aborts the in-flight turn, keeps its partial text, and sends the new message", async () => {
        const { transport, seen } = scripted([
            async (request) =>
                new Promise((resolve) => {
                    request.signal?.addEventListener("abort", () => {
                        resolve({ text: "half an ans", toolCalls: 1, aborted: true });
                    });
                }),
            reply("answered the interjection", { toolCalls: 1, usage: usage({ totalTokens: 4 }) }),
        ]);
        const agent = createMiniAgent({ transport });

        const inFlight = agent.send("slow question");
        await Bun.sleep(5);
        expect(agent.busy).toBe(true);
        await agent.interject("actually, this instead");
        const turn = await inFlight;

        expect(turn.text).toBe("answered the interjection");
        expect(turn.toolCalls).toBe(2);
        expect(turn.aborted).toBeUndefined();
        expect(agent.busy).toBe(false);
        // The abandoned answer stays in context, exactly as AiProxySession kept it.
        expect(seen[1].messages).toEqual([
            { role: "user", content: "slow question" },
            { role: "assistant", content: "half an ans" },
            { role: "user", content: "actually, this instead" },
        ]);
    });

    test("an aborted turn with nothing queued returns its partial text", async () => {
        const controllerSeen: AbortSignal[] = [];
        const { transport } = scripted([
            async (request) => {
                if (request.signal) {
                    controllerSeen.push(request.signal);
                }

                return { text: "partial", toolCalls: 0, aborted: true };
            },
        ]);
        const agent = createMiniAgent({ transport });

        const turn = await agent.send("q");
        expect(turn).toMatchObject({ text: "partial", aborted: true });
        expect(controllerSeen).toHaveLength(1);
    });

    test("a second send while one is in flight is refused", async () => {
        let release = (): void => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const { transport } = scripted([
            async () => {
                await gate;

                return { text: "a", toolCalls: 0 };
            },
        ]);
        const agent = createMiniAgent({ transport });

        const first = agent.send("q1");
        await Bun.sleep(5);
        await expect(agent.send("q2")).rejects.toBeInstanceOf(SessionBusyError);
        release();
        await first;
    });

    test("model and transport cannot both be named", () => {
        const { transport } = scripted([]);
        expect(() => createMiniAgent({ transport, model: "opus" })).toThrow("not both");
    });
});

describe("mini-agent with a session", () => {
    test("turns persist and a fresh agent resumes them", async () => {
        const store = createSessionStore(createJsonFilesBackend({ dir }));
        const first = scripted([reply("a1", { usage: usage({ totalTokens: 7 }) })]);
        const agent = createMiniAgent({
            transport: first.transport,
            session: { store, owner: "u", title: "resumed" },
        });

        await agent.send("q1");
        const record = await agent.session();
        expect(record?.title).toBe("resumed");

        const history = await store.history(record?.id ?? "");
        expect(history.map((m) => `${m.role}:${m.content}`)).toEqual(["user:q1", "assistant:a1"]);
        expect(history[1].meta).toMatchObject({ usage: { totalTokens: 7 } });

        const second = scripted([reply("a2")]);
        const resumed = createMiniAgent({
            transport: second.transport,
            session: { store, owner: "u", title: "resumed" },
        });
        await resumed.send("q2");

        expect(second.seen[0].messages).toEqual([
            { role: "user", content: "q1" },
            { role: "assistant", content: "a1" },
            { role: "user", content: "q2" },
        ]);
        const after = await store.history(record?.id ?? "");
        expect(after.map((m) => m.content)).toEqual(["q1", "a1", "q2", "a2"]);
    });
});

describe("toModelMessages", () => {
    test("maps session roles onto SDK roles and drops empty config rows", () => {
        const at = Date.now();
        const messages: ModelMessage[] = toModelMessages([
            { id: "0", sessionId: "s", role: "config", content: "", at },
            { id: "1", sessionId: "s", role: "user", content: "q", at },
            { id: "2", sessionId: "s", role: "assistant", content: "a", at },
            { id: "3", sessionId: "s", role: "context", content: "file", at },
            { id: "4", sessionId: "s", role: "tool", content: "result", at },
        ]);

        expect(messages).toEqual([
            { role: "user", content: "q" },
            { role: "assistant", content: "a" },
            { role: "system", content: "file" },
            { role: "system", content: "result" },
        ]);
    });
});
