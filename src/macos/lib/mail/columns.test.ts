import { describe, expect, it } from "bun:test";
import type { MailMessage } from "@app/macos/lib/mail/types";
import { ALL_COLUMN_KEYS, DEFAULT_LIST_COLUMNS, MAIL_COLUMNS, type MailColumnKey, RECIPIENT_COLUMNS } from "./columns";

function makeMockMessage(overrides?: Partial<MailMessage>): MailMessage {
    return {
        rowid: 42,
        subject: "Test Subject Line",
        senderAddress: "alice@example.com",
        senderName: "Alice Smith",
        dateSent: new Date("2026-03-15T10:00:00Z"),
        dateReceived: new Date("2026-03-15T10:01:00Z"),
        mailbox: "INBOX",
        account: "personal@example.com",
        read: true,
        flagged: false,
        size: 2048,
        attachments: [],
        recipients: [
            { address: "bob@example.com", name: "Bob Jones", type: "to" },
            { address: "carol@example.com", name: "Carol White", type: "to" },
            { address: "dave@example.com", name: "Dave Green", type: "cc" },
        ],
        ...overrides,
    };
}

describe("columns", () => {
    describe("ALL_COLUMN_KEYS", () => {
        const expectedKeys: MailColumnKey[] = [
            "date",
            "from",
            "fromEmail",
            "to",
            "toEmail",
            "cc",
            "subject",
            "mailbox",
            "account",
            "read",
            "flagged",
            "size",
            "attachments",
            "body",
            "relevance",
        ];

        it("contains all expected keys", () => {
            for (const key of expectedKeys) {
                expect(ALL_COLUMN_KEYS).toContain(key);
            }
        });

        it("has no unexpected keys", () => {
            expect(ALL_COLUMN_KEYS.length).toBe(expectedKeys.length);
        });
    });

    describe("DEFAULT_LIST_COLUMNS", () => {
        it("is a subset of ALL_COLUMN_KEYS", () => {
            for (const col of DEFAULT_LIST_COLUMNS) {
                expect(ALL_COLUMN_KEYS).toContain(col);
            }
        });

        it("contains date, from, subject, attachments", () => {
            expect(DEFAULT_LIST_COLUMNS).toContain("date");
            expect(DEFAULT_LIST_COLUMNS).toContain("from");
            expect(DEFAULT_LIST_COLUMNS).toContain("subject");
            expect(DEFAULT_LIST_COLUMNS).toContain("attachments");
        });
    });

    describe("RECIPIENT_COLUMNS", () => {
        it("contains to, toEmail, cc", () => {
            expect(RECIPIENT_COLUMNS).toContain("to");
            expect(RECIPIENT_COLUMNS).toContain("toEmail");
            expect(RECIPIENT_COLUMNS).toContain("cc");
        });
    });

    describe("MAIL_COLUMNS structure", () => {
        it("has label and get for each key", () => {
            for (const key of ALL_COLUMN_KEYS) {
                const col = MAIL_COLUMNS[key];
                expect(typeof col.label).toBe("string");
                expect(col.label.length).toBeGreaterThan(0);
                expect(typeof col.get).toBe("function");
            }
        });
    });

    describe("column get functions return strings", () => {
        const msg = makeMockMessage();

        it("every column returns a string", () => {
            for (const key of ALL_COLUMN_KEYS) {
                const result = MAIL_COLUMNS[key].get(msg);
                expect(typeof result).toBe("string");
            }
        });
    });

    describe("individual column outputs", () => {
        it("from returns sender name when available", () => {
            const msg = makeMockMessage({ senderName: "Alice Smith" });
            expect(MAIL_COLUMNS.from.get(msg)).toBe("Alice Smith");
        });

        it("from falls back to sender address when name is empty", () => {
            const msg = makeMockMessage({ senderName: "" });
            expect(MAIL_COLUMNS.from.get(msg)).toBe("alice@example.com");
        });

        it("fromEmail returns sender address", () => {
            const msg = makeMockMessage();
            expect(MAIL_COLUMNS.fromEmail.get(msg)).toBe("alice@example.com");
        });

        it("subject truncates at 60 chars", () => {
            const longSubject = "A".repeat(80);
            const msg = makeMockMessage({ subject: longSubject });
            const result = MAIL_COLUMNS.subject.get(msg);
            expect(result.length).toBe(63); // 60 chars + "..."
            expect(result).toEndWith("...");
        });

        it("subject keeps short subjects intact", () => {
            const msg = makeMockMessage({ subject: "Short" });
            expect(MAIL_COLUMNS.subject.get(msg)).toBe("Short");
        });

        it("mailbox returns mailbox name", () => {
            const msg = makeMockMessage({ mailbox: "Sent" });
            expect(MAIL_COLUMNS.mailbox.get(msg)).toBe("Sent");
        });

        it("account returns account name", () => {
            const msg = makeMockMessage();
            expect(MAIL_COLUMNS.account.get(msg)).toBe("personal@example.com");
        });

        it("read returns 'yes' for read messages", () => {
            const msg = makeMockMessage({ read: true });
            expect(MAIL_COLUMNS.read.get(msg)).toBe("yes");
        });

        it("read returns 'no' for unread messages", () => {
            const msg = makeMockMessage({ read: false });
            expect(MAIL_COLUMNS.read.get(msg)).toBe("no");
        });

        it("flagged returns 'yes' for flagged messages", () => {
            const msg = makeMockMessage({ flagged: true });
            expect(MAIL_COLUMNS.flagged.get(msg)).toBe("yes");
        });

        it("flagged returns empty for unflagged messages", () => {
            const msg = makeMockMessage({ flagged: false });
            expect(MAIL_COLUMNS.flagged.get(msg)).toBe("");
        });

        it("size returns formatted bytes", () => {
            const msg = makeMockMessage({ size: 2048 });
            expect(MAIL_COLUMNS.size.get(msg)).toBe("2.0 KB");
        });

        it("attachments returns count when present", () => {
            const msg = makeMockMessage({
                attachments: [
                    { name: "doc.pdf", attachmentId: "1" },
                    { name: "img.png", attachmentId: "2" },
                ],
            });
            expect(MAIL_COLUMNS.attachments.get(msg)).toBe("2");
        });

        it("attachments returns empty when none", () => {
            const msg = makeMockMessage({ attachments: [] });
            expect(MAIL_COLUMNS.attachments.get(msg)).toBe("");
        });

        it("body returns 'yes' when bodyMatchesQuery is true", () => {
            const msg = makeMockMessage({ bodyMatchesQuery: true });
            expect(MAIL_COLUMNS.body.get(msg)).toBe("yes");
        });

        it("body returns empty when bodyMatchesQuery is false", () => {
            const msg = makeMockMessage({ bodyMatchesQuery: false });
            expect(MAIL_COLUMNS.body.get(msg)).toBe("");
        });

        it("relevance returns formatted score when semanticScore is set", () => {
            const msg = makeMockMessage({ semanticScore: 0.5 });
            const result = MAIL_COLUMNS.relevance.get(msg);
            expect(result).toBe("0.75"); // 1 - 0.5/2 = 0.75
        });

        it("relevance returns empty when semanticScore is undefined", () => {
            const msg = makeMockMessage({ semanticScore: undefined });
            expect(MAIL_COLUMNS.relevance.get(msg)).toBe("");
        });
    });

    describe("formatRecipients (via to/cc columns)", () => {
        it("to column returns comma-separated names", () => {
            const msg = makeMockMessage();
            const result = MAIL_COLUMNS.to.get(msg);
            expect(result).toBe("Bob Jones, Carol White");
        });

        it("cc column returns cc recipient name", () => {
            const msg = makeMockMessage();
            const result = MAIL_COLUMNS.cc.get(msg);
            expect(result).toBe("Dave Green");
        });

        it("to returns empty when no recipients", () => {
            const msg = makeMockMessage({ recipients: undefined });
            expect(MAIL_COLUMNS.to.get(msg)).toBe("");
        });

        it("to falls back to address when name is empty", () => {
            const msg = makeMockMessage({
                recipients: [{ address: "noname@example.com", name: "", type: "to" }],
            });
            expect(MAIL_COLUMNS.to.get(msg)).toBe("noname@example.com");
        });
    });

    describe("formatRecipientEmails (via toEmail column)", () => {
        it("toEmail returns comma-separated addresses", () => {
            const msg = makeMockMessage();
            const result = MAIL_COLUMNS.toEmail.get(msg);
            expect(result).toBe("bob@example.com, carol@example.com");
        });

        it("toEmail returns empty when no recipients", () => {
            const msg = makeMockMessage({ recipients: undefined });
            expect(MAIL_COLUMNS.toEmail.get(msg)).toBe("");
        });
    });
});
