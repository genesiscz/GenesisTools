import { describe, expect, it, spyOn } from "bun:test";
import {
    CLAUDE_CODE_AGENT_TOOL,
    CLAUDE_CODE_COMPACTION_MARK,
    ClaudeCodeTurn,
    sessionAgentModelWins,
} from "@app/ai-proxy/lib/translators/formats/anthropic/claude-code-turns";
import {
    grokResponsesSseToAnthropic,
    grokResponsesToAnthropicMessage,
    responsesSseToAnthropic,
    responsesToAnthropicMessage,
} from "@app/ai-proxy/lib/translators/formats/anthropic/grok-responses-to-anthropic";
import {
    packReasoningSignature,
    unpackReasoningSignature,
} from "@app/ai-proxy/lib/translators/formats/anthropic/reasoning-codec";
import { extractUsageFromJsonBody } from "@app/ai-proxy/lib/usage/extract";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

interface Frame {
    event: string;
    data: Record<string, unknown>;
}

function sse(events: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const text = events.map((event) => `event: ${event.type}\ndata: ${SafeJSON.stringify(event)}\n\n`).join("");

    return new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(text));
            controller.close();
        },
    });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<{ raw: string; frames: Frame[] }> {
    const raw = await new Response(stream).text();
    const frames: Frame[] = [];

    for (const chunk of raw.split("\n\n")) {
        const eventLine = chunk.split("\n").find((line) => line.startsWith("event: "));
        const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));

        if (eventLine && dataLine) {
            frames.push({
                event: eventLine.slice(7),
                data: SafeJSON.parse(dataLine.slice(6), { strict: true }) as Record<string, unknown>,
            });
        }
    }

    return { raw, frames };
}

function frameSummary(frames: Frame[]): string[] {
    return frames.map((frame) => {
        if (frame.event === "content_block_start") {
            const block = frame.data.content_block as Record<string, unknown>;
            return `start[${frame.data.index}]:${block.type}${block.name ? `:${block.name}` : ""}`;
        }

        if (frame.event === "content_block_delta") {
            const delta = frame.data.delta as Record<string, unknown>;
            return `delta[${frame.data.index}]:${delta.type}`;
        }

        if (frame.event === "content_block_stop") {
            return `stop[${frame.data.index}]`;
        }

        return frame.event;
    });
}

// The wire shape captured live 2026-08-21: one reasoning item (summary deltas,
// encrypted_content on the done frame), then each function_call as its own
// output item with its name on the added frame.
const REASONING_DONE = {
    type: "reasoning",
    id: "rs_1",
    summary: [{ type: "summary_text", text: "I should call both tools." }],
    status: "completed",
    encrypted_content: "ENC==",
};

const CALL_A_DONE = {
    type: "function_call",
    call_id: "call-a-0",
    name: "list_agents",
    arguments: "{}",
    status: "completed",
};

const CALL_B_DONE = {
    type: "function_call",
    call_id: "call-a-1",
    name: "run_command",
    arguments: '{"command":"date"}',
    status: "completed",
};

const COMPLETED = {
    type: "response.completed",
    response: {
        id: "resp_1",
        status: "completed",
        output: [REASONING_DONE, CALL_A_DONE, CALL_B_DONE],
        usage: {
            input_tokens: 1000,
            input_tokens_details: { cached_tokens: 384 },
            output_tokens: 50,
            total_tokens: 1050,
        },
    },
};

