import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { resolveInboxRowids, resolveMailboxRowids } from "./mail-sql";

const IMAP_ACCOUNT = "AAAA-0001";
const GMAIL_ACCOUNT = "BBBB-0002";
const EWS_ACCOUNT = "CCCC-0003";

/** Percent-encoded UTF-8 NFD, the way Mail.app stores non-ASCII mailbox names. */
const EWS_INBOX_URL = `ews://${EWS_ACCOUNT}/Doruc%CC%8Cena%CC%81%20pos%CC%8Cta`;
const GMAIL_ALL_MAIL_URL = `imap://${GMAIL_ACCOUNT}/%5BGmail%5D/Vs%CC%8Cechny%20zpra%CC%81vy`;

function fixtureDb(): Database {
    const db = new Database(":memory:");
    db.run("CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY, url TEXT)");
    db.run("CREATE TABLE messages (ROWID INTEGER PRIMARY KEY, mailbox INTEGER, deleted INTEGER DEFAULT 0)");

    const mailboxes: Array<[number, string, number]> = [
        [1, `imap://${IMAP_ACCOUNT}/INBOX`, 3],
        [2, `imap://${IMAP_ACCOUNT}/Sent Messages`, 2],
        [3, `imap://${GMAIL_ACCOUNT}/INBOX`, 0],
        [4, GMAIL_ALL_MAIL_URL, 5],
        [5, `imap://${GMAIL_ACCOUNT}/%5BGmail%5D/Kos%CC%8C`, 1],
        [6, `imap://${GMAIL_ACCOUNT}/%5BGmail%5D/Spam`, 4],
        [7, EWS_INBOX_URL, 2],
        [8, `ews://${EWS_ACCOUNT}/Odeslana%CC%81%20pos%CC%8Cta`, 1],
    ];

    let rowid = 1;

    for (const [id, url, count] of mailboxes) {
        db.run("INSERT INTO mailboxes (ROWID, url) VALUES (?, ?)", [id, url]);

        for (let i = 0; i < count; i++) {
            db.run("INSERT INTO messages (ROWID, mailbox) VALUES (?, ?)", [rowid++, id]);
        }
    }

    db.run("INSERT INTO messages (ROWID, mailbox, deleted) VALUES (?, ?, 1)", [rowid, 3]);

    return db;
}

describe("resolveInboxRowids", () => {
    test("returns every account's inbox, using All Mail for a Gmail account whose INBOX row is empty", () => {
        const db = fixtureDb();
        expect(resolveInboxRowids(db).sort()).toEqual([1, 4, 7]);
    });

    test("ignores deleted messages when deciding whether an INBOX row is live", () => {
        const db = fixtureDb();
        expect(resolveInboxRowids(db)).not.toContain(3);
    });

    test("scopes to one account when an account needle is given", () => {
        const db = fixtureDb();
        expect(resolveInboxRowids(db, GMAIL_ACCOUNT.toLowerCase())).toEqual([4]);
        expect(resolveInboxRowids(db, EWS_ACCOUNT.toLowerCase())).toEqual([7]);
    });

    test("keeps a live INBOX row over All Mail when both exist", () => {
        const db = fixtureDb();
        db.run("INSERT INTO messages (ROWID, mailbox) VALUES (?, ?)", [999, 3]);
        expect(resolveInboxRowids(db, GMAIL_ACCOUNT.toLowerCase())).toEqual([3]);
    });
});

describe("resolveMailboxRowids", () => {
    test("treats INBOX (any case) as the all-accounts inbox alias", () => {
        const db = fixtureDb();
        expect(resolveMailboxRowids(db, "INBOX")?.sort()).toEqual([1, 4, 7]);
        expect(resolveMailboxRowids(db, "inbox")?.sort()).toEqual([1, 4, 7]);
        expect(resolveMailboxRowids(db, "INBOX", GMAIL_ACCOUNT)).toEqual([4]);
    });

    test("still matches other mailbox names by decoded NFC substring", () => {
        const db = fixtureDb();
        expect(resolveMailboxRowids(db, "Doručená pošta")).toEqual([7]);
        expect(resolveMailboxRowids(db, "Všechny zprávy")).toEqual([4]);
        expect(resolveMailboxRowids(db, "Sent Messages")).toEqual([2]);
    });

    test("returns undefined with no filters", () => {
        expect(resolveMailboxRowids(fixtureDb())).toBeUndefined();
    });
});
