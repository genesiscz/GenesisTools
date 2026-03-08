import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramHistoryStore } from "../TelegramHistoryStore";

function tmpDbPath() {
    return join(tmpdir(), `telegram-att-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe("TelegramHistoryStore attachments", () => {
    let store: TelegramHistoryStore;
    let dbPath: string;

    beforeEach(() => {
        dbPath = tmpDbPath();
        store = new TelegramHistoryStore();
        store.open(dbPath);
    });

    afterEach(() => {
        store.close();

        if (existsSync(dbPath)) {
            unlinkSync(dbPath);
        }
    });

    it("upserts attachment metadata", () => {
        store.upsertAttachment({
            chat_id: "chat1",
            message_id: 1,
            attachment_index: 0,
            kind: "photo",
            mime_type: "image/jpeg",
            file_name: null,
            file_size: 1024,
            telegram_file_id: "abc123",
        });

        const atts = store.getAttachments("chat1", 1);
        expect(atts.length).toBe(1);
        expect(atts[0].kind).toBe("photo");
        expect(atts[0].is_downloaded).toBe(0);
    });

    it("lists attachments for a chat", () => {
        store.upsertAttachment({
            chat_id: "chat1",
            message_id: 1,
            attachment_index: 0,
            kind: "photo",
            mime_type: "image/jpeg",
            file_name: null,
            file_size: 1024,
            telegram_file_id: "a",
        });
        store.upsertAttachment({
            chat_id: "chat1",
            message_id: 2,
            attachment_index: 0,
            kind: "video",
            mime_type: "video/mp4",
            file_name: "vid.mp4",
            file_size: 5000,
            telegram_file_id: "b",
        });
        store.upsertAttachment({
            chat_id: "chat1",
            message_id: 2,
            attachment_index: 1,
            kind: "document",
            mime_type: "application/pdf",
            file_name: "doc.pdf",
            file_size: 2000,
            telegram_file_id: "c",
        });

        const all = store.listAttachments("chat1");
        expect(all.length).toBe(3);

        const forMsg2 = store.getAttachments("chat1", 2);
        expect(forMsg2.length).toBe(2);
    });

    it("marks attachment as downloaded", () => {
        store.upsertAttachment({
            chat_id: "chat1",
            message_id: 1,
            attachment_index: 0,
            kind: "photo",
            mime_type: "image/jpeg",
            file_name: null,
            file_size: 1024,
            telegram_file_id: "a",
        });

        store.markAttachmentDownloaded("chat1", 1, 0, "/path/to/file.jpg", "sha256hash");

        const atts = store.getAttachments("chat1", 1);
        expect(atts[0].is_downloaded).toBe(1);
        expect(atts[0].local_path).toBe("/path/to/file.jpg");
        expect(atts[0].sha256).toBe("sha256hash");
    });
});
