import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEntry } from "./log-store";
import { openReadModel, queryEntries } from "./read-model";
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
});
