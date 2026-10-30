import { describe, expect, it } from "bun:test";
import {
    anthropicToGrokResponses,
    anthropicToResponses,
    stripReasoningInput,
} from "@app/ai-proxy/lib/translators/formats/anthropic/anthropic-to-responses";
import { responsesSseToAnthropic } from "@app/ai-proxy/lib/translators/formats/anthropic/grok-responses-to-anthropic";
import {
    packReasoningSignature,
    REASONING_SIGNATURE_PREFIX,
    unpackReasoningSignature,
} from "@app/ai-proxy/lib/translators/formats/anthropic/reasoning-codec";
import { SafeJSON } from "@genesiscz/utils/json";
import { isObject } from "@genesiscz/utils/object";

describe("packReasoningSignature / unpackReasoningSignature", () => {
    it("round-trips id and encrypted content", () => {
        const packed = packReasoningSignature("rs_abc-123", "R2E1Hmij6U3KWy+skp8Z==");

        expect(packed.startsWith(REASONING_SIGNATURE_PREFIX)).toBe(true);
        expect(unpackReasoningSignature(packed)).toEqual({
            id: "rs_abc-123",
            encryptedContent: "R2E1Hmij6U3KWy+skp8Z==",
        });
    });

    it("rejects foreign and empty signatures", () => {
        expect(unpackReasoningSignature("")).toBeUndefined();
        expect(unpackReasoningSignature(undefined)).toBeUndefined();
        // A real Anthropic signature is opaque base64 with no prefix.
        expect(unpackReasoningSignature("EqQBCkgIBBAC")).toBeUndefined();
        expect(unpackReasoningSignature(`${REASONING_SIGNATURE_PREFIX}no-separator`)).toBeUndefined();
        expect(unpackReasoningSignature(`${REASONING_SIGNATURE_PREFIX}id:`)).toBeUndefined();
    });
});

