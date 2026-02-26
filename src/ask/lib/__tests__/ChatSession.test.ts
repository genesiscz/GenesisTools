import { describe, expect, it } from "bun:test";
import { ChatSession } from "../ChatSession";

describe("ChatSession", () => {
    it("add() creates entries with timestamps", () => {
        const session = new ChatSession("test-1");
        session.add({ role: "user", content: "hello" });
        session.add({ role: "assistant", content: "hi there" });

        const entries = session.getHistory();
        expect(entries).toHaveLength(2);
        expect(entries[0].type).toBe("user");
        expect(entries[1].type).toBe("assistant");
        expect(entries[0].timestamp).toBeTruthy();
    });

    it("add() context creates context entry with label", () => {
        const session = new ChatSession("test-2");
        session.add({ role: "context", content: "message from telegram", label: "telegram-incoming" });

        const entries = session.getHistory();
        expect(entries).toHaveLength(1);
        expect(entries[0].type).toBe("context");
        if (entries[0].type === "context") {
            expect(entries[0].label).toBe("telegram-incoming");
        }
    });

    it("getHistory({ last: 2 }) returns last 2 entries", () => {
        const session = new ChatSession("test-3");
        session.add({ role: "user", content: "first" });
        session.add({ role: "assistant", content: "second" });
        session.add({ role: "user", content: "third" });

        const last2 = session.getHistory({ last: 2 });
        expect(last2).toHaveLength(2);
        if (last2[0].type === "assistant") {
            expect(last2[0].content).toBe("second");
        }
    });

    it("getHistory({ roles }) filters by type", () => {
        const session = new ChatSession("test-4");
        session.add({ role: "user", content: "hello" });
        session.add({ role: "system", content: "system msg" });
        session.add({ role: "assistant", content: "reply" });

        const chatOnly = session.getHistory({ roles: ["user", "assistant"] });
        expect(chatOnly).toHaveLength(2);
    });

    it("toMessages() maps entries to LLM format", () => {
        const session = new ChatSession("test-5");
        session.addConfig("openai", "gpt-4o");
        session.add({ role: "context", content: "background info" });
        session.add({ role: "user", content: "question" });
        session.add({ role: "assistant", content: "answer" });

        const messages = session.toMessages();
        expect(messages).toHaveLength(3); // config skipped
        expect(messages[0]).toEqual({ role: "system", content: "background info" });
        expect(messages[1]).toEqual({ role: "user", content: "question" });
        expect(messages[2]).toEqual({ role: "assistant", content: "answer" });
    });

    it("filterByRole returns new session", () => {
        const session = new ChatSession("test-6");
        session.add({ role: "user", content: "hello" });
        session.add({ role: "assistant", content: "hi" });
        session.add({ role: "system", content: "sys" });

        const userOnly = session.filterByRole("user");
        expect(userOnly.length).toBe(1);
        expect(userOnly.id).toBe("test-6");
        // Original unchanged
        expect(session.length).toBe(3);
    });

    it("filterByContent searches content", () => {
        const session = new ChatSession("test-7");
        session.add({ role: "user", content: "what is the weather" });
        session.add({ role: "assistant", content: "it is sunny" });
        session.add({ role: "user", content: "tell me a joke" });

        const weatherMsgs = session.filterByContent("weather");
        expect(weatherMsgs.length).toBe(1);
    });

    it("clear resets entries but keeps id", () => {
        const session = new ChatSession("test-8");
        session.add({ role: "user", content: "hello" });
        session.clear();
        expect(session.length).toBe(0);
        expect(session.id).toBe("test-8");
    });

    it("getStats computes correct values", () => {
        const session = new ChatSession("test-9");
        session.add({ role: "user", content: "hello" });
        session.add({
            role: "assistant",
            content: "hi",
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            cost: 0.001,
        });

        const stats = session.getStats();
        expect(stats.messageCount).toBe(2);
        expect(stats.tokenCount).toBe(15);
        expect(stats.cost).toBe(0.001);
        expect(stats.byRole.user).toBe(1);
        expect(stats.byRole.assistant).toBe(1);
    });

    it("export jsonl produces valid JSONL", async () => {
        const session = new ChatSession("test-10");
        session.add({ role: "user", content: "hello" });
        session.add({ role: "assistant", content: "hi" });

        const jsonl = await session.export("jsonl");
        const lines = jsonl.split("\n");
        expect(lines).toHaveLength(2);
        const parsed = JSON.parse(lines[0]);
        expect(parsed.type).toBe("user");
        expect(parsed.content).toBe("hello");
    });

    it("export markdown produces readable output", async () => {
        const session = new ChatSession("test-11");
        session.add({ role: "user", content: "hello" });
        session.add({ role: "assistant", content: "hi" });

        const md = await session.export("markdown");
        expect(md).toContain("**User:** hello");
        expect(md).toContain("**Assistant:** hi");
    });

    it("export text produces clean dialog", async () => {
        const session = new ChatSession("test-12");
        session.add({ role: "user", content: "hello" });
        session.add({ role: "assistant", content: "hi" });

        const text = await session.export("text");
        expect(text).toBe("You: hello\nAI: hi");
    });
});