describe("grokResponsesSseToAnthropic", () => {
    it("gives every output item its own named content block", async () => {
        const { frames } = await collect(
            grokResponsesSseToAnthropic(
                sse([
                    { type: "response.created", response: { id: "resp_1" } },
                    { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1" } },
                    { type: "response.reasoning_summary_part.added", output_index: 0 },
                    { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "I should call " },
                    { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "both tools." },
                    { type: "response.output_item.done", output_index: 0, item: REASONING_DONE },
                    {
                        type: "response.output_item.added",
                        output_index: 1,
                        item: { type: "function_call", call_id: "call-a-0", name: "list_agents", arguments: "" },
                    },
                    { type: "response.function_call_arguments.delta", output_index: 1, delta: "{}" },
                    { type: "response.output_item.done", output_index: 1, item: CALL_A_DONE },
                    {
                        type: "response.output_item.added",
                        output_index: 2,
                        item: { type: "function_call", call_id: "call-a-1", name: "run_command", arguments: "" },
                    },
                    { type: "response.function_call_arguments.delta", output_index: 2, delta: '{"command":' },
                    { type: "response.function_call_arguments.delta", output_index: 2, delta: '"date"}' },
                    { type: "response.output_item.done", output_index: 2, item: CALL_B_DONE },
                    COMPLETED,
                ]),
                { model: "grok-4.6" }
            )
        );

        expect(frameSummary(frames)).toEqual([
            "message_start",
            "start[0]:thinking",
            "delta[0]:thinking_delta",
            "delta[0]:thinking_delta",
            "delta[0]:signature_delta",
            "stop[0]",
            "start[1]:tool_use:list_agents",
            "delta[1]:input_json_delta",
            "stop[1]",
            "start[2]:tool_use:run_command",
            "delta[2]:input_json_delta",
            "delta[2]:input_json_delta",
            "stop[2]",
            "message_delta",
            "message_stop",
        ]);

        const starts = frames.filter((frame) => frame.event === "content_block_start");
        expect((starts[1].data.content_block as Record<string, unknown>).id).toBe("call-a-0");
        expect((starts[2].data.content_block as Record<string, unknown>).id).toBe("call-a-1");

        // The signature round-trips the encrypted reasoning verbatim.
        const signatureDelta = frames.find(
            (frame) =>
                frame.event === "content_block_delta" &&
                (frame.data.delta as Record<string, unknown>).type === "signature_delta"
        );
        const signature = (signatureDelta?.data.delta as Record<string, unknown> | undefined)?.signature;
        expect(unpackReasoningSignature(signature)).toEqual({ id: "rs_1", encryptedContent: "ENC==" });

        const messageDelta = frames.find((frame) => frame.event === "message_delta");
        expect((messageDelta?.data.delta as Record<string, unknown> | undefined)?.stop_reason).toBe("tool_use");
        expect(messageDelta?.data.usage).toEqual({
            input_tokens: 616,
            output_tokens: 50,
            cache_read_input_tokens: 384,
        });
    });

    it("synthesizes an item that only appears in the terminal snapshot", async () => {
        const { frames } = await collect(
            grokResponsesSseToAnthropic(
                sse([
                    { type: "response.created", response: { id: "resp_1" } },
                    { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1" } },
                    { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "thinking…" },
                    { type: "response.output_item.done", output_index: 0, item: REASONING_DONE },
                    // call-a-0 streamed; call-a-1 arrives ONLY in the snapshot.
                    {
                        type: "response.output_item.added",
                        output_index: 1,
                        item: { type: "function_call", call_id: "call-a-0", name: "list_agents", arguments: "" },
                    },
                    { type: "response.function_call_arguments.delta", output_index: 1, delta: "{}" },
                    { type: "response.output_item.done", output_index: 1, item: CALL_A_DONE },
                    COMPLETED,
                ]),
                { model: "grok-4.6" }
            )
        );

        const summary = frameSummary(frames);
        expect(summary).toContain("start[2]:tool_use:run_command");
        expect(summary.filter((entry) => entry === "delta[2]:input_json_delta")).toHaveLength(1);

        const salvaged = frames.find(
            (frame) =>
                frame.event === "content_block_delta" &&
                frame.data.index === 2 &&
                (frame.data.delta as Record<string, unknown>).type === "input_json_delta"
        );
        expect((salvaged?.data.delta as Record<string, unknown> | undefined)?.partial_json).toBe('{"command":"date"}');
    });

    it("closes the message when the stream ends without a terminal frame", async () => {
        const { frames } = await collect(
            grokResponsesSseToAnthropic(
                sse([
                    { type: "response.created", response: { id: "resp_1" } },
                    {
                        type: "response.output_item.added",
                        output_index: 0,
                        item: { type: "function_call", call_id: "call-a-0", name: "list_agents", arguments: "" },
                    },
                    { type: "response.function_call_arguments.delta", output_index: 0, delta: "{}" },
                    // no output_item.done, no response.completed — the 1-in-38 case
                ]),
                { model: "grok-4.6" }
            )
        );

        expect(frameSummary(frames)).toEqual([
            "message_start",
            "start[0]:tool_use:list_agents",
            "delta[0]:input_json_delta",
            "stop[0]",
            "message_delta",
            "message_stop",
        ]);

        const messageDelta = frames.find((frame) => frame.event === "message_delta");
        expect((messageDelta?.data.delta as Record<string, unknown> | undefined)?.stop_reason).toBe("tool_use");
    });

    it("forwards keepalive comments and turns response.failed into an Anthropic error frame", async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode(": keepalive\n"));
                controller.enqueue(
                    encoder.encode(
                        `data: ${SafeJSON.stringify({
                            type: "response.failed",
                            response: { error: { message: "upstream exploded" } },
                        })}\n\n`
                    )
                );
                controller.close();
            },
        });

        const { raw, frames } = await collect(grokResponsesSseToAnthropic(stream, { model: "grok-4.6" }));

        expect(raw).toContain(": keepalive");
        const error = frames.find((frame) => frame.event === "error");
        expect((error?.data.error as Record<string, unknown> | undefined)?.message).toBe("upstream exploded");
        // A failed response never fabricates a message_stop.
        expect(frames.some((frame) => frame.event === "message_stop")).toBe(false);
    });

    it("logs a client that stops reading as a stop, not as a failed translation", async () => {
        const encoder = new TextEncoder();
        // An upstream that never ends, as a long Codex turn of a subagent that Claude Code stops.
        const upstream = new ReadableStream<Uint8Array>({
            start(controller) {
                for (const event of [
                    { type: "response.created", response: { id: "resp_1" } },
                    {
                        type: "response.output_item.added",
                        output_index: 0,
                        item: { type: "message", role: "assistant" },
                    },
                    { type: "response.output_text.delta", output_index: 0, delta: "Hi" },
                ]) {
                    controller.enqueue(encoder.encode(`data: ${SafeJSON.stringify(event)}\n\n`));
                }
            },
            cancel() {
                throw new Error("The connection was closed.");
            },
        });
        const warn = spyOn(logger, "warn");
        let notifyStop: () => void = () => {};
        const stopped = new Promise<void>((resolve) => {
            notifyStop = resolve;
        });
        const debug = spyOn(logger, "debug").mockImplementation((...args: unknown[]) => {
            if (args.some((arg) => typeof arg === "string" && arg.includes("client stopped the stream"))) {
                notifyStop();
            }
        });
        let timer: ReturnType<typeof setTimeout> | undefined;

        try {
            const reader = responsesSseToAnthropic(upstream, { model: "gpt-6.1-terra", label: "codex" }).getReader();
            await reader.read();
            await reader.cancel("subagent stopped");
            await Promise.race([
                stopped,
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error("stop was not logged")), 2_000);
                }),
            ]);
            expect(
                warn.mock.calls.some((call) =>
                    call.some((arg) => typeof arg === "string" && arg.includes("SSE translation failed"))
                )
            ).toBe(false);
        } finally {
            if (timer) {
                clearTimeout(timer);
            }

            warn.mockRestore();
            debug.mockRestore();
        }
    });

    it("distinguishes an aborted upstream read from an independent upstream failure", async () => {
        const warn = spyOn(logger, "warn");
        const debug = spyOn(logger, "debug");
        try {
            for (const aborted of [true, false]) {
                const abort = new AbortController();
                if (aborted) {
                    abort.abort();
                }

                const upstream = new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.error(new Error("read failed"));
                    },
                });
                const reader = responsesSseToAnthropic(upstream, {
                    model: "gpt-6.1-terra",
                    label: "codex",
                    signal: abort.signal,
                }).getReader();
                await expect(reader.read()).rejects.toThrow("read failed");
                const warned = warn.mock.calls.some((call) =>
                    call.some((arg) => typeof arg === "string" && arg.includes("SSE translation failed"))
                );
                expect(warned).toBe(!aborted);
                warn.mockClear();
            }
        } finally {
            warn.mockRestore();
            debug.mockRestore();
        }
    });

    it("streams text deltas into a text block", async () => {
        const { frames } = await collect(
            grokResponsesSseToAnthropic(
                sse([
                    { type: "response.created", response: { id: "resp_1" } },
                    {
                        type: "response.output_item.added",
                        output_index: 0,
                        item: { type: "message", role: "assistant" },
                    },
                    { type: "response.output_text.delta", output_index: 0, delta: "Hello " },
                    { type: "response.output_text.delta", output_index: 0, delta: "world" },
                    {
                        type: "response.output_item.done",
                        output_index: 0,
                        item: { type: "message", content: [{ type: "output_text", text: "Hello world" }] },
                    },
                    {
                        type: "response.completed",
                        response: {
                            id: "resp_1",
                            status: "completed",
                            output: [{ type: "message", content: [{ type: "output_text", text: "Hello world" }] }],
                            usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
                        },
                    },
                ]),
                { model: "grok-4.6" }
            )
        );

        expect(frameSummary(frames)).toEqual([
            "message_start",
            "start[0]:text",
            "delta[0]:text_delta",
            "delta[0]:text_delta",
            "stop[0]",
            "message_delta",
            "message_stop",
        ]);

        const messageDelta = frames.find((frame) => frame.event === "message_delta");
        expect((messageDelta?.data.delta as Record<string, unknown> | undefined)?.stop_reason).toBe("end_turn");
    });
});