describe("anthropicToGrokResponses", () => {
    it("always requests stateless encrypted reasoning", () => {
        const out = anthropicToGrokResponses({ messages: [] }, "grok-4.6");

        expect(out.model).toBe("grok-4.6");
        expect(out.store).toBe(false);
        expect(out.include).toEqual(["reasoning.encrypted_content"]);
    });

    it("joins system blocks into instructions", () => {
        const out = anthropicToGrokResponses(
            {
                system: [
                    { type: "text", text: "You are terse." },
                    { type: "text", text: "Answer in Czech." },
                ],
            },
            "grok-4.6"
        );

        expect(out.instructions).toBe("You are terse.\n\nAnswer in Czech.");
    });

    it("maps user content and hoists tool_result blocks to function_call_output items", () => {
        const out = anthropicToGrokResponses(
            {
                messages: [
                    { role: "user", content: "plain string" },
                    {
                        role: "user",
                        content: [
                            {
                                type: "tool_result",
                                tool_use_id: "call-1",
                                content: [{ type: "text", text: "ok" }],
                            },
                            {
                                type: "tool_result",
                                tool_use_id: "call-2",
                                is_error: true,
                                content: "boom",
                            },
                            { type: "text", text: "continue please" },
                        ],
                    },
                ],
            },
            "grok-4.6"
        );

        expect(out.input).toEqual([
            { role: "user", content: [{ type: "input_text", text: "plain string" }] },
            { type: "function_call_output", call_id: "call-1", output: "ok" },
            { type: "function_call_output", call_id: "call-2", output: "[Tool call failed] boom" },
            { role: "user", content: [{ type: "input_text", text: "continue please" }] },
        ]);
    });

    it("replays a packed thinking block as a reasoning item, in block order", () => {
        const out = anthropicToGrokResponses(
            {
                messages: [
                    {
                        role: "assistant",
                        content: [
                            {
                                type: "thinking",
                                thinking: "the summary text",
                                signature: packReasoningSignature("rs_1", "ENCRYPTED=="),
                            },
                            { type: "text", text: "calling the tool now" },
                            { type: "tool_use", id: "call-9", name: "run_command", input: { command: "date" } },
                        ],
                    },
                ],
            },
            "grok-4.6"
        );

        expect(out.input).toEqual([
            {
                type: "reasoning",
                id: "rs_1",
                summary: [{ type: "summary_text", text: "the summary text" }],
                encrypted_content: "ENCRYPTED==",
            },
            { role: "assistant", content: [{ type: "output_text", text: "calling the tool now" }] },
            { type: "function_call", call_id: "call-9", name: "run_command", arguments: '{"command":"date"}' },
        ]);
    });

    it("drops thinking blocks the shim produced (signature is empty) instead of failing the turn", () => {
        const out = anthropicToGrokResponses(
            {
                messages: [
                    {
                        role: "assistant",
                        content: [
                            { type: "thinking", thinking: "shim-era reasoning", signature: "" },
                            { type: "text", text: "answer" },
                        ],
                    },
                ],
            },
            "grok-4.6"
        );

        expect(out.input).toEqual([{ role: "assistant", content: [{ type: "output_text", text: "answer" }] }]);
    });

    it("maps tools, tool_choice and parallel-call opt-out", () => {
        const out = anthropicToGrokResponses(
            {
                tools: [
                    {
                        name: "Glob",
                        description: "find files",
                        input_schema: { type: "object", properties: { pattern: {} }, required: ["pattern"] },
                    },
                ],
                tool_choice: { type: "tool", name: "Glob", disable_parallel_tool_use: true },
            },
            "grok-4.6"
        );

        expect(out.tools).toEqual([
            {
                type: "function",
                name: "Glob",
                description: "find files",
                parameters: { type: "object", properties: { pattern: {} }, required: ["pattern"] },
            },
        ]);
        expect(out.tool_choice).toEqual({ type: "function", name: "Glob" });
        expect(out.parallel_tool_calls).toBe(false);

        expect(anthropicToGrokResponses({ tool_choice: { type: "any" } }, "m").tool_choice).toBe("required");
        expect(anthropicToGrokResponses({ tool_choice: { type: "auto" } }, "m").tool_choice).toBe("auto");
    });

    it("carries the sampling and effort fields and renames max_tokens", () => {
        const out = anthropicToGrokResponses(
            { max_tokens: 4096, stream: true, temperature: 0.2, top_p: 0.9, reasoning_effort: "xhigh" },
            "grok-4.6"
        );

        expect(out.max_output_tokens).toBe(4096);
        expect(out.max_tokens).toBeUndefined();
        expect(out.stream).toBe(true);
        expect(out.temperature).toBe(0.2);
        expect(out.top_p).toBe(0.9);
        expect(out.reasoning_effort).toBe("xhigh");
    });
});

describe("stripReasoningInput", () => {
    it("removes only reasoning items", () => {
        const body = {
            input: [
                { role: "user", content: [{ type: "input_text", text: "hi" }] },
                { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "X" },
                { type: "function_call", call_id: "c1", name: "t", arguments: "{}" },
            ],
        };

        expect(stripReasoningInput(body).input).toEqual([
            { role: "user", content: [{ type: "input_text", text: "hi" }] },
            { type: "function_call", call_id: "c1", name: "t", arguments: "{}" },
        ]);
        // The original body is untouched — the retry needs both variants.
        expect(body.input).toHaveLength(3);
    });
});

describe("anthropicToResponses: system messages between turns", () => {
    const noReplay = { reasoningItem: () => undefined };
    const turn = (messages: unknown[]) =>
        anthropicToResponses({ system: [{ type: "text", text: "base prompt" }], messages }, "gpt-6.1-sol", noReplay);

    it("keeps each one at its place as a developer message, so instructions and every earlier item stay the same", () => {
        const first = [
            { role: "user", content: "hello" },
            { role: "system", content: [{ type: "text", text: "SessionStart hook output" }] },
        ];
        const second = [
            ...first,
            { role: "assistant", content: [{ type: "text", text: "hi" }] },
            { role: "user", content: "next" },
            { role: "system", content: "UserPromptSubmit hook output" },
        ];
        const one = turn(first);
        const two = turn(second);

        expect(one.instructions).toBe("base prompt");
        expect(two.instructions).toBe("base prompt");
        expect((one.input as unknown[])[1]).toEqual({
            role: "developer",
            content: [{ type: "input_text", text: "SessionStart hook output" }],
        });
        expect((two.input as unknown[]).slice(0, 2)).toEqual(one.input as unknown[]);
        expect((two.input as unknown[]).at(-1)).toEqual({
            role: "developer",
            content: [{ type: "input_text", text: "UserPromptSubmit hook output" }],
        });
    });
});

