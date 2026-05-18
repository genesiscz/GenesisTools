import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEntry } from "../lib/log-store";
import type { QaEntry } from "../lib/types";
import { renderDigest } from "./log";

describe("renderDigest", () => {
    it("renders newest-first grouped lines", () => {
        const logBase = mkdtempSync(join(tmpdir(), "qa-log-"));
        const base: QaEntry = {
            id: "1",
            ts: 1779000000000,
            sessionId: "s",
            sessionTitle: null,
            project: "GenesisTools",
            repoRoot: "/r",
            cwd: "/r",
            branch: "feat/x",
            commitSha: "abc1234",
            isWorktree: false,
            worktreePath: null,
            aiAgent: null,
            agentLabel: null,
            tag: "question",
            question: "why TanStack?",
            answerMd: "invalidation + devtools",
            refs: [],
            source: "cli",
            turnUuid: null,
        };
        appendEntry(base, logBase);
        const out = renderDigest({ logBase, dbPath: join(mkdtempSync(join(tmpdir(), "db-")), "qa.db") });
        expect(out).toContain("GenesisTools");
        expect(out).toContain("why TanStack?");
        expect(out).toContain("invalidation + devtools");
    });

    it("returns a placeholder when nothing is recorded", () => {
        const logBase = mkdtempSync(join(tmpdir(), "qa-empty-"));
        const out = renderDigest({ logBase, dbPath: join(mkdtempSync(join(tmpdir(), "db-")), "qa.db") });
        expect(out).toBe("No questions recorded.");
    });
});