describe("grokResponsesToAnthropicMessage", () => {
    it("maps the whole envelope, packing the reasoning signature", () => {
        const message = grokResponsesToAnthropicMessage(
            {
                id: "resp_9",
                status: "completed",
                output: [
                    REASONING_DONE,
                    { type: "message", content: [{ type: "output_text", text: "running it" }] },
                    CALL_B_DONE,
                ],
                usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
            },
            { model: "grok-4.6" }
        );

        expect(message.content).toEqual([
            {
                type: "thinking",
                thinking: "I should call both tools.",
                signature: packReasoningSignature("rs_1", "ENC=="),
            },
            { type: "text", text: "running it" },
            { type: "tool_use", id: "call-a-1", name: "run_command", input: { command: "date" } },
        ]);
        expect(message.stop_reason).toBe("tool_use");
        expect(message.usage).toEqual({ input_tokens: 100, output_tokens: 20 });
    });

    it("keeps the reasoning share of the output in the usage, for the ledger", () => {
        const message = grokResponsesToAnthropicMessage(
            {
                id: "resp_10",
                status: "completed",
                output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }],
                usage: {
                    input_tokens: 100,
                    output_tokens: 20,
                    output_tokens_details: { reasoning_tokens: 12 },
                    total_tokens: 120,
                },
            },
            { model: "gpt-6.1-sol" }
        );

        expect(message.usage).toEqual({
            input_tokens: 100,
            output_tokens: 20,
            output_tokens_details: { reasoning_tokens: 12 },
        });
        expect(extractUsageFromJsonBody(SafeJSON.stringify(message))?.reasoning_tokens).toBe(12);
    });

    it("reports max_tokens when the response is incomplete for that reason", () => {
        const message = grokResponsesToAnthropicMessage(
            {
                id: "resp_9",
                status: "incomplete",
                incomplete_details: { reason: "max_output_tokens" },
                output: [{ type: "message", content: [{ type: "output_text", text: "truncat" }] }],
            },
            { model: "grok-4.6" }
        );

        expect(message.stop_reason).toBe("max_tokens");
    });
});

