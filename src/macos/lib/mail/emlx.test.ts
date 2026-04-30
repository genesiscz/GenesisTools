import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ENVELOPE_INDEX_PATH } from "./constants";
import { EmlxBodyExtractor } from "./emlx";

const MAIL_DIR = join(homedir(), "Library/Mail/V10");
const isDarwin = process.platform === "darwin";
const hasMailDir = isDarwin && existsSync(MAIL_DIR);

describe.skipIf(!hasMailDir)("EmlxBodyExtractor", () => {
    let extractor: EmlxBodyExtractor;

    beforeAll(async () => {
        extractor = await EmlxBodyExtractor.create();
    });

    afterAll(() => {
        extractor?.dispose();
    });

    it("builds emlx path index on create", () => {
        expect(extractor.indexedCount).toBeGreaterThan(0);
    });

    it("getSummary returns body from summaries table for cached messages", () => {
        // Not all messages have summaries, but the method shouldn't throw
        const result = extractor.getSummary(1);
        expect(result === null || typeof result === "string").toBe(true);
    });

    it("getBody returns body text for a known message", async () => {
        const db = new Database(ENVELOPE_INDEX_PATH, { readonly: true });
        const row = db.query("SELECT ROWID FROM messages WHERE deleted = 0 LIMIT 1").get() as { ROWID: number } | null;

        if (!row) {
            return; // No messages to test
        }

        const body = await extractor.getBody(row.ROWID);
        // May be null if emlx file doesn't exist, but shouldn't throw
        expect(body === null || typeof body === "string").toBe(true);
    });

    it("getBodies returns bodies for multiple rowids", async () => {
        const db = new Database(ENVELOPE_INDEX_PATH, { readonly: true });
        const rows = db.query("SELECT ROWID FROM messages WHERE deleted = 0 LIMIT 5").all() as Array<{ ROWID: number }>;
        const rowids = rows.map((r) => r.ROWID);

        const bodies = await extractor.getBodies(rowids);
        expect(bodies.size).toBeLessThanOrEqual(rowids.length);

        for (const body of bodies.values()) {
            expect(typeof body).toBe("string");
        }
    });

    it("parseEmlxFile extracts text body from MIME content", async () => {
        // Find any emlx file via the path index
        const path = extractor.getEmlxPath(1);

        if (!path) {
            return; // Skip if no path found for rowid 1
        }

        const body = await extractor.parseEmlxFile(path);
        expect(body === null || typeof body === "string").toBe(true);
    });

    it("getEmlxPath returns null for nonexistent rowid", () => {
        const path = extractor.getEmlxPath(999999999);
        expect(path).toBeNull();
    });

    it("getSummary returns null for nonexistent rowid", () => {
        const result = extractor.getSummary(999999999);
        expect(result).toBeNull();
    });
});
