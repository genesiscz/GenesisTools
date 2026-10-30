import { describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createAnthropic } from "@ai-sdk/anthropic";
import { anthropicToResponses } from "@app/ai-proxy/lib/translators/formats/anthropic/anthropic-to-responses";
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
import type { AnthropicUsage } from "@app/ai-proxy/lib/translators/formats/anthropic/openai-to-anthropic-responses";
import {
    codexReasoningCodec,
    packReasoningSignature,
    unpackReasoningSignature,
} from "@app/ai-proxy/lib/translators/formats/anthropic/reasoning-codec";
import { accountHash8 } from "@app/ai-proxy/lib/translators/formats/anthropic/reasoning-envelope";
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

    it("streaming: a completed snapshot or input-done frame supplies the complete script", async () => {
        const snapshotOnly = await collect(
            responsesSseToAnthropic(
                sse([{ type: "response.completed", response: { status: "completed", output: [item] } }]),
                { model: "gpt-6.1-sol", customToolCall }
            )
        );
        const inputDone = await collect(
            responsesSseToAnthropic(sse(streamed.slice(0, 4)), { model: "gpt-6.1-sol", customToolCall })
        );

        for (const { frames } of [snapshotOnly, inputDone]) {
            expect(SafeJSON.parse(toolUse(frames).input, { strict: true })).toEqual({
                command: `RUN ${js}`,
                timeout: 1,
            });
            expect(toolUse(frames).stop).toBe("tool_use");
        }
    });

    it("streaming: partial custom input fails without producing an executable tool call", async () => {
        for (const events of [
            streamed.slice(0, 3),
            [
                ...streamed.slice(0, 3),
                { type: "response.incomplete", response: { status: "incomplete", output: [item] } },
            ],
        ]) {
            const { frames } = await collect(
                responsesSseToAnthropic(sse(events), { model: "gpt-6.1-sol", customToolCall })
            );
            expect(frames.some((frame) => frame.event === "error")).toBe(true);
            expect(toolUse(frames).start).toBeUndefined();
            expect(toolUse(frames).input).toBe("");
            expect(toolUse(frames).stop).toBeUndefined();
        }
    });

    it("the Anthropic client reports incomplete input as an error and never yields a tool call", async () => {
        async function clientParts(events: Array<Record<string, unknown>>) {
            const provider = createAnthropic({
                apiKey: "test-key",
                fetch: Object.assign(
                    async () =>
                        new Response(responsesSseToAnthropic(sse(events), { model: "gpt-6.1-sol", customToolCall }), {
                            headers: { "content-type": "text/event-stream" },
                        }),
                    { preconnect: fetch.preconnect }
                ),
            });
            const result = await provider("claude-test").doStream({
                prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }],
            });
            const parts = [];
            for await (const part of result.stream) {
                parts.push(part);
            }
            return parts;
        }

        const incomplete = await clientParts(streamed.slice(0, 3));
        expect(incomplete.some((part) => part.type === "error")).toBe(true);
        expect(incomplete.some((part) => part.type === "tool-call")).toBe(false);
        const complete = await clientParts([
            ...streamed,
            { type: "response.completed", response: { status: "completed", output: [item] } },
        ]);
        expect(complete.some((part) => part.type === "tool-call")).toBe(true);
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

/**
 * A final reply, then a Monitor task notification as the next turn. Observed 2026-10-27 20:07 (Claude Code 2.1.311,
 * gpt-6.1-sol through the Codex `/v1/messages` route): the final reply reached Claude Code as a text block and ended
 * its turn. The notification queued meanwhile then started a new turn, and Claude Code asked "[Your previous response
 * had no visible output…]" about THAT turn's reply: a thinking block with a signature only, an empty text block, and
 * 6 output tokens outside the reasoning, which is the message framing with no text in it (a 28-character reply costs
 * 11 to 12 in the same session). These pin both halves: the final text reaches the client once as a text block, the
 * notification reaches the model as the newest input, and a reply with no text is still reported as empty.
 */
