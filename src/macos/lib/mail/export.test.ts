import { describe, expect, it, mock } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MailMessage } from "@genesiscz/utils/macos/mail/types";
import { skip } from "@genesiscz/utils/test/skip";

// exportMessages() replaces every message body with what EmlxBodyExtractor reads from the real
// ~/Library/Mail/V10 store, so these tests swap the extractor for one that serves the fixture
// bodies. No real message is ever read. The rowids are ones Mail never assigns as well, so if this
// mock ever stops applying, the real store has nothing to return and the body assertions fail.
const fixtureBodies = new Map<number, string>();
const bodyReads: number[] = [];

class FixtureBodyExtractor {
    static async create(): Promise<FixtureBodyExtractor> {
        return new FixtureBodyExtractor();
    }

    async getBody(rowid: number): Promise<string | null> {
        bodyReads.push(rowid);
        return fixtureBodies.get(rowid) ?? null;
    }

    dispose(): void {}
}

mock.module("@app/macos/lib/mail/emlx", () => ({
    EmlxBodyExtractor: FixtureBodyExtractor,
    parseEmlxBodyPartsFromFile: async () => null,
}));

const { exportMessages, parseMailIds } = await import("@app/macos/lib/mail/export");

const FIRST = 999_999_001;
const SECOND = 999_999_002;

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

/** A fixture message whose body the fake extractor serves back to exportMessages(). */
function fixture(rowid: number, subject: string): MailMessage {
    fixtureBodies.set(rowid, `Fixture body of ${subject}`);
    return msg(rowid, subject);
}

describe.skipIf(skip.mailInfra)("exportMessages", () => {
    it("writes one markdown file per message under emails/", async () => {
        const dir = mkdtempSync(join(tmpdir(), "mailexport-"));
        bodyReads.length = 0;
        const result = await exportMessages({
            messages: [fixture(FIRST, "First"), fixture(SECOND, "Second")],
            outputDir: dir,
            yes: true,
        });

        expect(result.emailCount).toBe(2);
        expect(bodyReads).toEqual([FIRST, SECOND]);
        expect(existsSync(join(dir, "index.md"))).toBe(true);
        expect(readFileSync(join(dir, "index.md"), "utf-8")).toContain("Total: 2 emails");

        const files = readdirSync(join(dir, "emails")).sort();
        expect(files).toEqual([`2026-05-12-first-${FIRST}.md`, `2026-05-12-second-${SECOND}.md`]);

        const first = readFileSync(join(dir, "emails", files[0]), "utf-8");
        expect(first).toContain("First");
        expect(first).toContain("vendor@example.com");
        expect(first).toContain("Fixture body of First");
        expect(readFileSync(join(dir, "emails", files[1]), "utf-8")).toContain("Fixture body of Second");
    });

    it("skips index.md for a single message", async () => {
        const dir = mkdtempSync(join(tmpdir(), "mailexport-"));
        await exportMessages({ messages: [fixture(FIRST, "Only")], outputDir: dir, yes: true });

        expect(existsSync(join(dir, "index.md"))).toBe(false);
        expect(readdirSync(join(dir, "emails"))).toEqual([`2026-05-12-only-${FIRST}.md`]);
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
            messages: [fixture(FIRST, "First"), fixture(SECOND, "Second")],
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
