import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { appendEntry, logFilePathFor } from "./log-store";
import type { QaEntry } from "./types";

function entry(over: Partial<QaEntry> = {}): QaEntry {
    return {
        id: "01J0",
        ts: 1779000000000,
        sessionId: "s1",
        sessionTitle: null,
        project: "GenesisTools",
        repoRoot: "/r",
        cwd: "/r",
        branch: "main",
        commitSha: "abc1234",
        isWorktree: false,
        worktreePath: null,
        aiAgent: null,
        agentLabel: null,
        tag: "question",
        question: "why X?",
        answerMd: "because Y",
        refs: [],
        source: "cli",
        turnUuid: null,
        ...over,
    };
}

describe("log-store", () => {
    it("appends one JSON line per entry, newest at EOF", () => {
        const dir = mkdtempSync(join(tmpdir(), "qa-"));
        appendEntry(entry({ id: "a" }), dir);
        appendEntry(entry({ id: "b" }), dir);
        const file = logFilePathFor(entry(), dir);
        const lines = readFileSync(file, "utf8").trim().split("\n");
        expect(lines.length).toBe(2);
        expect((SafeJSON.parse(lines[1]) as { id: string }).id).toBe("b");
        expect((SafeJSON.parse(lines[0]) as { id: string }).id).toBe("a");
    });

    it("groups entries into per-day files by ts", () => {
        const dir = mkdtempSync(join(tmpdir(), "qa-"));
        const dayA = new Date("2026-01-02T10:00:00Z").getTime();
        const dayB = new Date("2026-03-04T10:00:00Z").getTime();
        appendEntry(entry({ id: "x", ts: dayA }), dir);
        appendEntry(entry({ id: "y", ts: dayB }), dir);
        expect(logFilePathFor({ ts: dayA }, dir)).not.toBe(logFilePathFor({ ts: dayB }, dir));
        expect(readFileSync(logFilePathFor({ ts: dayA }, dir), "utf8")).toContain('"id":"x"');
    });
});