describe("a message never ends on a thinking block (Claude Code drops it, and the reasoning with it)", () => {
    const reasoning = {
        type: "reasoning",
        id: "rs_only",
        summary: [{ type: "summary_text", text: "cut off while thinking" }],
        encrypted_content: "blob",
    };

    it("streaming: a reasoning-only answer gets an empty text block after the thinking block", async () => {
        const { frames } = await collect(
            grokResponsesSseToAnthropic(
                sse([
                    { type: "response.output_item.added", output_index: 0, item: { ...reasoning, summary: [] } },
                    { type: "response.output_item.done", output_index: 0, item: reasoning },
                    { type: "response.incomplete", response: { status: "incomplete", output: [reasoning] } },
                ]),
                { model: "grok-x" }
            )
        );
        const starts = frames
            .filter((frame) => frame.event === "content_block_start")
            .map((frame) => (frame.data.content_block as Record<string, unknown>).type);

        expect(starts).toEqual(["thinking", "text"]);
    });

    it("non-streaming: the same", () => {
        const message = grokResponsesToAnthropicMessage(
            { status: "incomplete", output: [reasoning] },
            { model: "grok-x" }
        );

        expect((message.content as Array<{ type: string }>).map((block) => block.type)).toEqual(["thinking", "text"]);
    });
});

