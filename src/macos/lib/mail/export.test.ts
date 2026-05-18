import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skip } from "@app/utils/test/skip";
import { exportMessages, parseMailIds } from "@app/macos/lib/mail/export";
import type { MailMessage } from "@app/macos/lib/mail/types";

function msg(rowid: number, subject: string): MailMessage {
    return {
        rowid,
        subject,
        senderAddress: "vendor@example.com",
        senderName: "Vendor Inc",
        dateSent: new Date("2026-05-12T10:00:00.000Z"),
        dateReceived: new Date("2026-05-12T10:00:01.000Z"),
        mailbox: "INBOX",
        account: "acct",
        read: true,
        flagged: false,
        size: 100,
        attachments: [],
        body: `Body of ${subject}`,
    };
}

describe.skipIf(skip.mailInfra)("exportMessages", () => {
    it("writes one markdown file per message under emails/", async () => {
        const dir = mkdtempSync(join(tmpdir(), "mailexport-"));
        const result = await exportMessages({
            messages: [msg(1, "First"), msg(2, "Second")],
            outputDir: dir,
            yes: true,
        });

        expect(result.emailCount).toBe(2);
        expect(existsSync(join(dir, "emails"))).toBe(true);
        expect(existsSync(join(dir, "index.md"))).toBe(true);
        expect(readFileSync(join(dir, "index.md"), "utf-8")).toContain("Total: 2 emails");
    });

    it("skips index.md for a single message", async () => {
        const dir = mkdtempSync(join(tmpdir(), "mailexport-"));
        await exportMessages({ messages: [msg(1, "Only")], outputDir: dir, yes: true });

        expect(existsSync(join(dir, "index.md"))).toBe(false);
    });
});

describe("parseMailIds", () => {
    it("parses comma-delimited positional ids", () => {
        expect(parseMailIds(["769643,769645,805843"], undefined)).toEqual([769643, 769645, 805843]);
    });

    it("parses space-delimited positional ids", () => {
        expect(parseMailIds(["769643", "769645"], undefined)).toEqual([769643, 769645]);
    });

    it("parses the --ids flag and dedupes against positionals", () => {
        expect(parseMailIds(["769643"], "769645,769643")).toEqual([769643, 769645]);
    });

    it("throws on a non-numeric id", () => {
        expect(() => parseMailIds(["abc"], undefined)).toThrow(/invalid/i);
    });

    it("returns an empty array when nothing is supplied", () => {
        expect(parseMailIds([], undefined)).toEqual([]);
    });
});

describe.skipIf(skip.mailInfra)("exportMessages attachmentsOnly", () => {
    it("does not create the emails/ dir or index.md when attachmentsOnly is set", async () => {
        const dir = mkdtempSync(join(tmpdir(), "mailexport-ao-"));
        const result = await exportMessages({
            messages: [msg(1, "First"), msg(2, "Second")],
            outputDir: dir,
            attachmentsOnly: true,
            yes: true,
        });

        expect(existsSync(join(dir, "emails"))).toBe(false);
        expect(existsSync(join(dir, "index.md"))).toBe(false);
        expect(existsSync(join(dir, "attachments"))).toBe(true);
        expect(result.emailsDir).toBeUndefined();
    });
});