describe("anthropicToResponses: an image in a tool result", () => {
    const messages = [
        { role: "user", content: "Read shot.png" },
        {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "shot.png" } }],
        },
        {
            role: "user",
            content: [
                {
                    type: "tool_result",
                    tool_use_id: "toolu_1",
                    content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } }],
                },
            ],
        },
    ];
    const output = (toolResultImages: boolean) =>
        (
            anthropicToResponses({ messages }, "gpt-6.1-sol", { reasoningItem: () => undefined, toolResultImages })
                .input as Array<Record<string, unknown>>
        ).find((item) => item.type === "function_call_output")?.output;

    it("goes up as an input_image inside the tool output when the route takes it (Codex), else as a placeholder", () => {
        expect(output(true)).toEqual([{ type: "input_image", image_url: "data:image/jpeg;base64,AAAA" }]);
        expect(output(false)).toBe("[Image Omitted]");
    });
});

describe("anthropicToResponses: tools loaded by tool search", () => {
    const tool = (name: string, deferred = false) => ({
        name,
        description: name,
        input_schema: { type: "object", properties: {} },
        ...(deferred ? { defer_loading: true } : {}),
    });
    const loads = (...names: string[]) => ({
        role: "user",
        content: [
            {
                type: "tool_result",
                tool_use_id: `search-${names.join("-")}`,
                content: names.map((tool_name) => ({ type: "tool_reference", tool_name })),
            },
        ],
    });
    const names = (body: Record<string, unknown>) =>
        (anthropicToGrokResponses(body, "grok-4.7").tools as Array<{ name: string }>).map((t) => t.name);

    it("appends each newly loaded tool, so the earlier list stays a prefix", () => {
        const before = names({
            messages: [{ role: "user", content: "hi" }, loads("WebSearch")],
            tools: [tool("Bash"), tool("Placeholder", true), tool("WebSearch", true), tool("Write")],
        });
        // Claude Code sorts by name: SendMessage lands between Placeholder and WebSearch.
        const after = names({
            messages: [{ role: "user", content: "hi" }, loads("WebSearch"), loads("SendMessage")],
            tools: [
                tool("Bash"),
                tool("Placeholder", true),
                tool("SendMessage", true),
                tool("WebSearch", true),
                tool("Write"),
            ],
        });

        expect(before).toEqual(["Bash", "Write", "Placeholder", "WebSearch"]);
        expect(after).toEqual([...before, "SendMessage"]);
    });
});