describe("a session's own subagents run on their own model", () => {
    const toolInput = (name: string) =>
        name === CLAUDE_CODE_AGENT_TOOL ? sessionAgentModelWins(new Set(["sol", "opus"])) : undefined;

    function agentCall(id: string, outputIndex: number, name: string, args: Record<string, unknown>) {
        const json = SafeJSON.stringify(args);
        const item = { type: "function_call", id, call_id: `call_${id}`, name, arguments: "" };

        return [
            { type: "response.output_item.added", output_index: outputIndex, item },
            { type: "response.function_call_arguments.delta", output_index: outputIndex, delta: json.slice(0, 20) },
            { type: "response.function_call_arguments.delta", output_index: outputIndex, delta: json.slice(20) },
            { type: "response.output_item.done", output_index: outputIndex, item: { ...item, arguments: json } },
        ];
    }

    function inputs(frames: Frame[]): Record<string, unknown>[] {
        const byIndex = new Map<number, string>();

        for (const frame of frames) {
            const delta = frame.data.delta as Record<string, unknown> | undefined;

            if (frame.event === "content_block_delta" && delta?.type === "input_json_delta") {
                const index = Number(frame.data.index);
                byIndex.set(index, (byIndex.get(index) ?? "") + String(delta.partial_json));
            }
        }

        return [...byIndex.values()].map((json) => SafeJSON.parse(json, { strict: true }) as Record<string, unknown>);
    }

    it("streaming: drops the Agent call's model for a session subagent, keeps it for others and leaves other tools alone", async () => {
        const { frames } = await collect(
            responsesSseToAnthropic(
                sse([
                    { type: "response.created", response: { id: "resp_1" } },
                    ...agentCall("a", 0, "Agent", { prompt: "go", subagent_type: "sol", model: "sonnet" }),
                    ...agentCall("b", 1, "Agent", { prompt: "go", subagent_type: "Explore", model: "haiku" }),
                    ...agentCall("c", 2, "Bash", { command: "echo ok", model: "kept" }),
                    {
                        type: "response.completed",
                        response: { id: "resp_1", usage: { input_tokens: 1, output_tokens: 1 } },
                    },
                ]),
                { model: "gpt-6.1-sol", label: "codex", toolInput }
            )
        );

        expect(inputs(frames)).toEqual([
            { prompt: "go", subagent_type: "sol" },
            { prompt: "go", subagent_type: "Explore", model: "haiku" },
            { command: "echo ok", model: "kept" },
        ]);
    });

    it("non-streaming: the same", () => {
        const message = responsesToAnthropicMessage(
            {
                id: "resp_1",
                status: "completed",
                output: [
                    {
                        type: "function_call",
                        call_id: "call_a",
                        name: "Agent",
                        arguments: SafeJSON.stringify({ prompt: "go", subagent_type: "opus", model: "opus" }),
                    },
                ],
            },
            { model: "gpt-6.1-sol", label: "codex", toolInput }
        );

        expect((message.content as Array<Record<string, unknown>>)[0]?.input).toEqual({
            prompt: "go",
            subagent_type: "opus",
        });
    });
});

describe("Claude Code compaction detection gaps", () => {
    const prompt = { role: "user", content: [{ type: "text", text: `${CLAUDE_CODE_COMPACTION_MARK}\nSummarize.` }] };

    it("sees the compaction prompt in a request that does not end on it", () => {
        const body = { messages: [prompt, { role: "assistant", content: "Here is a summary." }] };

        expect(ClaudeCodeTurn.read(body).isCompaction).toBe(false);
        expect(ClaudeCodeTurn.read(body).missedCompaction).toBe(true);
    });

    it("ignores the prompt quoted inside a tool result", () => {
        const quoted = {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: `${CLAUDE_CODE_COMPACTION_MARK} (quoted)` }],
        };

        expect(ClaudeCodeTurn.read({ messages: [quoted] }).missedCompaction).toBe(false);
    });
});

