import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { iMessagesDatabase, type MessageInfo } from "@genesiscz/utils/macos/iMessagesDatabase";
import {
    attachmentMatchesFilter,
    isOpaqueAttachmentName,
    messagesAttachmentFileName,
    parseAttachmentsFilter,
    saveConversationExport,
    sniffAttachmentExt,
} from "./export";

describe("parseAttachmentsFilter", () => {
    it("parses comma and hash id lists", () => {
        const filter = parseAttachmentsFilter("#11122, 10989  #11123");
        expect(filter?.ids).toEqual(new Set([11122, 10989, 11123]));
        expect(filter?.nameRegex).toBeUndefined();
    });

    it("treats non-id text as a regex", () => {
        const filter = parseAttachmentsFilter("SeedTenant|IMG_");
        expect(filter?.ids).toBeUndefined();
        expect(filter?.nameRegex?.test("SeedTenant.php")).toBe(true);
        expect(filter?.nameRegex?.test("IMG_5675.png")).toBe(true);
        expect(filter?.nameRegex?.test("notes.txt")).toBe(false);
    });

    it("returns undefined for empty input", () => {
        expect(parseAttachmentsFilter(undefined)).toBeUndefined();
        expect(parseAttachmentsFilter("   ")).toBeUndefined();
    });

    it("rejects an id list that names no ids", () => {
        // These pass the digit/hash/comma shape test but produce an EMPTY set,
        // and an empty set excludes every attachment silently.
        expect(() => parseAttachmentsFilter("#")).toThrow(/names no attachment ids/);
        expect(() => parseAttachmentsFilter(",")).toThrow(/names no attachment ids/);
        expect(() => parseAttachmentsFilter("# , #")).toThrow(/names no attachment ids/);
    });
});

describe("attachmentMatchesFilter", () => {
    const att = {
        rowid: 10989,
        filename: "~/Library/Messages/Attachments/x/SeedTenant.php",
        mimeType: "text/php",
        transferName: "SeedTenant.php",
        totalBytes: 12,
    };

    it("matches by id set", () => {
        expect(attachmentMatchesFilter(att, { ids: new Set([10989]) })).toBe(true);
        expect(attachmentMatchesFilter(att, { ids: new Set([1]) })).toBe(false);
    });

    it("matches by name regex", () => {
        expect(attachmentMatchesFilter(att, { nameRegex: /seed/i })).toBe(true);
        expect(attachmentMatchesFilter(att, { nameRegex: /img_/i })).toBe(false);
    });

    it("matches everything when filter is absent", () => {
        expect(attachmentMatchesFilter(att, undefined)).toBe(true);
    });
});

describe("isOpaqueAttachmentName / sniffAttachmentExt", () => {
    it("flags pluginPayloadAttachment and UUID stubs", () => {
        expect(isOpaqueAttachmentName("E484AD36-1BB0-4267-AAE6-41A3604380E9.pluginPayloadAttachment")).toBe(true);
        expect(isOpaqueAttachmentName("IMG_5675.png")).toBe(false);
        expect(isOpaqueAttachmentName("SeedTenant.php")).toBe(false);
    });

    it("sniffs png and mp4 magic bytes", () => {
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
        expect(sniffAttachmentExt(png)).toBe("png");

        const mp4 = Buffer.alloc(12);
        mp4.write("ftyp", 4, "ascii");
        mp4.write("isom", 8, "ascii");
        expect(sniffAttachmentExt(mp4)).toBe("mp4");
    });
});

describe("messagesAttachmentFileName", () => {
    it("keeps real filenames with extensions", () => {
        expect(
            messagesAttachmentFileName({
                rowid: 42,
                filename: null,
                mimeType: "image/png",
                transferName: "weird na me.png",
                totalBytes: 1,
            })
        ).toBe("42-weird_na_me.png");
    });

    it("replaces pluginPayload stubs using mime when no path", () => {
        expect(
            messagesAttachmentFileName({
                rowid: 11111,
                filename: null,
                mimeType: "image/png",
                transferName: "62EB308D-1734-4E48-A7E0-D6792F3F1ADF.pluginPayloadAttachment",
                totalBytes: 1,
            })
        ).toBe("11111-image.png");
    });

    it("falls back to attachment-{id}.bin", () => {
        expect(
            messagesAttachmentFileName({
                rowid: 7,
                filename: null,
                mimeType: null,
                transferName: null,
                totalBytes: 0,
            })
        ).toBe("7-attachment-7.bin");
    });
});

/** Counts how many times the conversation is paged out of SQLite. */
class CountingMessagesDatabase extends iMessagesDatabase {
    pageCalls = 0;

    override getMessages(_chatIdentifier: string, options?: { limit?: number; page?: number }): MessageInfo[] {
        this.pageCalls++;
        const limit = options?.limit ?? 50;
        const offset = ((options?.page ?? 1) - 1) * limit;
        const count = Math.max(0, Math.min(limit, 3 - offset));

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

describe("saveConversationExport", () => {
    it("pages the conversation once for both the attachment listing and the markdown", () => {
        // The listing and the body each used to walk the whole chat over the
        // same date range, so a 50 000-row export ran the paging twice.
        const db = new CountingMessagesDatabase();
        const outputDir = mkdtempSync(join(tmpdir(), "messages-export-"));

        try {
            const result = saveConversationExport({
                db,
                chatIdentifier: "chat1",
                outputDir,
                resolveContacts: false,
            });

            expect(result.markdownPath).toBeDefined();
            expect(db.pageCalls).toBe(1);
        } finally {
            rmSync(outputDir, { recursive: true, force: true });
        }
    });
});
