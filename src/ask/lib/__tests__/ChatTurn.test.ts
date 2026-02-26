import { describe, expect, it } from "bun:test";
import { ChatEvent } from "../ChatEvent";
import { ChatTurn } from "../ChatTurn";
import type { ChatResponse } from "../types";

function createMockSource(events: ChatEvent[]): () => AsyncGenerator<ChatEvent> {
    return async function* () {
        for (const event of events) {
            yield event;
        }
    };
}

describe("ChatTurn", () => {
    const mockResponse: ChatResponse = {
        content: "Hello there!",
        duration: 150,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        cost: 0.001,
    };

    const mockEvents = [
        ChatEvent.text("Hello "),
        ChatEvent.text("there!"),
        ChatEvent.done(mockResponse),
    ];

    it("await resolves with ChatResponse", async () => {
        const turn = new ChatTurn(createMockSource(mockEvents));
        const response = await turn;
        expect(response.content).toBe("Hello there!");
        expect(response.duration).toBe(150);
        expect(response.cost).toBe(0.001);
    });

    it("for-await yields ChatEvent instances", async () => {
        const turn = new ChatTurn(createMockSource(mockEvents));
        const collected: ChatEvent[] = [];

        for await (const event of turn) {
            collected.push(event);
        }

        expect(collected).toHaveLength(3);
        expect(collected[0].isText()).toBe(true);
        expect(collected[0].text).toBe("Hello ");
        expect(collected[1].text).toBe("there!");
        expect(collected[2].isDone()).toBe(true);
    });

    it(".response resolves after stream completes", async () => {
        const turn = new ChatTurn(createMockSource(mockEvents));

        // Consume the stream
        for await (const _ of turn) { /* drain */ }

        const response = await turn.response;
        expect(response.content).toBe("Hello there!");
    });

    it("onChunk fires for each text event", async () => {
        const chunks: string[] = [];
        const turn = new ChatTurn(createMockSource(mockEvents), (text) => chunks.push(text));

        await turn; // drain via await

        expect(chunks).toEqual(["Hello ", "there!"]);
    });

    it("onChunk fires during for-await iteration too", async () => {
        const chunks: string[] = [];
        const turn = new ChatTurn(createMockSource(mockEvents), (text) => chunks.push(text));

        for await (const _ of turn) { /* drain */ }

        expect(chunks).toEqual(["Hello ", "there!"]);
    });

    it("second iteration replays from buffer", async () => {
        const turn = new ChatTurn(createMockSource(mockEvents));

        // First iteration
        const first: ChatEvent[] = [];
        for await (const event of turn) {
            first.push(event);
        }

        // Second iteration (replays buffer)
        const second: ChatEvent[] = [];
        for await (const event of turn) {
            second.push(event);
        }

        expect(first).toHaveLength(3);
        expect(second).toHaveLength(3);
        expect(second[0].text).toBe("Hello ");
    });

    it("handles events with thinking and tool calls", async () => {
        const events = [
            ChatEvent.thinking("Let me think..."),
            ChatEvent.toolCall("search", { query: "test" }),
            ChatEvent.toolResult("search", { results: [] }, 100),
            ChatEvent.text("Based on my search: "),
            ChatEvent.text("nothing found."),
            ChatEvent.done({ content: "Based on my search: nothing found.", duration: 300 }),
        ];

        const turn = new ChatTurn(createMockSource(events));
        const collected: ChatEvent[] = [];

        for await (const event of turn) {
            collected.push(event);
        }

        expect(collected).toHaveLength(6);
        expect(collected[0].isThinking()).toBe(true);
        expect(collected[1].isToolCall()).toBe(true);
        expect(collected[2].isToolResult()).toBe(true);
        expect(collected[3].isText()).toBe(true);
    });

    it("does not invoke source twice when awaited then iterated", async () => {
        let invocations = 0;
        const source = async function* () {
            invocations++;
            yield ChatEvent.text("hello");
            yield ChatEvent.done({ content: "hello", duration: 10 });
        };

        const turn = new ChatTurn(source);
        await turn; // drains
        const events: ChatEvent[] = [];
        for await (const e of turn) { events.push(e); } // should replay

        expect(invocations).toBe(1);
        expect(events.length).toBe(2);
    });

    it("fallback response when no done event", async () => {
        const events = [
            ChatEvent.text("partial "),
            ChatEvent.text("response"),
        ];

        const turn = new ChatTurn(createMockSource(events));
        const response = await turn;

        expect(response.content).toBe("partial response");
        expect(response.duration).toBe(0);
    });
});