describe("anthropicToResponses: a client tool call the model made as a custom tool", () => {
    const messages = [
        { role: "user", content: "count the files" },
        {
            role: "assistant",
            content: [
                { type: "tool_use", id: "call_exec", name: "Bash", input: { command: "RUN js-1" } },
                { type: "tool_use", id: "call_plain", name: "Bash", input: { command: "ls" } },
            ],
        },
        {
            role: "user",
            content: [
                { type: "tool_result", tool_use_id: "call_exec", content: "Script completed\nOutput:\n3" },
                { type: "tool_result", tool_use_id: "call_plain", content: [{ type: "text", text: "a.ts" }] },
            ],
        },
    ];
    const customToolCall = (toolUse: Record<string, unknown>) => {
        const input = toolUse.input as { command?: string };
        return input.command?.startsWith("RUN ")
            ? { type: "custom_tool_call", call_id: toolUse.id, name: "exec", input: input.command.slice(4) }
            : undefined;
    };

    it("replays the hook's custom_tool_call and sends its result as custom_tool_call_output; other calls stay function calls", () => {
        const out = anthropicToResponses({ messages }, "gpt-6.1-sol", {
            reasoningItem: () => undefined,
            customToolCall,
        });

        expect(out.input).toEqual([
            { role: "user", content: [{ type: "input_text", text: "count the files" }] },
            { type: "custom_tool_call", call_id: "call_exec", name: "exec", input: "js-1" },
            { type: "function_call", call_id: "call_plain", name: "Bash", arguments: '{"command":"ls"}' },
            { type: "custom_tool_call_output", call_id: "call_exec", output: "Script completed\nOutput:\n3" },
            { type: "function_call_output", call_id: "call_plain", output: "a.ts" },
        ]);
    });

    it("without the hook every call is a function call", () => {
        const out = anthropicToResponses({ messages }, "gpt-6.1-sol", { reasoningItem: () => undefined });
        const types = (out.input as Array<{ type?: string }>).map((item) => item.type);

        expect(types).toEqual([
            undefined,
            "function_call",
            "function_call",
            "function_call_output",
            "function_call_output",
        ]);
    });

    it("a restored assistant message's custom call still gets a custom output", () => {
        const restored = [{ type: "custom_tool_call", call_id: "call_exec", name: "exec", input: "js-1" }];
        const out = anthropicToResponses({ messages: [messages[1], messages[2]] }, "gpt-6.1-sol", {
            reasoningItem: () => undefined,
            restoreAssistantItems: () => restored,
        });
        const output = (out.input as Array<{ type?: string; call_id?: string }>).find(
            (item) => item.call_id === "call_exec" && item.type !== "custom_tool_call"
        );

        expect(output?.type).toBe("custom_tool_call_output");
    });
});

