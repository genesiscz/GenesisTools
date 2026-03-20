import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MailSource } from "./mail-source";

const isDarwin = process.platform === "darwin";
const ENVELOPE = join(homedir(), "Library/Mail/V10/MailData/Envelope Index");
const hasMailDb = isDarwin && existsSync(ENVELOPE);

describe.skipIf(!hasMailDb)("MailSource", () => {
    let source: MailSource;

    beforeAll(async () => {
        source = await MailSource.create();
    });

    afterAll(() => {
        source?.dispose();
    });

    it("scan returns SourceEntry array with mail content", async () => {
        const entries = await source.scan({ limit: 10 });

        expect(entries.length).toBeGreaterThan(0);
        expect(entries.length).toBeLessThanOrEqual(10);

        const first = entries[0];
        expect(first.id).toBeDefined();
        expect(first.content.length).toBeGreaterThan(0);
        expect(first.path).toBeDefined();
    }, 30_000);

    it("scan calls onProgress callback", async () => {
        let progressCalled = false;

        await source.scan({
            limit: 5,
            onProgress: (current, total) => {
                progressCalled = true;
                expect(current).toBeLessThanOrEqual(total);
            },
        });

        expect(progressCalled).toBe(true);
    }, 30_000);

    it("estimateTotal returns message count", async () => {
        const total = await source.estimateTotal();
        expect(total).toBeGreaterThan(0);
    });

    it("detectChanges identifies new messages on first sync", async () => {
        const entries = await source.scan({ limit: 5 });

        const changes = source.detectChanges({
            previousHashes: null,
            currentEntries: entries,
        });

        expect(changes.added.length).toBe(entries.length);
        expect(changes.unchanged.length).toBe(0);
    }, 30_000);

    it("detectChanges identifies unchanged messages on second sync", async () => {
        const entries = await source.scan({ limit: 5 });

        const hashes = new Map<string, string>();

        for (const entry of entries) {
            hashes.set(entry.id, source.hashEntry(entry));
        }

        const changes = source.detectChanges({
            previousHashes: hashes,
            currentEntries: entries,
        });

        expect(changes.added.length).toBe(0);
        expect(changes.unchanged.length).toBe(entries.length);
    }, 30_000);

    it("entry content includes subject and sender", async () => {
        const entries = await source.scan({ limit: 1 });

        if (entries.length > 0) {
            const content = entries[0].content;
            expect(content).toContain("Subject:");
            expect(content).toContain("From:");
        }
    }, 30_000);

    it("entry metadata has expected fields", async () => {
        const entries = await source.scan({ limit: 1 });

        if (entries.length > 0) {
            const meta = entries[0].metadata;
            expect(meta).toBeDefined();
            expect(typeof meta!.rowid).toBe("number");
            expect(typeof meta!.mailbox).toBe("string");
            expect(typeof meta!.read).toBe("boolean");
            expect(typeof meta!.flagged).toBe("boolean");
            expect(typeof meta!.hasBody).toBe("boolean");
        }
    }, 30_000);

    it("hashEntry produces consistent hashes", async () => {
        const entries = await source.scan({ limit: 1 });

        if (entries.length > 0) {
            const hash1 = source.hashEntry(entries[0]);
            const hash2 = source.hashEntry(entries[0]);
            expect(hash1).toBe(hash2);
            expect(hash1.length).toBe(64); // SHA-256 hex
        }
    }, 30_000);
});
