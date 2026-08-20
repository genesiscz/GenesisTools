import { describe, expect, it } from "bun:test";
import { stringifyUnknownToolResultBlocks } from "@app/ai-proxy/lib/translators/formats/anthropic/stringify-unknown-blocks";

describe("stringifyUnknownToolResultBlocks", () => {
    it("stringifies tool_reference blocks that 422 grok's deserializer", () => {
        // Observed live: ToolSearch results carry tool_reference blocks inside
        // tool_result.content; grok rejects the whole request with 422.
        const body = {
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "tool_result",
                            tool_use_id: "t1",
                            content: [
                                { type: "tool_reference", tool_name: "Monitor" },
                                { type: "text", text: "Tool loaded." },
                            ],
                        },
                    ],
                },
            ],
        };

        const out = stringifyUnknownToolResultBlocks(body) as typeof body;
        const parts = out.messages[0].content[0].content as { type: string; text?: string }[];

        expect(parts[0].type).toBe("text");
        expect(parts[0].text).toContain("tool_reference");
        expect(parts[1]).toEqual({ type: "text", text: "Tool loaded." });
    });

    it("returns the same object when every block type is known", () => {
        const body = {
            messages: [
                {
                    role: "user",
                    content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "ok" }] }],
                },
            ],
        };

        expect(stringifyUnknownToolResultBlocks(body)).toBe(body);
    });

    it("does not mutate its input", () => {
        const body = {
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "tool_result",
                            tool_use_id: "t1",
                            content: [{ type: "tool_reference", tool_name: "X" }],
                        },
                    ],
                },
            ],
        };

        stringifyUnknownToolResultBlocks(body);

        expect((body.messages[0].content[0].content[0] as { type: string }).type).toBe("tool_reference");
    });
});
