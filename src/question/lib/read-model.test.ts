import { Database } from "bun:sqlite";
import { describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearDatabaseReadSnapshots } from "@genesiscz/utils/database/read-snapshot";
import { appendEntry } from "./log-store";
import { insertForm, listFormsSnapshot, openPendingStore } from "./pending/store";
import {
    getEntryById,
    getStoredEntryById,
    markEntriesRead,
    markEntriesUnread,
    openReadModel,
    queryEntries,
    queryEntriesSnapshot,
} from "./read-model";
import type { QaEntry } from "./types";

function e(id: string, over: Partial<QaEntry> = {}): QaEntry {
    return {
        id,
        ts: Date.now(),
        sessionId: "s",
        sessionTitle: null,
        project: "P",
        repoRoot: "/r",
        cwd: "/r",
        branch: null,
        commitSha: null,
        commitMessage: null,
        agent: "unknown",
        isWorktree: false,
        worktreePath: null,
        aiAgent: null,
        agentLabel: null,
        tag: "question",
        question: `q${id}`,
        answerMd: "a",
        refs: [],
        source: "cli",
        turnUuid: null,
        ...over,
    };
}

describe("read-model", () => {
    it("lazily ingests JSONL and dedupes latest-wins via superseded_by", () => {
        const logBase = mkdtempSync(join(tmpdir(), "qa-log-"));
        const dbPath = join(mkdtempSync(join(tmpdir(), "qa-db-")), "qa.db");
        const dupTs = 1779000000000;
        appendEntry(e("a", { ts: dupTs, question: "same" }), logBase);
        appendEntry(e("b", { ts: dupTs + 500, question: "same", sessionId: "s" }), logBase);
        const db = openReadModel(dbPath);
        const rows = queryEntries(db, { logBase });
        const same = rows.filter((r) => r.question === "same" && !r.supersededBy);
        expect(same.length).toBe(1);
        expect(same[0].id).toBe("b");
    });

    it("filters by project and unread", () => {
        const logBase = mkdtempSync(join(tmpdir(), "qa-log-"));
        const dbPath = join(mkdtempSync(join(tmpdir(), "qa-db-")), "qa.db");
        appendEntry(e("x", { project: "Alpha" }), logBase);
        appendEntry(e("y", { project: "Beta" }), logBase);
        const db = openReadModel(dbPath);
        expect(queryEntries(db, { logBase, project: "Alpha" }).length).toBe(1);
        expect(queryEntries(db, { logBase, unread: true }).length).toBe(2);
    });

    it("indexes the newest active window before materializing answer bodies", () => {
        const root = mkdtempSync(join(tmpdir(), "qa-window-index-"));
        const logBase = join(root, "log");
        for (let i = 0; i < 25; i++) {
            appendEntry(e(`entry-${i}`, { ts: 1779000000000 + i * 3000 }), logBase);
        }
        const db = openReadModel(join(root, "qa.db"));
        const queries = spyOn(db, "query");
        try {
            queryEntries(db, { logBase });
            db.exec("UPDATE entries SET superseded_by='entry-23' WHERE id='entry-24'");
            const rows = queryEntries(db, { logBase, limit: 5 });
            expect(rows.map((row) => row.id)).toEqual(["entry-19", "entry-20", "entry-21", "entry-22", "entry-23"]);
            const sql = queries.mock.calls
                .map((args) => args[0])
                .find((sql) => sql.includes("SELECT * FROM entries WHERE"));
            expect(sql).toBeDefined();
            const plan = db.query<{ detail: string }, [number]>(`EXPLAIN QUERY PLAN ${sql}`).all(5);
            expect(plan.some((row) => row.detail.includes("entries USING INDEX idx_entries_active_ts"))).toBe(true);
            expect(plan.filter((row) => row.detail.includes("TEMP B-TREE"))).toHaveLength(1);
        } finally {
            queries.mockRestore();
            db.close();
        }
    });

    it("returns last N entries oldest→newest", () => {
        const logBase = mkdtempSync(join(tmpdir(), "qa-log-"));
        const dbPath = join(mkdtempSync(join(tmpdir(), "qa-db-")), "qa.db");
        const t0 = 1779000000000;
        appendEntry(e("old", { ts: t0, question: "oldest" }), logBase);
        appendEntry(e("mid", { ts: t0 + 1000, question: "middle" }), logBase);
        appendEntry(e("new", { ts: t0 + 2000, question: "newest" }), logBase);
        const db = openReadModel(dbPath);
        const last2 = queryEntries(db, { logBase, limit: 2 });
        expect(last2.map((r) => r.question)).toEqual(["middle", "newest"]);
        const all = queryEntries(db, { logBase, limit: 50 });
        expect(all.map((r) => r.question)).toEqual(["oldest", "middle", "newest"]);
    });

    it("marks entries read without touching already-read rows", () => {
        const logBase = mkdtempSync(join(tmpdir(), "qa-log-"));
        const dbPath = join(mkdtempSync(join(tmpdir(), "qa-db-")), "qa.db");
        appendEntry(e("r1"), logBase);
        appendEntry(e("r2"), logBase);
        const db = openReadModel(dbPath);
        queryEntries(db, { logBase });

        expect(markEntriesRead(db, ["r1", "r2"], { logBase })).toBe(2);
        expect(queryEntries(db, { logBase, unread: true }).length).toBe(0);
        expect(markEntriesRead(db, ["r1"], { logBase })).toBe(0);
    });

    it("marks entries unread", () => {
        const logBase = mkdtempSync(join(tmpdir(), "qa-log-"));
        const dbPath = join(mkdtempSync(join(tmpdir(), "qa-db-")), "qa.db");
        appendEntry(e("u1"), logBase);
        const db = openReadModel(dbPath);
        queryEntries(db, { logBase });

        markEntriesRead(db, ["u1"], { logBase });
        expect(queryEntries(db, { logBase, unread: true }).length).toBe(0);
        expect(markEntriesUnread(db, ["u1"], { logBase })).toBe(1);
        expect(queryEntries(db, { logBase, unread: true }).length).toBe(1);
    });
});

