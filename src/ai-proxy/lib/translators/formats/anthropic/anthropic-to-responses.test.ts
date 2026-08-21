import { describe, expect, it } from "bun:test";
import {
    anthropicToGrokResponses,
    packReasoningSignature,
    REASONING_SIGNATURE_PREFIX,
    stripReasoningInput,
    unpackReasoningSignature,
} from "@app/ai-proxy/lib/translators/formats/anthropic/anthropic-to-responses";

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
            { system: [{ type: "text", text: "You are terse." }, { type: "text", text: "Answer in Czech." }] },
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
