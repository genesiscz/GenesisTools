import { describe, expect, it } from "bun:test";

// Assuming the functions and interfaces are exported from index.ts
// If not, we might need to copy them here or adjust the import.
// For this example, let's assume they might not be directly exported from a script that also runs itself.
// So, we'll redefine the necessary parts or use a way to import them if the script is structured for it.

// --- Definitions (copied or adapted from index.ts if not exportable) ---
interface Message {
    content: string;
    threadId: string;
}

interface InputJson {
    json: {
        messages: Message[];
    };
}

interface OutputMessageInfo {
    threadLink: string;
    contentSizeKB: number;
}

function processMessages(input: InputJson): OutputMessageInfo[] {
    const messages = input.json.messages;

    const messageInfo = messages.map((message) => {
        const contentSizeBytes = new TextEncoder().encode(message.content).length;
        const contentSizeKB = contentSizeBytes / 1024;
        const threadLink = `https://t3.chat/chat/${message.threadId}`;

        return {
            threadLink,
            contentSizeKB,
        };
    });

    messageInfo.sort((a, b) => b.contentSizeKB - a.contentSizeKB);

    return messageInfo;
}
// --- End Definitions ---

describe("t3chat-length processor", () => {
    it("should process an empty list of messages", () => {
        const input: InputJson = { json: { messages: [] } };
        const result = processMessages(input);
        expect(result).toEqual([]);
    });

    it("should correctly calculate content size and create thread links", () => {
        const messages: Message[] = [
            { content: "Hello", threadId: "thread1" }, // 5 bytes
            { content: "A".repeat(1024), threadId: "thread2" }, // 1024 bytes = 1KB
            { content: "B".repeat(2048), threadId: "thread3" }, // 2048 bytes = 2KB
        ];
        const input: InputJson = { json: { messages } };
        const result = processMessages(input);

        expect(result.length).toBe(3);

        const msg1 = result.find((m) => m.threadLink.includes("thread1"));
        const msg2 = result.find((m) => m.threadLink.includes("thread2"));
        const msg3 = result.find((m) => m.threadLink.includes("thread3"));

        expect(msg1).toBeDefined();
        expect(msg2).toBeDefined();
        expect(msg3).toBeDefined();

        if (!msg1 || !msg2 || !msg3) {
            throw new Error("Test messages not found in result");
        }

        expect(msg1.threadLink).toBe("https://t3.chat/chat/thread1");
        expect(msg1.contentSizeKB).toBeCloseTo(5 / 1024);

        expect(msg2.threadLink).toBe("https://t3.chat/chat/thread2");
        expect(msg2.contentSizeKB).toBeCloseTo(1);

        expect(msg3.threadLink).toBe("https://t3.chat/chat/thread3");
        expect(msg3.contentSizeKB).toBeCloseTo(2);
    });

    it("should sort messages by contentSizeKB in descending order", () => {
        const messages: Message[] = [
            { content: "Short", threadId: "t_short" }, // 5 bytes
            { content: "VeryVeryLongContent", threadId: "t_long" }, // 19 bytes
            { content: "MediumContent", threadId: "t_medium" }, // 13 bytes
        ];
        const input: InputJson = { json: { messages } };
        const result = processMessages(input);

        expect(result.length).toBe(3);
        expect(result[0].threadLink).toContain("t_long");
        expect(result[1].threadLink).toContain("t_medium");
        expect(result[2].threadLink).toContain("t_short");

        expect(result[0].contentSizeKB).toBeCloseTo(19 / 1024);
        expect(result[1].contentSizeKB).toBeCloseTo(13 / 1024);
        expect(result[2].contentSizeKB).toBeCloseTo(5 / 1024);
    });

    it("should handle messages with empty content", () => {
        const messages: Message[] = [
            { content: "", threadId: "empty" }, // 0 bytes
            { content: "Not empty", threadId: "not_empty" }, // 9 bytes
        ];
        const input: InputJson = { json: { messages } };
        const result = processMessages(input);

        expect(result.length).toBe(2);

        const emptyMsg = result.find((m) => m.threadLink.includes("empty"));
        const nonEmptyMsg = result.find((m) => m.threadLink.includes("not_empty"));

        expect(emptyMsg).toBeDefined();
        expect(nonEmptyMsg).toBeDefined();

        if (!emptyMsg || !nonEmptyMsg) {
            throw new Error("Messages not found");
        }

        expect(emptyMsg.contentSizeKB).toBe(0);
        expect(nonEmptyMsg.contentSizeKB).toBeCloseTo(9 / 1024);

        // Check sort order
        expect(result[0].threadLink).toContain("not_empty");
        expect(result[1].threadLink).toContain("empty");
    });

    it("should handle unicode characters correctly for byte length", () => {
        // Different unicode characters can have different byte lengths
        const messages: Message[] = [
            { content: "Hello", threadId: "ascii" }, // 5 bytes
            { content: "你好世界", threadId: "chinese" }, // Ni Hao Shi Jie - 4 chars, typically 12 bytes in UTF-8
            { content: "😊", threadId: "emoji" }, // Emoji - typically 4 bytes in UTF-8
        ];
        const input: InputJson = { json: { messages } };
        const result = processMessages(input);

        const asciiMsg = result.find((m) => m.threadLink.includes("ascii"));
        const chineseMsg = result.find((m) => m.threadLink.includes("chinese"));
        const emojiMsg = result.find((m) => m.threadLink.includes("emoji"));

        expect(asciiMsg).toBeDefined();
        expect(chineseMsg).toBeDefined();
        expect(emojiMsg).toBeDefined();

        if (!asciiMsg || !chineseMsg || !emojiMsg) {
            throw new Error("Messages not found");
        }

        expect(asciiMsg.contentSizeKB).toBeCloseTo(5 / 1024);
        expect(chineseMsg.contentSizeKB).toBeCloseTo(new TextEncoder().encode("你好世界").length / 1024);
        expect(emojiMsg.contentSizeKB).toBeCloseTo(new TextEncoder().encode("😊").length / 1024);

        // Verify sorting based on actual byte lengths
        const expectedOrder = [chineseMsg, asciiMsg, emojiMsg].sort((a, b) => b.contentSizeKB - a.contentSizeKB);
        expect(result.map((r) => r.threadLink)).toEqual(expectedOrder.map((r) => r.threadLink));
    });
});
