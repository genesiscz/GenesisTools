import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { buildMailFilterPredicate } from "./search-filters";

describe("buildMailFilterPredicate", () => {
    it("returns null when no filters set", () => {
        expect(buildMailFilterPredicate({})).toBeNull();
    });

    it("returns null when only false-y filters present", () => {
        expect(buildMailFilterPredicate({ from: undefined, to: undefined })).toBeNull();
    });

    it("emits date_sent BETWEEN for from+to as integer unix seconds", () => {
        const r = buildMailFilterPredicate({
            from: new Date("2026-01-01T00:00:00Z"),
            to: new Date("2026-03-10T00:00:00Z"),
        });
        expect(r).not.toBeNull();
        expect(r!.sql).toContain("date_sent");
        expect(r!.params.length).toBe(2);
        expect(typeof r!.params[0]).toBe("number");
        expect(r!.params[0]).toBe(Math.floor(new Date("2026-01-01T00:00:00Z").getTime() / 1000));
    });

    it("emits >= when only `from` is set", () => {
        const r = buildMailFilterPredicate({ from: new Date("2026-01-01") });
        expect(r!.sql).toContain("date_sent >=");
        expect(r!.params.length).toBe(1);
    });

    it("emits <= when only `to` is set", () => {
        const r = buildMailFilterPredicate({ to: new Date("2026-03-10") });
        expect(r!.sql).toContain("date_sent <=");
        expect(r!.params.length).toBe(1);
    });

    it("emits mailbox LIKE with %wildcard%", () => {
        const r = buildMailFilterPredicate({ mailbox: "INBOX" });
        expect(r!.sql).toContain("mb.url LIKE");
        expect(r!.params).toContain("%INBOX%");
    });

    it("emits recipient subquery referencing mailapp.recipients", () => {
        const r = buildMailFilterPredicate({ receiver: "foo@example.com" });
        expect(r!.sql).toContain("mailapp.recipients");
        expect(r!.params).toContain("%foo@example.com%");
    });

    it("combines multiple filters with AND", () => {
        const r = buildMailFilterPredicate({
            from: new Date("2026-01-01"),
            mailbox: "INBOX",
        });
        expect(r!.sql.split(" AND ").length).toBeGreaterThanOrEqual(2);
        expect(r!.params.length).toBe(2);
    });

    it("escapes LIKE metacharacters in mailbox", () => {
        const r = buildMailFilterPredicate({ mailbox: "100%complete" });
        expect(r!.params[0]).toBe("%100\\%complete%");
        // SQL must contain `ESCAPE '\'` (1-char backslash escape) — anything else is invalid SQLite.
        // /ESCAPE\s+'\\'/ matches the string `ESCAPE '\'` (one literal backslash between quotes).
        expect(r!.sql).toMatch(/ESCAPE\s+'\\'/);
        // Negative guard: explicitly fail on the broken 2-char form `ESCAPE '\\'`.
        expect(r!.sql).not.toMatch(/ESCAPE\s+'\\\\'/);
    });

    it("emits SQL that SQLite can actually execute (regression guard for ESCAPE bug)", () => {
        const r = buildMailFilterPredicate({ mailbox: "INBOX" });
        expect(r).not.toBeNull();

        // Build a minimal in-memory schema that mirrors what the predicate references.
        // We don't actually need to run the search — we just need SQLite to PARSE the predicate.
        const db = new Database(":memory:");
        db.run("CREATE TABLE c (source_id TEXT)");
        db.run("ATTACH DATABASE ':memory:' AS mailapp");
        db.run(
            "CREATE TABLE mailapp.messages (ROWID INTEGER, deleted INTEGER, mailbox INTEGER, date_sent INTEGER, sender INTEGER)"
        );
        db.run("CREATE TABLE mailapp.mailboxes (ROWID INTEGER, url TEXT)");
        db.run("CREATE TABLE mailapp.recipients (message INTEGER, address INTEGER, type INTEGER)");
        db.run("CREATE TABLE mailapp.addresses (ROWID INTEGER, address TEXT)");

        // If the predicate has invalid ESCAPE syntax, this prepare() throws.
        expect(() => {
            db.prepare(`SELECT 1 FROM c WHERE ${r!.sql}`).all(...r!.params);
        }).not.toThrow();

        db.close();
    });

    it("references indexed c.source_id directly and casts Mail ROWID to TEXT for ATTACH-pushdown", () => {
        const r = buildMailFilterPredicate({ from: new Date("2026-01-01") });
        expect(r!.sql).toContain("c.source_id IN");
        expect(r!.sql).toContain("SELECT CAST(m.ROWID AS TEXT)");
        expect(r!.sql).not.toContain("CAST(c.source_id AS INTEGER)");
        expect(r!.sql).toContain("mailapp.messages");
    });

    it("includes m.deleted = 0 in the inner predicate", () => {
        const r = buildMailFilterPredicate({ from: new Date("2026-01-01") });
        expect(r!.sql).toContain("m.deleted = 0");
    });

    it("includes JOINs only when needed by present filters", () => {
        const onlyDate = buildMailFilterPredicate({ from: new Date("2026-01-01") });
        expect(onlyDate!.sql).not.toContain("mailapp.recipients");
        expect(onlyDate!.sql).not.toContain("mailapp.mailboxes");

        const withMailbox = buildMailFilterPredicate({ mailbox: "INBOX" });
        expect(withMailbox!.sql).toContain("mailapp.mailboxes");
    });

    it("uses m.mailbox IN(...) when mailboxRowids supplied (Czech / unicode path)", () => {
        const r = buildMailFilterPredicate({ mailboxRowids: [3, 7, 12] });
        expect(r).not.toBeNull();
        expect(r!.sql).toContain("m.mailbox IN (3,7,12)");
        // No mb.url LIKE join needed when rowids are pre-resolved
        expect(r!.sql).not.toContain("mb.url LIKE");
        expect(r!.sql).not.toContain("mailapp.mailboxes");
        expect(r!.params.length).toBe(0);
    });

    it("emits 1 = 0 when mailboxRowids is empty (no matches)", () => {
        const r = buildMailFilterPredicate({ mailboxRowids: [] });
        expect(r).not.toBeNull();
        expect(r!.sql).toContain("1 = 0");
    });
});

