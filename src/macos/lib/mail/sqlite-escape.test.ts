import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ATTACHMENT_JOIN, MESSAGE_SELECT } from "@app/utils/macos/mail-sql";

/**
 * Regression guard for the ESCAPE-clause bug.
 *
 * SQLite requires the ESCAPE argument to be a single character. The TS source
 * `"...ESCAPE '\\'..."` produces runtime SQL `ESCAPE '\'` (1 char `\`) — valid.
 * The buggy `"...ESCAPE '\\\\'..."` produces runtime SQL `ESCAPE '\\'` (2 chars) —
 * SQLite errors `ESCAPE expression must be a single character`.
 *
 * The clause now lives in src/utils/macos/mail-sql.ts as a shared constant.
 * Tests check both source-text drift and runtime SQLite parsing.
 */

const MAIL_SQL_PATH = join(import.meta.dir, "../../../utils/macos/mail-sql.ts");

describe("mail-sql.ts LIKE_ESCAPE_CLAUSE is single-char", () => {
    const source = readFileSync(MAIL_SQL_PATH, "utf8");

    it("source contains no `'\\\\\\\\'` quad-backslash escape literals", () => {
        const buggyPattern = /ESCAPE\s+'\\\\\\\\'/;
        expect(source).not.toMatch(buggyPattern);
    });

    it("source contains the correct `'\\\\'` (one-backslash) escape literal", () => {
        const goodPattern = /ESCAPE\s+'\\\\'/;
        expect(source).toMatch(goodPattern);
    });

    it("a representative LIKE pattern parses + executes against in-memory SQLite", () => {
        const db = new Database(":memory:");
        db.run(
            "CREATE TABLE messages (ROWID INTEGER, subject INTEGER, sender INTEGER, mailbox INTEGER, date_sent INTEGER, date_received INTEGER, deleted INTEGER, read INTEGER, flagged INTEGER, size INTEGER)"
        );
        db.run("CREATE TABLE subjects (ROWID INTEGER, subject TEXT)");
        db.run("CREATE TABLE addresses (ROWID INTEGER, address TEXT, comment TEXT)");
        db.run("CREATE TABLE mailboxes (ROWID INTEGER, url TEXT)");
        db.run("CREATE TABLE attachments (message INTEGER, name TEXT, attachment_id TEXT)");
        db.run("INSERT INTO subjects VALUES (1, 'ordinary subject')");
        db.run("INSERT INTO addresses VALUES (1, 'sender@example.com', 'Sender')");
        db.run("INSERT INTO mailboxes VALUES (1, 'imap://acc/INBOX')");
        db.run("INSERT INTO messages VALUES (42, 1, 1, 1, 1, 1, 0, 0, 0, 100)");
        db.run("INSERT INTO attachments VALUES (42, 'invoice-pay-now.pdf', 'att1')");

        const wildcardClause =
            "(s.subject LIKE ? ESCAPE '\\' OR a.address LIKE ? ESCAPE '\\' OR a.comment LIKE ? ESCAPE '\\' OR att.name LIKE ? ESCAPE '\\')";
        expect(() => {
            const rows = db
                .prepare(
                    `${MESSAGE_SELECT}
                    ${ATTACHMENT_JOIN}
                    WHERE ${wildcardClause}`
                )
                .all("%invoice%pay%", "%invoice%pay%", "%invoice%pay%", "%invoice%pay%") as Array<{
                rowid: number;
            }>;
            expect(rows.map((row) => row.rowid)).toEqual([42]);
        }).not.toThrow();
        db.close();
    });

    it("the source-level good and buggy escape literals produce different runtime lengths", () => {
        const goodClause = "s LIKE ? ESCAPE '\\'";
        const buggyClause = "s LIKE ? ESCAPE '\\\\'";

        expect(goodClause).toContain("ESCAPE '\\'");
        expect(buggyClause).toContain("ESCAPE '\\\\'");
        expect(goodClause.length).toBeLessThan(buggyClause.length);
    });
});
