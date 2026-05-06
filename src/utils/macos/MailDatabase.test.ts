import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { MailDatabase, selectStaleMailChunkIds } from "./MailDatabase";

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

describe("selectStaleMailChunkIds", () => {
    it("selects chunks whose ROWID no longer exists in the envelope", () => {
        const idx = new Database(":memory:");
        const env = new Database(":memory:");
        setupIndex(idx);
        setupEnvelope(env);

        idx.exec(
            `INSERT INTO macos_mail_content (id, source_id, metadata_json) VALUES
                (1001, '100', '{"dateSent":1700000000}'),
                (1002, '200', '{"dateSent":1700000100}')`
        );
        // Only ROWID 200 lives; 100 has been deleted/compacted from the envelope.
        env.exec("INSERT INTO messages (ROWID, date_sent) VALUES (200, 1700000100)");

        expect(selectStaleMailChunkIds(idx, env, "macos_mail")).toEqual(["1001"]);
        // Selector must NOT mutate the index.
        expect((idx.query("SELECT COUNT(*) AS n FROM macos_mail_content").get() as { n: number }).n).toBe(2);
    });

    it("selects chunks whose live row is soft-deleted", () => {
        const idx = new Database(":memory:");
        const env = new Database(":memory:");
        setupIndex(idx);
        setupEnvelope(env);

        idx.exec(
            "INSERT INTO macos_mail_content (id, source_id, metadata_json) VALUES (1001, '100', '{\"dateSent\":1700000000}')"
        );
        env.exec("INSERT INTO messages (ROWID, date_sent, deleted) VALUES (100, 1700000000, 1)");

        expect(selectStaleMailChunkIds(idx, env, "macos_mail")).toEqual(["1001"]);
    });

    it("selects chunks whose live row's date_sent diverges from indexed value", () => {
        const idx = new Database(":memory:");
        const env = new Database(":memory:");
        setupIndex(idx);
        setupEnvelope(env);

        idx.exec(
            "INSERT INTO macos_mail_content (id, source_id, metadata_json) VALUES (1001, '100', '{\"dateSent\":1700000000}')"
        );
        // Same ROWID, different date_sent — covers rare server-side date
        // corrections (IMAP/Exchange resync). NOTE: Mail.app uses
        // AUTOINCREMENT so ROWIDs are never recycled; this isn't the
        // "old slot got a new message" case (that can't happen).
        env.exec("INSERT INTO messages (ROWID, date_sent) VALUES (100, 1800000000)");

        expect(selectStaleMailChunkIds(idx, env, "macos_mail")).toEqual(["1001"]);
    });

    it("keeps chunks whose ROWID + dateSent still match", () => {
        const idx = new Database(":memory:");
        const env = new Database(":memory:");
        setupIndex(idx);
        setupEnvelope(env);

        idx.exec(
            "INSERT INTO macos_mail_content (id, source_id, metadata_json) VALUES (1001, '100', '{\"dateSent\":1700000000}')"
        );
        env.exec("INSERT INTO messages (ROWID, date_sent) VALUES (100, 1700000000)");

        expect(selectStaleMailChunkIds(idx, env, "macos_mail")).toEqual([]);
    });

    it("is a no-op on an empty content table", () => {
        const idx = new Database(":memory:");
        const env = new Database(":memory:");
        setupIndex(idx);
        setupEnvelope(env);
        env.exec("INSERT INTO messages (ROWID, date_sent) VALUES (1, 1700000000)");

        expect(selectStaleMailChunkIds(idx, env, "macos_mail")).toEqual([]);
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

describe("MailDatabase null-sender JOIN regression", () => {
    // Live envelope inspection: 56 of 62,748 messages have m.sender = NULL
    // (all unsent drafts in Drafts/All-Mail mailboxes). MailDatabase used
    // INNER JOIN on addresses → those rows were silently dropped from every
    // search. This test pins the SQL pattern itself: INNER JOIN drops the
    // NULL-sender row, LEFT JOIN keeps it with a.address as null.
    it("LEFT JOIN on m.sender = a.ROWID keeps NULL-sender rows", () => {
        const env = new Database(":memory:");
        env.exec(`
            CREATE TABLE messages (ROWID INTEGER PRIMARY KEY, sender INTEGER);
            CREATE TABLE addresses (ROWID INTEGER PRIMARY KEY, address TEXT);
            INSERT INTO messages VALUES (100, NULL), (101, 1);
            INSERT INTO addresses VALUES (1, 'live@example.com');
        `);

        // The bug: INNER JOIN drops ROWID=100 because sender=NULL has no addresses match.
        const inner = env
            .query("SELECT m.ROWID FROM messages m INNER JOIN addresses a ON a.ROWID = m.sender ORDER BY m.ROWID")
            .all() as Array<{ ROWID: number }>;
        expect(inner.map((r) => r.ROWID)).toEqual([101]);

        // The fix: LEFT JOIN keeps ROWID=100 with a.address = null.
        const left = env
            .query(
                "SELECT m.ROWID, a.address FROM messages m LEFT JOIN addresses a ON a.ROWID = m.sender ORDER BY m.ROWID"
            )
            .all() as Array<{ ROWID: number; address: string | null }>;
        expect(left).toHaveLength(2);
        expect(left[0]).toEqual({ ROWID: 100, address: null });
        expect(left[1]).toEqual({ ROWID: 101, address: "live@example.com" });
    });
});
