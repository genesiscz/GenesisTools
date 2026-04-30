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
});