describe("a final reply, then a task notification as the next turn", () => {
    const stamp = { provider: "codex", accountHash: accountHash8("work"), model: "gpt-6.1-sol", compHash: "0" };
    const codex = { model: "gpt-6.1-sol", label: "codex", signReasoning: codexReasoningCodec(stamp).seal };
    const FINAL = "⏳ PENDING\n\nThe test process still holds the shared checkout. Both repair heads pass CI.";
    const NOTIFICATION =
        "<system-reminder>\n<task-notification>\n<task-id>t1</task-id>\n<summary>Monitor event</summary>\n" +
        "<event>[20:07:12] monitor watching app.log</event>\n</task-notification>\n</system-reminder>";

    const reasoning = (id: string) => ({ type: "reasoning", id, summary: [], encrypted_content: `ENC_${id}` });
    const message = (text: string) => ({
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text }],
    });
    const completed = (output: unknown[], usage: Record<string, unknown>) => ({
        type: "response.completed",
        response: { id: "resp_1", status: "completed", output, usage },
    });
    const reasoningFrames = (id: string) => [
        { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id, summary: [] } },
        { type: "response.output_item.done", output_index: 0, item: reasoning(id) },
    ];
    const finalUsage = { input_tokens: 308018, input_tokens_details: { cached_tokens: 306816 }, output_tokens: 351 };

    interface Block {
        type: string;
        text: string;
        thinking: string;
        signature: string;
    }

    /** The message Claude Code builds from the frames: one block per index, its deltas appended. */
    function assemble(frames: Frame[]): Block[] {
        const blocks: Block[] = [];

        for (const frame of frames) {
            const index = frame.data.index;

            if (typeof index !== "number") {
                continue;
            }

            if (frame.event === "content_block_start") {
                const start = frame.data.content_block as Record<string, unknown>;
                blocks[index] = {
                    type: String(start.type),
                    text: typeof start.text === "string" ? start.text : "",
                    thinking: "",
                    signature: "",
                };
                continue;
            }

            const block = blocks[index];
            const delta = frame.data.delta as Record<string, unknown> | undefined;

            if (frame.event !== "content_block_delta" || block === undefined || delta === undefined) {
                continue;
            }

            if (delta.type === "text_delta" && typeof delta.text === "string") {
                block.text += delta.text;
            }

            if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
                block.thinking += delta.thinking;
            }

            if (delta.type === "signature_delta" && typeof delta.signature === "string") {
                block.signature += delta.signature;
            }
        }

        return blocks;
    }

    /** Claude Code's recovery condition as observed: no text block with visible text and no tool call. */
    function hasVisibleOutput(blocks: Block[]): boolean {
        return blocks.some((block) => block.type === "tool_use" || (block.type === "text" && block.text.trim() !== ""));
    }

    function stopReason(frames: Frame[]): unknown {
        const delta = frames.find((frame) => frame.event === "message_delta")?.data.delta;
        return (delta as Record<string, unknown> | undefined)?.stop_reason;
    }

    const shapes: Array<[string, Array<Record<string, unknown>>]> = [
        [
            "deltas, then a done frame and a snapshot that repeat the text (the live WHAM shape)",
            [
                { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
                ...reasoningFrames("rs_final"),
                { type: "response.output_item.added", output_index: 1, item: { type: "message", content: [] } },
                {
                    type: "response.content_part.added",
                    output_index: 1,
                    content_index: 0,
                    part: { type: "output_text", text: "" },
                },
                { type: "response.output_text.delta", output_index: 1, content_index: 0, delta: FINAL.slice(0, 11) },
                { type: "response.output_text.delta", output_index: 1, content_index: 0, delta: FINAL.slice(11, 40) },
                { type: "response.output_text.delta", output_index: 1, content_index: 0, delta: FINAL.slice(40) },
                { type: "response.output_text.done", output_index: 1, content_index: 0, text: FINAL },
                { type: "response.output_item.done", output_index: 1, item: message(FINAL) },
                completed([reasoning("rs_final"), message(FINAL)], finalUsage),
            ],
        ],
        [
            "the text on the done frame only",
            [
                ...reasoningFrames("rs_final"),
                { type: "response.output_item.added", output_index: 1, item: { type: "message", content: [] } },
                { type: "response.output_item.done", output_index: 1, item: message(FINAL) },
                completed([reasoning("rs_final"), message(FINAL)], finalUsage),
            ],
        ],
        [
            "the message in the terminal snapshot only",
            [...reasoningFrames("rs_final"), completed([reasoning("rs_final"), message(FINAL)], finalUsage)],
        ],
    ];

    it.each(shapes)("the final text reaches the client once, as one text block: %s", async (_name, events) => {
        const { frames } = await collect(responsesSseToAnthropic(sse(events), codex));
        const blocks = assemble(frames);

        expect(blocks.map((block) => block.type)).toEqual(["thinking", "text"]);
        expect(blocks[0]?.thinking).toBe("");
        expect(blocks[0]?.signature.startsWith("gtr1.codex.")).toBe(true);
        expect(blocks[1]?.text).toBe(FINAL);
        expect(frames.filter((frame) => frame.event === "message_stop")).toHaveLength(1);
        expect(stopReason(frames)).toBe("end_turn");
        expect(hasVisibleOutput(blocks)).toBe(true);
    });

    it("the notification turn carries the final reply once, with the notification as the newest input", () => {
        const body = anthropicToResponses(
            {
                messages: [
                    { role: "user", content: "check CI" },
                    {
                        role: "assistant",
                        content: [
                            { type: "thinking", thinking: "", signature: "sig" },
                            { type: "text", text: FINAL },
                        ],
                    },
                    { role: "user", content: [{ type: "text", text: NOTIFICATION }] },
                ],
            },
            "gpt-6.1-sol",
            { reasoningItem: () => undefined }
        );

        expect(body.input).toEqual([
            { role: "user", content: [{ type: "input_text", text: "check CI" }] },
            { role: "assistant", content: [{ type: "output_text", text: FINAL }] },
            { role: "user", content: [{ type: "input_text", text: NOTIFICATION }] },
        ]);
    });

    // The control: the reply to the notification as it came back (no message item, or one with no text). It is empty,
    // so Claude Code's recovery request is the right answer, and the earlier final text does not come back in it.
    const emptyUsage = {
        input_tokens: 308651,
        input_tokens_details: { cached_tokens: 308224 },
        output_tokens: 73,
        output_tokens_details: { reasoning_tokens: 67 },
        total_tokens: 308724,
    };
    const emptyShapes: Array<[string, Array<Record<string, unknown>>]> = [
        ["reasoning only", [...reasoningFrames("rs_quiet"), completed([reasoning("rs_quiet")], emptyUsage)]],
        [
            "reasoning, then a message with no text",
            [
                ...reasoningFrames("rs_quiet"),
                { type: "response.output_item.added", output_index: 1, item: { type: "message", content: [] } },
                { type: "response.output_item.done", output_index: 1, item: message("") },
                completed([reasoning("rs_quiet"), message("")], emptyUsage),
            ],
        ],
    ];

    it.each(emptyShapes)("a genuinely empty reply stays empty: %s", async (_name, events) => {
        const { frames, raw } = await collect(responsesSseToAnthropic(sse(events), codex));
        const blocks = assemble(frames);

        expect(frameSummary(frames)).toEqual([
            "message_start",
            "start[0]:thinking",
            "delta[0]:signature_delta",
            "stop[0]",
            "start[1]:text",
            "stop[1]",
            "message_delta",
            "message_stop",
        ]);
        expect(blocks.map((block) => block.text)).toEqual(["", ""]);
        expect(raw.includes("PENDING")).toBe(false);
        expect(frames.find((frame) => frame.event === "message_delta")?.data.usage).toEqual({
            input_tokens: 427,
            output_tokens: 73,
            cache_read_input_tokens: 308224,
            output_tokens_details: { reasoning_tokens: 67 },
        });
        expect(stopReason(frames)).toBe("end_turn");
        expect(hasVisibleOutput(blocks)).toBe(false);
    });
});