describe("answer attachments and session reads", () => {
    it("roundtrips image metadata and keeps legacy records readable", () => {
        const root = mkdtempSync(join(tmpdir(), "qa-image-index-"));
        const logBase = join(root, "log");
        const image = {
            type: "image" as const,
            id: "image-1",
            path: "/evidence/shot.png",
            name: "shot.png",
            mimeType: "image/png" as const,
            width: 2,
            height: 1,
            bytes: 90,
            sha256: "fixture-digest",
            label: "Before",
            comparison: { group: "layout", role: "before" as const },
        };
        appendEntry(e("legacy", { ts: 10 }), logBase);
        appendEntry(e("visual", { ts: 20, attachments: [image] }), logBase);
        const db = openReadModel(join(root, "qa.db"));
        try {
            const rows = queryEntries(db, { logBase });
            expect(rows[0].attachments).toEqual([]);
            expect(rows[1].attachments).toEqual([image]);
        } finally {
            db.close();
        }
    });

    it("filters a session before applying the result limit", () => {
        const root = mkdtempSync(join(tmpdir(), "qa-session-index-"));
        const logBase = join(root, "log");
        appendEntry(e("wanted", { ts: 10, sessionId: "selected" }), logBase);
        appendEntry(e("other", { ts: 20, sessionId: "unrelated" }), logBase);
        const db = openReadModel(join(root, "qa.db"));
        try {
            expect(queryEntries(db, { logBase, sessionId: "selected", limit: 1 }).map((row) => row.id)).toEqual([
                "wanted",
            ]);
        } finally {
            db.close();
        }
    });

    it("adds attachment storage to an existing index", () => {
        const root = mkdtempSync(join(tmpdir(), "qa-index-migration-"));
        const dbPath = join(root, "qa.db");
        const db = openReadModel(dbPath);
        db.exec("DROP INDEX idx_entries_missing_images");
        db.exec("ALTER TABLE entries DROP COLUMN attachments_json");
        db.close();
        const migrated = openReadModel(dbPath);
        try {
            const columns = migrated.query("PRAGMA table_info(entries)").all() as { name: string }[];
            expect(columns.some((column) => column.name === "attachments_json")).toBe(true);
        } finally {
            migrated.close();
        }
    });
});

