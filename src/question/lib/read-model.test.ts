import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEntry } from "./log-store";
import { markEntriesRead, markEntriesUnread, openReadModel, queryEntries } from "./read-model";
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