describe("anthropicToResponses: a parallel batch of Agent calls", () => {
    // Four launches, each with its own label. The model streams them interleaved, Claude Code launches one agent per
    // tool_use and answers in the order the launches finished (2nd, 1st, 4th, 3rd), as it did on 2026-10-27.
    const launches = [
        { callId: "call_d4", label: "PR 701", agentId: "agent-701" },
        { callId: "call_a1", label: "PR 702", agentId: "agent-702" },
        { callId: "call_c3", label: "PR 703", agentId: "agent-703" },
        { callId: "call_b2", label: "PR 704", agentId: "agent-704" },
    ];
    const finishedOrder = [1, 0, 3, 2];
    const argumentsOf = (label: string) =>
        SafeJSON.stringify({ description: `Review ${label}`, prompt: `Own ${label} and nothing else.` });
    const receiptOf = (agentId: string) => `Async agent launched successfully.\nagentId: ${agentId}`;

    function upstream(): ReadableStream<Uint8Array> {
        const events: Array<Record<string, unknown>> = [];
        const call = (index: number, args: string) => ({
            type: "function_call",
            call_id: launches[index].callId,
            name: "Agent",
            arguments: args,
        });

        for (const index of launches.keys()) {
            events.push({ type: "response.output_item.added", output_index: index, item: call(index, "") });
        }

        for (const half of [0, 1]) {
            for (const index of [2, 0, 3, 1]) {
                const args = argumentsOf(launches[index].label);
                const cut = Math.floor(args.length / 2);
                const delta = half === 0 ? args.slice(0, cut) : args.slice(cut);
                events.push({ type: "response.function_call_arguments.delta", output_index: index, delta });
            }
        }

        for (const index of [3, 1, 0, 2]) {
            const done = call(index, argumentsOf(launches[index].label));
            events.push({ type: "response.output_item.done", output_index: index, item: done });
        }

        events.push({ type: "response.completed", response: { status: "completed" } });
        const text = events.map((event) => `event: ${event.type}\ndata: ${SafeJSON.stringify(event)}\n\n`).join("");

        return new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode(text));
                controller.close();
            },
        });
    }

    /** The tool_use blocks Claude Code assembles from the translated stream, in block order. */
    async function toolUses(): Promise<Array<{ type: "tool_use"; id: string; name: string; input: unknown }>> {
        const raw = await new Response(
            responsesSseToAnthropic(upstream(), { model: "gpt-6.1-sol", label: "codex" })
        ).text();
        const blocks = new Map<number, { id: string; name: string; json: string }>();

        for (const chunk of raw.split("\n\n")) {
            const line = chunk.split("\n").find((candidate) => candidate.startsWith("data: "));
            const data: unknown = line ? SafeJSON.parse(line.slice(6), { strict: true }) : undefined;

            if (!isObject(data) || typeof data.index !== "number") {
                continue;
            }

            const block = data.content_block;

            if (data.type === "content_block_start" && isObject(block) && block.type === "tool_use") {
                blocks.set(data.index, { id: String(block.id), name: String(block.name), json: "" });
            }

            const open = blocks.get(data.index);
            const delta = data.delta;

            if (data.type === "content_block_delta" && open && isObject(delta) && delta.type === "input_json_delta") {
                open.json += String(delta.partial_json);
            }
        }

        return [...blocks.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, block]) => ({
                type: "tool_use",
                id: block.id,
                name: block.name,
                input: SafeJSON.parse(block.json, { strict: true }),
            }));
    }

    it("gives each tool_use id its own call's input, however the stream interleaves the calls", async () => {
        const uses = await toolUses();

        expect(uses.map((use) => [use.id, use.name, use.input])).toEqual(
            launches.map((launch) => [
                launch.callId,
                "Agent",
                { description: `Review ${launch.label}`, prompt: `Own ${launch.label} and nothing else.` },
            ])
        );
    });

    it("sends the results in call order, so pairing by position gives each call its own agent", async () => {
        const uses = await toolUses();
        const results = finishedOrder.map((index) => ({
            type: "tool_result",
            tool_use_id: launches[index].callId,
            content: [{ type: "text", text: receiptOf(launches[index].agentId) }],
        }));
        const out = anthropicToResponses(
            {
                messages: [
                    { role: "user", content: "review the four PRs" },
                    { role: "assistant", content: uses },
                    { role: "user", content: [...results, { type: "text", text: "continue" }] },
                ],
            },
            "gpt-6.1-sol",
            { reasoningItem: () => undefined, toolResultImages: true }
        );
        const items = Array.isArray(out.input) ? out.input.filter(isObject) : [];
        const calls = items.filter((item) => item.type === "function_call");
        const outputs = items.filter((item) => item.type === "function_call_output");

        // By call id, as Anthropic reads them: every receipt stays with the call Claude Code answered.
        expect(Object.fromEntries(outputs.map((item) => [item.call_id, item.output]))).toEqual(
            Object.fromEntries(launches.map((launch) => [launch.callId, receiptOf(launch.agentId)]))
        );

        // By position, as the Responses model reads them: the n-th output answers the n-th call.
        expect(outputs.map((item) => item.call_id)).toEqual(calls.map((item) => item.call_id));
        expect(
            calls.map((call, index) => [
                String(call.arguments).match(/PR \d+/)?.[0],
                String(outputs[index]?.output).match(/agent-\d+/)?.[0],
            ])
        ).toEqual(launches.map((launch) => [launch.label, launch.agentId]));

        expect(items.at(-1)).toEqual({ role: "user", content: [{ type: "input_text", text: "continue" }] });
    });

    it("keeps a result whose call it does not know after the known ones, in its own order", () => {
        const out = anthropicToResponses(
            {
                messages: [
                    {
                        role: "assistant",
                        content: [
                            { type: "tool_use", id: "call_first", name: "Agent", input: {} },
                            { type: "tool_use", id: "call_second", name: "Agent", input: {} },
                        ],
                    },
                    {
                        role: "user",
                        content: [
                            { type: "tool_result", tool_use_id: "call_stray", content: "stray" },
                            { type: "tool_result", tool_use_id: "call_second", content: "second" },
                            { type: "tool_result", tool_use_id: "call_first", content: "first" },
                        ],
                    },
                ],
            },
            "gpt-6.1-sol",
            { reasoningItem: () => undefined }
        );
        const items = Array.isArray(out.input) ? out.input.filter(isObject) : [];

        expect(items.filter((item) => item.type === "function_call_output").map((item) => item.call_id)).toEqual([
            "call_first",
            "call_second",
            "call_stray",
        ]);
    });
});