it("recovers attachments ingested by an old reader without losing read/supersession state", () => {
    const root = mkdtempSync(join(tmpdir(), "qa-mixed-readers-"));
    const logBase = join(root, "log");
    const image = {
        type: "image" as const,
        id: "screenshot",
        path: "/evidence/image.png",
        name: "image.png",
        mimeType: "image/png" as const,
        width: 2,
        height: 2,
        bytes: 100,
        sha256: "fixture-digest",
    };
    const transcriptAnchor = {
        kind: "native" as const,
        provider: "codex" as const,
        sessionId: "s",
        receivedAt: 123,
        turnId: "native-turn",
    };
    appendEntry(e("old-reader", { attachments: [image], transcriptAnchor }), logBase);
    const db = openReadModel(join(root, "qa.db"));
    try {
        queryEntries(db, { logBase });
        // An old process stores the row without attachments and advances the shared byte offset.
        db.run(
            "UPDATE entries SET attachments_json = NULL, transcript_anchor_json = NULL, read_at = 123, superseded_by = 'newer' WHERE id = 'old-reader'"
        );
        const row = getEntryById(db, "old-reader", { logBase });
        expect(row?.attachments).toEqual([image]);
        expect(row?.transcriptAnchor).toEqual(transcriptAnchor);
        expect(row?.readAt).toBe(123);
        expect(row?.supersededBy).toBe("newer");
    } finally {
        db.close();
    }
});

it("backfills around corrupt JSONL rows already consumed by an older reader", () => {
    const root = mkdtempSync(join(tmpdir(), "qa-backfill-corrupt-"));
    const logBase = join(root, "log");
    const image = {
        type: "image" as const,
        id: "shot",
        path: "/evidence/image.png",
        name: "image.png",
        mimeType: "image/png" as const,
        width: 1,
        height: 1,
        bytes: 90,
        sha256: "fixture-digest",
    };
    const file = appendEntry(e("recover", { attachments: [image] }), logBase);
    const db = openReadModel(join(root, "qa.db"));
    try {
        queryEntries(db, { logBase });
        writeFileSync(file, `{broken\nnull\n${readFileSync(file, "utf8")}also-broken\n`);
        db.run("UPDATE entries SET attachments_json = NULL WHERE id = 'recover'");
        db.run("UPDATE ingest_offsets SET byte_offset = ?", [statSync(file).size]);
        expect(getEntryById(db, "recover", { logBase })?.attachments).toEqual([image]);
    } finally {
        db.close();
    }
});

function directoryBytes(root: string): Record<string, string> {
    const files: Record<string, string> = {};
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) {
            for (const [child, data] of Object.entries(directoryBytes(path))) {
                files[`${entry.name}/${child}`] = data;
            }
        } else {
            files[entry.name] = readFileSync(path).toString("base64");
        }
    }
    return files;
}

function durableDirectoryBytes(root: string): Record<string, string> {
    // SQLite readers update transient SHM read marks; durable DB, WAL and JSONL bytes must not change.
    return Object.fromEntries(Object.entries(directoryBytes(root)).filter(([path]) => !path.endsWith("-shm")));
}

