import { describe, expect, it, test } from "bun:test";
import type { MessageInfo } from "./iMessagesDatabase";
import {
    EXPORT_MESSAGE_LIMIT,
    extractTextFromAttributedBody,
    iMessagesDatabase,
    messageTextFromRow,
} from "./iMessagesDatabase";

const MARKER = Buffer.from([0x84, 0x01, 0x2b]);

function blobWithLongText(text: string, trailer: Buffer): Buffer {
    const encoded = Buffer.from(text, "utf-8");
    const prefix = Buffer.alloc(3);
    prefix[0] = 0x81;
    prefix.writeUInt16LE(encoded.length, 1);

    return Buffer.concat([Buffer.from("NSString"), MARKER, prefix, encoded, trailer]);
}

describe("extractTextFromAttributedBody", () => {
    // Regression test: 2026-09-01 — 0x81 length is little-endian; BE over-read
    // swallows NSKeyedArchiver bplist attribute runs as "message text".
    it("does not include bplist attribute runs after a long 0x81-prefixed string", () => {
        const body = "x".repeat(300);
        const trailer = Buffer.concat([
            Buffer.from("bplist00NSKeyedArchiver__kIMPhoneNumberAttributeName"),
            Buffer.alloc(12_000, 0xff),
        ]);
        const result = extractTextFromAttributedBody(blobWithLongText(body, trailer));

        expect(result).toBe(body);
    });

    it("reads a short string whose length fits in one byte", () => {
        const encoded = Buffer.from("hello", "utf-8");
        const blob = Buffer.concat([MARKER, Buffer.from([encoded.length]), encoded]);

        expect(extractTextFromAttributedBody(blob)).toBe("hello");
    });

    it("cuts a long slice at the bplist00 magic if the length over-reads", () => {
        const body = "plain message";
        const encoded = Buffer.from(body, "utf-8");
        const junk = Buffer.from("bplist00NSKeyedArchiver", "utf-8");
        const claimed = encoded.length + junk.length;
        const prefix = Buffer.alloc(3);
        prefix[0] = 0x81;
        prefix.writeUInt16LE(claimed, 1);
        const blob = Buffer.concat([MARKER, prefix, encoded, junk]);

        expect(extractTextFromAttributedBody(blob)).toBe(body);
    });
});

describe("messageTextFromRow", () => {
    // The blob cut markers were applied to the plain text column too, so an
    // ordinary message mentioning one of them was truncated at that word.
    it("returns the text column verbatim, markers and all", () => {
        expect(messageTextFromRow({ text: "the blob starts with bplist00 magic", attributedBody: null })).toBe(
            "the blob starts with bplist00 magic"
        );
        expect(messageTextFromRow({ text: "NSKeyedArchiver is the format", attributedBody: null })).toBe(
            "NSKeyedArchiver is the format"
        );
    });

    it("falls back to the blob only when the text column is empty", () => {
        const encoded = Buffer.from("hello", "utf-8");
        const blob = Buffer.concat([MARKER, Buffer.from([encoded.length]), encoded]);

        expect(messageTextFromRow({ text: null, attributedBody: blob })).toBe("hello");
        expect(messageTextFromRow({ text: null, attributedBody: null })).toBeNull();
    });
});

/**
 * `exportConversation` loads the WHOLE chat. Without a cap a multi-year group
 * chat pages 1000 rows at a time until memory runs out, so the cap and the
 * notice it writes are the contract under test. The paging itself is stubbed:
 * these assertions are about the ceiling, not about SQL.
 */
class StubMessagesDatabase extends iMessagesDatabase {
    constructor(private readonly total: number) {
        super();
    }

    override getMessages(_chatIdentifier: string, options?: { limit?: number; page?: number }): MessageInfo[] {
        const limit = options?.limit ?? 50;
        const offset = ((options?.page ?? 1) - 1) * limit;
        const count = Math.max(0, Math.min(limit, this.total - offset));

        return Array.from({ length: count }, (_, index) => ({
            rowid: offset + index + 1,
            text: `message ${offset + index + 1}`,
            sender: "me",
            isFromMe: true,
            date: new Date(Date.UTC(2026, 0, 1)),
            chatIdentifier: "chat1",
            replyToGuid: null,
            threadGuid: null,
        }));
    }
}

describe("exportConversation", () => {
    test("caps the load and says so when it truncates", () => {
        const db = new StubMessagesDatabase(5_000);
        const output = db.exportConversation("chat1", { maxMessages: 2_000, resolveContacts: false });

        expect(output).toStartWith("> Truncated: only the OLDEST 2000 messages");
        expect(output).toContain("message 2000");
        expect(output).not.toContain("message 2001");
    });

    test("a conversation of exactly the cap is complete, not truncated", () => {
        // `length >= maxMessages` called this one truncated and warned about a
        // run that dropped nothing. Only a row read PAST the cap proves loss.
        const db = new StubMessagesDatabase(2_000);
        const output = db.exportConversation("chat1", { maxMessages: 2_000, resolveContacts: false });

        expect(output).not.toContain("Truncated");
        expect(output).toContain("message 2000");
    });

    test("a conversation under the cap has no notice", () => {
        const db = new StubMessagesDatabase(120);
        const output = db.exportConversation("chat1", { maxMessages: 2_000, resolveContacts: false });

        expect(output).not.toContain("Truncated");
        expect(output).toContain("message 120");
    });

    test("the default cap is the documented one", () => {
        expect(EXPORT_MESSAGE_LIMIT).toBe(50_000);
    });
});
