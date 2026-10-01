import { describe, expect, it } from "bun:test";
import { generateAttachmentName } from "@app/macos/lib/mail/format";
import { mailMessageUrl, messageIdFromRaw, normalizeMessageId } from "@app/macos/lib/mail/open";
import type { MailMessage } from "@genesiscz/utils/macos/mail/types";

function msg(subject: string): MailMessage {
    return {
        rowid: 42,
        subject,
        senderAddress: "v@example.com",
        senderName: "V",
        dateSent: new Date("2026-05-12T10:00:00.000Z"),
        dateReceived: new Date("2026-05-12T10:00:00.000Z"),
        mailbox: "INBOX",
        account: "a",
        read: true,
        flagged: false,
        size: 1,
        attachments: [],
    };
}

describe("generateAttachmentName", () => {
    it("prefixes the attachment with date and subject slug", () => {
        expect(generateAttachmentName(msg("March Invoice"), "Invoice-VCQYKK0H.pdf")).toBe(
            "2026-05-12-march-invoice-Invoice-VCQYKK0H.pdf"
        );
    });

    it("sanitizes path-unsafe characters in the original name", () => {
        expect(generateAttachmentName(msg("Order #3"), "weird/na me.pdf")).toBe("2026-05-12-order-3-weird_na_me.pdf");
    });
});

describe("mail open helpers", () => {
    it("reads the Message-ID header, folded or bracketed, and builds Mail's link", () => {
        const raw =
            "From: a@example.com\r\nMessage-ID:\r\n <abc.123@mail.example.com>\r\nSubject: x\r\n\r\nMessage-ID: <body@x>";
        expect(messageIdFromRaw(raw)).toBe("abc.123@mail.example.com");
        expect(messageIdFromRaw("Subject: none\n\nMessage-ID: <body@x>")).toBeNull();
        expect(normalizeMessageId(" <id@host> ")).toBe("id@host");
        expect(mailMessageUrl("a+b@host")).toBe("message://%3Ca%2Bb@host%3E");
    });
});