it("snapshot readers ingest fresh JSONL without creating a missing store or directory", () => {
    const root = mkdtempSync(join(tmpdir(), "qa-snapshot-missing-"));
    const dbPath = join(root, "missing", "qa.db");
    const logBase = join(root, "log");
    appendEntry(e("first", { ts: 1_779_000_000_000 }), logBase);
    const before = directoryBytes(root);
    try {
        expect(listFormsSnapshot({ dbPath })).toEqual([]);
        expect(queryEntriesSnapshot({ dbPath, opts: { logBase } }).map((row) => row.id)).toEqual(["first"]);
        expect(directoryBytes(root)).toEqual(before);
        appendEntry(e("fresh", { ts: 1_779_000_010_000 }), logBase);
        const appended = directoryBytes(root);
        expect(queryEntriesSnapshot({ dbPath, opts: { logBase } }).map((row) => row.id)).toEqual(["first", "fresh"]);
        expect(directoryBytes(root)).toEqual(appended);
    } finally {
        clearDatabaseReadSnapshots();
    }
});

it("snapshot readers preserve stored metadata and pending WAL changes without altering store bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "qa-snapshot-wal-"));
    const dbPath = join(root, "qa.db");
    const logBase = join(root, "log");
    const image = {
        type: "image" as const,
        id: "image",
        path: "/fixture/image.png",
        name: "image.png",
        mimeType: "image/png" as const,
        width: 1,
        height: 1,
        bytes: 100,
        sha256: "fixture",
    };
    appendEntry(e("stored", { ts: 1_779_000_000_000, attachments: [image] }), logBase);
    const db = openReadModel(dbPath);
    const pending = openPendingStore(dbPath);
    try {
        queryEntries(db, { logBase });
        markEntriesRead(db, ["stored"], { logBase });
        insertForm(pending, {
            id: "fixture-form",
            createdAt: 1_779_000_000_000,
            projectPath: "/fixture",
            cwd: "/fixture",
            sessionHint: "s",
            items: [{ id: "item", promptMarkdown: "Proceed?" }],
            status: "pending",
        });
        appendEntry(e("fresh", { ts: 1_779_000_010_000 }), logBase);
        const before = durableDirectoryBytes(root);
        const rows = queryEntriesSnapshot({ dbPath, opts: { logBase } });
        expect(rows.map((row) => row.id)).toEqual(["stored", "fresh"]);
        expect(rows[0].readAt).not.toBeNull();
        expect(rows[0].attachments).toEqual([image]);
        expect(listFormsSnapshot({ dbPath })[0]?.id).toBe("fixture-form");
        expect(durableDirectoryBytes(root)).toEqual(before);
        // Intentional writers remain durable and invalidate the transient copy.
        markEntriesUnread(db, ["stored"], { logBase });
        expect(queryEntriesSnapshot({ dbPath, opts: { logBase } })[0].readAt).toBeNull();
        expect(durableDirectoryBytes(root)).not.toEqual(before);
    } finally {
        clearDatabaseReadSnapshots();
        pending.close();
        db.close();
    }
});

it("warm snapshot reads reuse the database copy and migrate a legacy schema only in memory", () => {
    const root = mkdtempSync(join(tmpdir(), "qa-snapshot-legacy-"));
    const dbPath = join(root, "qa.db");
    const db = openReadModel(dbPath);
    db.exec("DROP INDEX idx_entries_missing_images; ALTER TABLE entries DROP COLUMN attachments_json");
    db.close();
    const before = directoryBytes(root);
    const serialize = spyOn(Database.prototype, "serialize");
    try {
        expect(queryEntriesSnapshot({ dbPath, opts: { logBase: join(root, "log") } })).toEqual([]);
        expect(listFormsSnapshot({ dbPath })).toEqual([]);
        expect(queryEntriesSnapshot({ dbPath, opts: { logBase: join(root, "log") } })).toEqual([]);
        expect(serialize).toHaveBeenCalledTimes(1);
        expect(directoryBytes(root)).toEqual(before);
        const check = new Database(dbPath, { readonly: true });
        try {
            expect(
                check.query("SELECT name FROM pragma_table_info('entries') WHERE name='attachments_json'").all()
            ).toEqual([]);
        } finally {
            check.close();
        }
    } finally {
        serialize.mockRestore();
        clearDatabaseReadSnapshots();
    }
});

