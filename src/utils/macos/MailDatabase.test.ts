import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { MailDatabase, pruneStaleMailChunks } from "./MailDatabase";

function setupIndex(db: Database): void {
    db.exec(
        `CREATE TABLE macos_mail_content (
            id INTEGER PRIMARY KEY,
            source_id TEXT NOT NULL,
            content TEXT,
            metadata_json TEXT
        )`
    );
}

function setupEnvelope(db: Database): void {
    db.exec(
        `CREATE TABLE messages (
            ROWID INTEGER PRIMARY KEY,
            date_sent INTEGER,
            deleted INTEGER DEFAULT 0
        )`
    );
}

describe("pruneStaleMailChunks", () => {
    it("removes chunks whose ROWID no longer exists in the envelope", () => {
        const idx = new Database(":memory:");
        const env = new Database(":memory:");
        setupIndex(idx);
        setupEnvelope(env);

        idx.exec(
            `INSERT INTO macos_mail_content (source_id, metadata_json) VALUES
                ('100', '{"dateSent":1700000000}'),
                ('200', '{"dateSent":1700000100}')`
        );
        // Only ROWID 200 lives; 100 has been deleted/compacted from the envelope.
        env.exec("INSERT INTO messages (ROWID, date_sent) VALUES (200, 1700000100)");

        expect(pruneStaleMailChunks(idx, env, "macos_mail")).toBe(1);
        const remaining = idx.query("SELECT source_id FROM macos_mail_content").all() as Array<{ source_id: string }>;
        expect(remaining).toEqual([{ source_id: "200" }]);
    });

    it("removes chunks whose live row is soft-deleted", () => {
        const idx = new Database(":memory:");
        const env = new Database(":memory:");
        setupIndex(idx);
        setupEnvelope(env);

        idx.exec(
            "INSERT INTO macos_mail_content (source_id, metadata_json) VALUES ('100', '{\"dateSent\":1700000000}')"
        );
        env.exec("INSERT INTO messages (ROWID, date_sent, deleted) VALUES (100, 1700000000, 1)");

        expect(pruneStaleMailChunks(idx, env, "macos_mail")).toBe(1);
    });

    it("removes chunks whose live row's date_sent diverges (recycled ROWID)", () => {
        const idx = new Database(":memory:");
        const env = new Database(":memory:");
        setupIndex(idx);
        setupEnvelope(env);

        idx.exec(
            "INSERT INTO macos_mail_content (source_id, metadata_json) VALUES ('100', '{\"dateSent\":1700000000}')"
        );
        // Same ROWID, different message — Mail.app reuses ROWIDs after deletes.
        env.exec("INSERT INTO messages (ROWID, date_sent) VALUES (100, 1800000000)");

        expect(pruneStaleMailChunks(idx, env, "macos_mail")).toBe(1);
    });

    it("keeps chunks whose ROWID + dateSent still match", () => {
        const idx = new Database(":memory:");
        const env = new Database(":memory:");
        setupIndex(idx);
        setupEnvelope(env);

        idx.exec(
            "INSERT INTO macos_mail_content (source_id, metadata_json) VALUES ('100', '{\"dateSent\":1700000000}')"
        );
        env.exec("INSERT INTO messages (ROWID, date_sent) VALUES (100, 1700000000)");

        expect(pruneStaleMailChunks(idx, env, "macos_mail")).toBe(0);
        expect((idx.query("SELECT COUNT(*) AS n FROM macos_mail_content").get() as { n: number }).n).toBe(1);
    });

    it("is a no-op on an empty content table", () => {
        const idx = new Database(":memory:");
        const env = new Database(":memory:");
        setupIndex(idx);
        setupEnvelope(env);
        env.exec("INSERT INTO messages (ROWID, date_sent) VALUES (1, 1700000000)");

        expect(pruneStaleMailChunks(idx, env, "macos_mail")).toBe(0);
    });
});

describe("MailDatabase.getMailChunkDateRange", () => {
    it("returns MIN/MAX dateSent across the content table", () => {
        const idx = new Database(":memory:");
        setupIndex(idx);
        idx.exec(
            `INSERT INTO macos_mail_content (source_id, metadata_json) VALUES
                ('1', '{"dateSent":1700000000}'),
                ('2', '{"dateSent":1700001000}'),
                ('3', '{"dateSent":1699990000}')`
        );

        const r = MailDatabase.getMailChunkDateRange(idx, "macos_mail");
        expect(r.minTs).toBe(1699990000);
        expect(r.maxTs).toBe(1700001000);
    });

    it("returns nulls for an empty content table", () => {
        const idx = new Database(":memory:");
        setupIndex(idx);

        const r = MailDatabase.getMailChunkDateRange(idx, "macos_mail");
        expect(r.minTs).toBeNull();
        expect(r.maxTs).toBeNull();
    });
});
