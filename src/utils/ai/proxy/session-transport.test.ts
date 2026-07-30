import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonFilesBackend, createSessionStore } from "@genesiscz/utils/ai/session";
import type { ChatOptions, ChatResult, StreamCallbacks } from "./AiProxyClient";
import type { ProxyChatClient } from "./session-transport";
import { createProxySession, createProxyTransport } from "./session-transport";

function chatResult(text: string, extra: Partial<ChatResult> = {}): ChatResult {
    return {
        text,
        toolCalls: [],
        model: "test/model",
        elapsedMs: 1,
        raw: {},
        ...extra,
    };
}

/** Records every request and replies from a script. */
function fakeClient(replies: Array<ChatResult | ((options: ChatOptions) => Promise<ChatResult>)>): {
    client: ProxyChatClient;
    calls: ChatOptions[];
    streamed: number;
} {
    const calls: ChatOptions[] = [];
    const state = { streamed: 0 };
    let index = 0;

    const next = async (options: ChatOptions): Promise<ChatResult> => {
        calls.push({ ...options, messages: [...options.messages] });
        const reply = replies[index++];

        if (!reply) {
            throw new Error(`client called ${index} times, script has ${replies.length}`);
        }

        return typeof reply === "function" ? reply(options) : reply;
    };

    return {
        calls,
        get streamed() {
            return state.streamed;
        },
        client: {
            chat: next,
            chatStream: async (options: ChatOptions, callbacks: StreamCallbacks = {}) => {
                state.streamed += 1;
                const result = await next(options);
                callbacks.onDelta?.(result.text);

                return result;
            },
        },
    };
}

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gt-proxy-session-"));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe("proxy transport", () => {
    test("sends the system prompt and history in the proxy's message shape", async () => {
        const fake = fakeClient([chatResult("hello")]);
        const transport = createProxyTransport({ client: fake.client, model: "anthropic/sonnet" });

        const result = await transport.run({
            system: "be terse",
            messages: [
                { role: "user", content: "q1" },
                { role: "assistant", content: "a1" },
                { role: "user", content: "q2" },
            ],
        });

        expect(result.text).toBe("hello");
        expect(fake.calls[0].model).toBe("anthropic/sonnet");
        expect(fake.calls[0].messages).toEqual([
            { role: "system", content: "be terse" },
            { role: "user", content: "q1" },
            { role: "assistant", content: "a1" },
            { role: "user", content: "q2" },
        ]);
    });

    test("runs the tool loop and feeds results back as tool messages", async () => {
        const handled: string[] = [];
        const fake = fakeClient([
            chatResult("let me look", {
                toolCalls: [{ id: "call_1", name: "search", argumentsJson: '{"q":"x"}', arguments: { q: "x" } }],
            }),
            chatResult("found it"),
        ]);
        const transport = createProxyTransport({
            client: fake.client,
            model: "m",
            toolHandler: (call) => {
                handled.push(call.name);

                return "tool output";
            },
        });

        const result = await transport.run({ messages: [{ role: "user", content: "q" }] });

        expect(handled).toEqual(["search"]);
        expect(result).toMatchObject({ text: "found it", toolCalls: 1 });
        expect(fake.calls[1].messages).toEqual([
            { role: "user", content: "q" },
            {
                role: "assistant",
                content: "let me look",
                tool_calls: [{ id: "call_1", type: "function", function: { name: "search", arguments: '{"q":"x"}' } }],
            },
            { role: "tool", content: "tool output", tool_call_id: "call_1" },
        ]);
    });

    test("stops the tool loop at maxRounds", async () => {
        const toolCall = { id: "c", name: "loop", argumentsJson: "{}", arguments: {} };
        const fake = fakeClient([
            chatResult("1", { toolCalls: [toolCall] }),
            chatResult("2", { toolCalls: [toolCall] }),
            chatResult("3", { toolCalls: [toolCall] }),
        ]);
        const transport = createProxyTransport({
            client: fake.client,
            model: "m",
            maxRounds: 2,
            toolHandler: () => "out",
        });

        const result = await transport.run({ messages: [{ role: "user", content: "q" }] });

        expect(fake.calls).toHaveLength(3);
        expect(result.toolCalls).toBe(2);
    });

    test("maps proxy usage and passes the abort flag through", async () => {
        const fake = fakeClient([
            chatResult("partial", {
                aborted: true,
                usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
            }),
        ]);
        const transport = createProxyTransport({ client: fake.client, model: "m" });

        const result = await transport.run({ messages: [{ role: "user", content: "q" }] });

        expect(result.aborted).toBe(true);
        expect(result.usage).toMatchObject({ inputTokens: 4, outputTokens: 2, totalTokens: 6 });
        expect(result.raw).toMatchObject({ text: "partial" });
    });

    test("streams by default and honours stream: false", async () => {
        const streaming = fakeClient([chatResult("s")]);
        const chunks: string[] = [];
        await createProxyTransport({ client: streaming.client, model: "m" }).run({
            messages: [{ role: "user", content: "q" }],
            callbacks: { onChunk: (chunk) => chunks.push(chunk) },
        });
        expect(streaming.streamed).toBe(1);
        expect(chunks).toEqual(["s"]);

        const plain = fakeClient([chatResult("p")]);
        await createProxyTransport({ client: plain.client, model: "m", stream: false }).run({
            messages: [{ role: "user", content: "q" }],
        });
        expect(plain.streamed).toBe(0);
    });
});

describe("proxy sessions", () => {
    test("a proxy-backed agent persists its turns and resumes them", async () => {
        const store = createSessionStore(createJsonFilesBackend({ dir }));
        const first = fakeClient([chatResult("a1")]);
        const agent = createProxySession({
            client: first.client,
            model: "m",
            system: "be terse",
            session: { store, owner: "u", title: "proxy-chat" },
        });

        expect((await agent.send("q1")).text).toBe("a1");

        const record = await agent.session();
        expect((await store.history(record?.id ?? "")).map((m) => m.content)).toEqual(["q1", "a1"]);

        const second = fakeClient([chatResult("a2")]);
        const resumed = createProxySession({
            client: second.client,
            model: "m",
            system: "be terse",
            session: { store, owner: "u", title: "proxy-chat" },
        });
        await resumed.send("q2");

        expect(second.calls[0].messages).toEqual([
            { role: "system", content: "be terse" },
            { role: "user", content: "q1" },
            { role: "assistant", content: "a1" },
            { role: "user", content: "q2" },
        ]);
    });

    test("interject abandons the in-flight proxy turn and asks the new question", async () => {
        const fake = fakeClient([
            (options) =>
                new Promise((resolve) => {
                    options.signal?.addEventListener("abort", () => {
                        resolve(chatResult("half", { aborted: true }));
                    });
                }),
            chatResult("new answer"),
        ]);
        const agent = createProxySession({ client: fake.client, model: "m" });

        const inFlight = agent.send("slow");
        await Bun.sleep(5);
        await agent.interject("never mind, this");
        const turn = await inFlight;

        expect(turn.text).toBe("new answer");
        expect(fake.calls[1].messages).toEqual([
            { role: "user", content: "slow" },
            { role: "assistant", content: "half" },
            { role: "user", content: "never mind, this" },
        ]);
    });
});