it("recovers receipt-time context when an older reader consumed a now-retired source log", () => {
    const root = mkdtempSync(join(tmpdir(), "qa-retired-anchor-"));
    const logBase = join(root, "log");
    const file = appendEntry(e("retired", { agent: "codex", sessionId: "retired-session", ts: 12345 }), logBase);
    const db = openReadModel(join(root, "qa.db"));
    try {
        queryEntries(db, { logBase });
        renameSync(file, file + ".retired");
        db.run(
            "UPDATE entries SET transcript_anchor_json = NULL, attachments_json = NULL, read_at = 99 WHERE id = 'retired'"
        );
        const row = getEntryById(db, "retired", { logBase });
        expect(row?.transcriptAnchor).toEqual({
            kind: "receipt-time",
            provider: "codex",
            sessionId: "retired-session",
            receivedAt: 12345,
        });
        expect(row?.readAt).toBe(99);
        expect(getEntryById(db, "retired", { logBase })?.transcriptAnchor).toEqual(row?.transcriptAnchor);
    } finally {
        db.close();
    }
});

it("keeps answers readable when optional stored provenance is malformed or from a newer writer", () => {
    const logBase = mkdtempSync(join(tmpdir(), "qa-log-"));
    const dbPath = join(mkdtempSync(join(tmpdir(), "qa-db-")), "qa.db");
    const receipt = {
        kind: "receipt-time" as const,
        provider: "codex" as const,
        sessionId: "poster-session",
        receivedAt: 123,
    };
    appendEntry(
        e("broken-anchor", { ts: 123, agent: "codex", sessionId: "poster-session", transcriptAnchor: receipt }),
        logBase
    );
    appendEntry(
        e("healthy-anchor", {
            ts: 124,
            transcriptAnchor: {
                kind: "native",
                provider: "grok",
                sessionId: "other-session",
                receivedAt: 124,
                messageId: "known-message",
            },
        }),
        logBase
    );
    const db = openReadModel(dbPath);
    try {
        queryEntries(db, { logBase });
        for (const raw of ["{", '{"kind":"future-anchor","messageId":"not-a-native-id"}', '{"kind":"native"}']) {
            db.query("UPDATE entries SET transcript_anchor_json = ? WHERE id = ?").run(raw, "broken-anchor");
            const row = getStoredEntryById(db, "broken-anchor");
            expect(row?.question).toBe("qbroken-anchor");
            expect(row?.transcriptAnchor).toEqual(receipt);
            expect(queryEntries(db, { logBase }).map((entry) => entry.id)).toEqual(["broken-anchor", "healthy-anchor"]);
            expect(getStoredEntryById(db, "healthy-anchor")?.transcriptAnchor).toMatchObject({
                kind: "native",
                messageId: "known-message",
            });
            expect(db.query("SELECT transcript_anchor_json FROM entries WHERE id = ?").get("broken-anchor")).toEqual({
                transcript_anchor_json: raw,
            });
        }
    } finally {
        db.close();
    }
});

it("reads a stored answer through a readonly connection without ingesting new log records", () => {
    const logBase = mkdtempSync(join(tmpdir(), "qa-log-"));
    const dbPath = join(mkdtempSync(join(tmpdir(), "qa-db-")), "qa.db");
    appendEntry(e("stored"), logBase);
    const writer = openReadModel(dbPath);
    queryEntries(writer, { logBase });
    writer.close();
    appendEntry(e("not-ingested"), logBase);
    const reader = new Database(dbPath, { readonly: true, create: false });
    try {
        expect(getStoredEntryById(reader, "stored")?.id).toBe("stored");
        expect(getStoredEntryById(reader, "not-ingested")).toBeNull();
        expect(reader.query("SELECT COUNT(*) AS count FROM entries").get()).toEqual({ count: 1 });
    } finally {
        reader.close();
    }
});