describe("a custom (free-form) tool call as a client tool call", () => {
    const js = 'const r = await tools.exec_command({ cmd: "ls" });\ntext(r.output);';
    const customToolCall = (name: string) =>
        name === "exec" ? { name: "Bash", input: (raw: string) => ({ command: `RUN ${raw}`, timeout: 1 }) } : undefined;
    const item = { type: "custom_tool_call", id: "ctc_1", call_id: "call_exec", name: "exec", input: js };
    const streamed = [
        { type: "response.output_item.added", output_index: 0, item: { ...item, input: "" } },
        { type: "response.custom_tool_call_input.delta", output_index: 0, item_id: "ctc_1", delta: js.slice(0, 20) },
        { type: "response.custom_tool_call_input.delta", output_index: 0, item_id: "ctc_1", delta: js.slice(20) },
        { type: "response.custom_tool_call_input.done", output_index: 0, item_id: "ctc_1", input: js },
        { type: "response.output_item.done", output_index: 0, item },
    ];

    function toolUse(frames: Frame[]): { start?: Record<string, unknown>; input: string; stop?: unknown } {
        const start = frames.find((frame) => frame.event === "content_block_start")?.data.content_block as
            | Record<string, unknown>
            | undefined;
        const input = frames
            .map((frame) => frame.data.delta as Record<string, unknown> | undefined)
            .filter((delta) => delta?.type === "input_json_delta")
            .map((delta) => String(delta?.partial_json))
            .join("");
        const stop = (frames.find((frame) => frame.event === "message_delta")?.data.delta as Record<string, unknown>)
            ?.stop_reason;

        return { start, input, stop };
    }

    it("streaming: one tool_use of the client tool, its input built once from the whole script", async () => {
        const { frames } = await collect(
            responsesSseToAnthropic(
                sse([...streamed, { type: "response.completed", response: { status: "completed", output: [item] } }]),
                { model: "gpt-6.1-sol", customToolCall }
            )
        );
        const call = toolUse(frames);

        expect(call.start).toEqual({ type: "tool_use", id: "call_exec", name: "Bash", input: {} });
        expect(SafeJSON.parse(call.input, { strict: true })).toEqual({ command: `RUN ${js}`, timeout: 1 });
        expect(call.stop).toBe("tool_use");
    });

    it("streaming: a call seen only in the terminal snapshot, or with no done frame, still comes whole", async () => {
        const snapshotOnly = await collect(
            responsesSseToAnthropic(
                sse([{ type: "response.completed", response: { status: "completed", output: [item] } }]),
                { model: "gpt-6.1-sol", customToolCall }
            )
        );
        const deltasOnly = await collect(
            responsesSseToAnthropic(sse(streamed.slice(0, 3)), { model: "gpt-6.1-sol", customToolCall })
        );

        for (const { frames } of [snapshotOnly, deltasOnly]) {
            expect(SafeJSON.parse(toolUse(frames).input, { strict: true })).toEqual({
                command: `RUN ${js}`,
                timeout: 1,
            });
            expect(toolUse(frames).stop).toBe("tool_use");
        }
    });

    it("streaming: without a mapping the custom call is skipped and the turn ends normally", async () => {
        const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
        const { frames } = await collect(
            responsesSseToAnthropic(
                sse([...streamed, { type: "response.completed", response: { status: "completed", output: [item] } }]),
                { model: "gpt-6.1-sol" }
            )
        );
        warn.mockRestore();

        expect(frames.some((frame) => frame.event === "content_block_start")).toBe(false);
    });

    it("non-streaming: the same tool_use, and stop_reason tool_use", () => {
        const message = responsesToAnthropicMessage(
            { id: "resp_1", status: "completed", output: [item] },
            { model: "gpt-6.1-sol", customToolCall }
        );

        expect(message.content).toEqual([
            { type: "tool_use", id: "call_exec", name: "Bash", input: { command: `RUN ${js}`, timeout: 1 } },
        ]);
        expect(message.stop_reason).toBe("tool_use");
    });
});
