import { describe, expect, it } from "bun:test";
import { AssistantEngine } from "../AssistantEngine";

describe("AssistantEngine", () => {
    it("builds correct tool definitions", () => {
        const tools = AssistantEngine.getToolDefinitions();

        expect(tools).toHaveProperty("search_messages");
        expect(tools).toHaveProperty("get_message_count");
        expect(tools).toHaveProperty("get_conversation_summary");
        expect(tools).toHaveProperty("get_attachments");
        expect(tools).toHaveProperty("get_style_analysis");
        expect(tools).toHaveProperty("search_across_chats");
    });

    it("search_messages tool has correct parameters", () => {
        const tools = AssistantEngine.getToolDefinitions();
        const searchTool = tools.search_messages;

        expect(searchTool.parameters).toBeDefined();
    });
});
