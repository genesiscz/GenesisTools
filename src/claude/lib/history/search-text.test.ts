import { describe, expect, it } from "bun:test";
import { extractTextFromMessage } from "./search";
import type { AssistantMessage } from "./types";

function assistantWithTools(blocks: Array<{ name: string; input: Record<string, unknown> }>): AssistantMessage {
    return {
        type: "assistant",
        message: {
            role: "assistant",
            content: blocks.map((block, i) => ({
                type: "tool_use" as const,
                id: `t${i}`,
                name: block.name,
                input: block.input,
            })),
        },
    } as AssistantMessage;
}

describe("extractTextFromMessage — tool_use inputs", () => {
    // Regression: history ".vitrinka/" missed Write/Edit calls because tool_use.input
    // was not part of the searchable text (only user/assistant prose).
    it("includes the Write file_path so a path query can match", () => {
        const text = extractTextFromMessage(
            assistantWithTools([{ name: "Write", input: { file_path: "/repo/.vitrinka/config.json", content: "x" } }]),
            true
        );

        expect(text).toContain("/repo/.vitrinka/config.json");
    });
});