describe("the message_start usage of a Responses stream (the statusline context reading)", () => {
    // A WHAM stream captured from gpt-6.1-sol: response.created and response.in_progress carry "usage": null, and the
    // count arrives only in response.completed. Claude Code shows a streaming message by its message_start usage.
    const captured = readFileSync(
        join(import.meta.dir, "..", "..", "..", "providers", "fixtures", "wham-reasoning-parallel-tools.sse"),
        "utf8"
    );
    const capturedStream = (): ReadableStream<Uint8Array> => new Response(captured).body ?? sse([]);
    const usageOf = (frames: Frame[], event: string): unknown => {
        const frame = frames.find((entry) => entry.event === event);
        const message = frame?.data.message;

        if (event === "message_start" && message !== null && typeof message === "object" && "usage" in message) {
            return message.usage;
        }

        return frame?.data.usage;
    };
    const held: AnthropicUsage = { input_tokens: 548, cache_read_input_tokens: 291_200, output_tokens: 0 };

    it("opens with the start usage it is given, not 0, and ends with the upstream's real count", async () => {
        const seen: AnthropicUsage[] = [];
        const { frames } = await collect(
            responsesSseToAnthropic(capturedStream(), {
                model: "gpt-6.1-sol",
                label: "codex",
                startUsage: held,
                onUsage: (usage) => seen.push(usage),
            })
        );

        expect(usageOf(frames, "message_start")).toEqual(held);
        const final = { input_tokens: 129, output_tokens: 312, output_tokens_details: { reasoning_tokens: 161 } };
        expect(usageOf(frames, "message_delta")).toEqual(final);
        expect(seen).toEqual([final]);
    });

    it("without a start usage the captured stream opens with a 0-token context (the old behaviour)", async () => {
        const { frames } = await collect(responsesSseToAnthropic(capturedStream(), { model: "gpt-6.1-sol" }));

        expect(usageOf(frames, "message_start")).toEqual({ input_tokens: 0, output_tokens: 0 });
    });

    it("moves the cached share of a Codex count outside input_tokens, as the Anthropic API reports it", async () => {
        const seen: AnthropicUsage[] = [];
        const { frames } = await collect(
            responsesSseToAnthropic(
                sse([
                    { type: "response.created", response: { status: "in_progress", usage: null } },
                    {
                        type: "response.completed",
                        response: {
                            status: "completed",
                            output: [],
                            usage: {
                                input_tokens: 293_172,
                                input_tokens_details: { cached_tokens: 291_584 },
                                output_tokens: 40,
                                total_tokens: 293_212,
                            },
                        },
                    },
                ]),
                { model: "gpt-6.1-terra", startUsage: held, onUsage: (usage) => seen.push(usage) }
            )
        );

        const final = { input_tokens: 1588, cache_read_input_tokens: 291_584, output_tokens: 40 };
        expect(usageOf(frames, "message_start")).toEqual(held);
        expect(usageOf(frames, "message_delta")).toEqual(final);
        expect(seen).toEqual([final]);
    });

    it("keeps the start usage's input side when the upstream reports no usage at all", async () => {
        const seen: AnthropicUsage[] = [];
        const { frames } = await collect(
            responsesSseToAnthropic(sse([{ type: "response.created", response: { usage: null } }]), {
                model: "gpt-6.1-terra",
                startUsage: held,
                onUsage: (usage) => seen.push(usage),
            })
        );

        expect(usageOf(frames, "message_delta")).toEqual(held);
        expect(seen).toEqual([]);
    });
});
