import { describe, expect, it } from "bun:test";
import { ChatEvent } from "../ChatEvent";

describe("ChatEvent", () => {
    it("creates text event with factory", () => {
        const event = ChatEvent.text("hello");
        expect(event.type).toBe("text");
        expect(event.isText()).toBe(true);
        expect(event.text).toBe("hello");
        expect(event.isDone()).toBe(false);
    });

    it("creates done event with response", () => {
        const response = { content: "hi", duration: 100 };
        const event = ChatEvent.done(response);
        expect(event.isDone()).toBe(true);
        expect(event.response).toBe(response);
        expect(event.isText()).toBe(false);
    });

    it("creates thinking event", () => {
        const event = ChatEvent.thinking("reasoning...");
        expect(event.isThinking()).toBe(true);
        expect(event.text).toBe("reasoning...");
    });

    it("creates tool_call event", () => {
        const event = ChatEvent.toolCall("searchWeb", { query: "test" });
        expect(event.isToolCall()).toBe(true);
        expect(event.name).toBe("searchWeb");
        expect(event.input).toEqual({ query: "test" });
    });

    it("creates tool_result event", () => {
        const event = ChatEvent.toolResult("searchWeb", { results: [] }, 150);
        expect(event.isToolResult()).toBe(true);
        expect(event.name).toBe("searchWeb");
        expect(event.duration).toBe(150);
    });

    it("type guards narrow correctly", () => {
        const event = ChatEvent.text("hi");
        if (event.isText()) {
            const _text: string = event.text;
            expect(_text).toBe("hi");
        }
    });
});
