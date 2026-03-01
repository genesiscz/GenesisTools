import { describe, expect, it } from "bun:test";
import type { AttachmentRow, ChatRow, MessageRevisionRow, MessageRowV2, SyncSegmentRow } from "../types";

describe("V2 type definitions", () => {
    it("MessageRowV2 extends MessageRow with new fields", () => {
        const msg: MessageRowV2 = {
            id: 1,
            chat_id: "123",
            sender_id: "456",
            text: "hello",
            media_desc: null,
            is_outgoing: 0,
            date_unix: 1700000000,
            date_iso: "2023-11-14T00:00:00Z",
            edited_date_unix: null,
            is_deleted: 0,
            deleted_at_iso: null,
            reply_to_msg_id: null,
        };
        expect(msg.is_deleted).toBe(0);
    });

    it("ChatRow has required fields", () => {
        const chat: ChatRow = {
            chat_id: "123",
            chat_type: "user",
            title: "John Doe",
            username: "johndoe",
            last_synced_at: "2023-11-14T00:00:00Z",
        };
        expect(chat.chat_type).toBe("user");
    });

    it("AttachmentRow has required fields", () => {
        const att: AttachmentRow = {
            chat_id: "123",
            message_id: 1,
            attachment_index: 0,
            kind: "photo",
            mime_type: "image/jpeg",
            file_name: null,
            file_size: 1024,
            telegram_file_id: "abc123",
            is_downloaded: 0,
            local_path: null,
            sha256: null,
        };
        expect(att.is_downloaded).toBe(0);
    });

    it("MessageRevisionRow tracks edits", () => {
        const rev: MessageRevisionRow = {
            id: 1,
            chat_id: "123",
            message_id: 1,
            revision_type: "edit",
            old_text: "hello",
            new_text: "hello!",
            revised_at_unix: 1700000100,
            revised_at_iso: "2023-11-14T00:01:40Z",
        };
        expect(rev.revision_type).toBe("edit");
    });

    it("SyncSegmentRow tracks coverage", () => {
        const seg: SyncSegmentRow = {
            id: 1,
            chat_id: "123",
            from_date_unix: 1700000000,
            to_date_unix: 1700086400,
            from_msg_id: 1,
            to_msg_id: 100,
            synced_at: "2023-11-14T00:00:00Z",
        };
        expect(seg.from_msg_id).toBe(1);
    });
});