import { resolveMailboxRowids } from "@app/utils/macos/mail-sql";

describe("resolveMailboxRowids", () => {
    function freshDb(): Database {
        const db = new Database(":memory:");
        db.run("CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY, url TEXT)");
        // Real-world Mail.app stores URL-encoded UTF-8 in mailboxes.url.
        db.run(
            "INSERT INTO mailboxes (ROWID, url) VALUES " +
                "(1, 'imap://user@host/INBOX')," +
                "(2, 'imap://user@host/Doru%C4%8Den%C3%A1%20po%C5%A1ta')," + // Doručená pošta
                "(3, 'imap://user@host/Sent%20Messages')," +
                "(4, 'imap://user@host/Archive')"
        );
        return db;
    }

    it("returns undefined when neither mailbox nor account is set", () => {
        const db = freshDb();
        expect(resolveMailboxRowids(db)).toBeUndefined();
    });

    it("matches URL-encoded Czech name case-insensitively (Doručená pošta, NFC composed)", () => {
        const db = freshDb();
        expect(resolveMailboxRowids(db, "Doručená pošta")).toEqual([2]);
        expect(resolveMailboxRowids(db, "DORUČENÁ POŠTA")).toEqual([2]);
    });

    it("matches NFD-encoded Czech name (Mail.app stores combining diacritics)", () => {
        // Real Mail.app DBs store NFD: `Doruc%CC%8Cena%CC%81 pos%CC%8Cta` decodes to
        // `Doruc + U+030C + ena + U+0301 + pos + U+030C + ta`. User input is NFC
        // composed (`č`, `á`, `š`). Both forms must match the same mailbox.
        const db = new Database(":memory:");
        db.run("CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY, url TEXT)");
        db.run(
            "INSERT INTO mailboxes (ROWID, url) VALUES " +
                "(1, 'ews://abc/Doruc%CC%8Cena%CC%81%20pos%CC%8Cta')," + // NFD
                "(2, 'imap://x/INBOX')"
        );
        // User types NFC; row stores NFD. With normalization both should match ROWID 1.
        expect(resolveMailboxRowids(db, "Doručená pošta")).toEqual([1]);
    });

    it("matches plain ASCII names (no regression)", () => {
        const db = freshDb();
        expect(resolveMailboxRowids(db, "INBOX")).toEqual([1]);
        expect(resolveMailboxRowids(db, "inbox")).toEqual([1]);
    });

    it("returns empty array when nothing matches", () => {
        const db = freshDb();
        expect(resolveMailboxRowids(db, "no-such-mailbox-anywhere")).toEqual([]);
    });

    it("intersects mailbox + account substring constraints", () => {
        const db = freshDb();
        // mailbox "Sent" within account substring "user@host" → only ROWID 3
        expect(resolveMailboxRowids(db, "Sent", "user@host")).toEqual([3]);
    });
});
