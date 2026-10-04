import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripAnsi } from "@genesiscz/utils/string";
import { appendEntry } from "../lib/log-store";
import type { QaEntry } from "../lib/types";
import { noDecisionsMessage } from "./decisions";
import { renderDigest } from "./log";

describe("renderDigest", () => {
    it("renders last-N entries oldest→newest", () => {
        const logBase = mkdtempSync(join(tmpdir(), "qa-log-"));
        const dbPath = join(mkdtempSync(join(tmpdir(), "db-")), "qa.db");
        const base = (id: string, ts: number, question: string): QaEntry => ({
            id,
            ts,
            sessionId: "s",
            sessionTitle: null,
            project: "GenesisTools",
            repoRoot: "/r",
            cwd: "/r",
            branch: "feat/x",
            commitSha: "abc1234",
            commitMessage: null,
            agent: "unknown",
            isWorktree: false,
            worktreePath: null,
            aiAgent: null,
            agentLabel: null,
            tag: "question",
            question,
            answerMd: `answer-${id}`,
            refs: [],
            source: "cli",
            turnUuid: null,
        });
        appendEntry(base("1", 1779000000000, "why TanStack?"), logBase);
        appendEntry(base("2", 1779000001000, "code-review xhigh PR #288"), logBase);
        const out = renderDigest({ logBase, dbPath, limit: 50 });
        expect(out).toContain("GenesisTools");
        expect(out).toContain("why TanStack?");
        expect(out).toContain("code-review xhigh PR #288");
        // Chronological: older question appears before newer.
        expect(out.indexOf("why TanStack?")).toBeLessThan(out.indexOf("code-review xhigh PR #288"));
    });

    it("returns a placeholder when nothing is recorded", () => {
        const logBase = mkdtempSync(join(tmpdir(), "qa-empty-"));
        const out = renderDigest({ logBase, dbPath: join(mkdtempSync(join(tmpdir(), "db-")), "qa.db") });
        // pc.dim() colorizes when CI is set (picocolors treats `"CI" in env` as
        // color-supported even without a TTY), so strip ANSI before the exact match.
        expect(stripAnsi(out)).toBe("No questions recorded.");
    });
});

describe("noDecisionsMessage", () => {
    // Regression test: #453.5 — `tools question list` with nothing to show printed a single
    // blank line (`decisionsMarkdown([])` is an empty string), with no "nothing here" message
    // and no hint about widening the search.
    it("names the session scope and hints at --all-sessions", () => {
        const message = noDecisionsMessage("session-a");

        expect(message).toContain("this session");
        expect(message).toContain("tools question list --all-sessions");
    });

    // Regression test: PR #457 review — outside a harness and without --session the list already
    // covers every session, yet the empty message said "this session" and suggested widening it.
    it("does not suggest --all-sessions when the search already covered every session", () => {
        const message = noDecisionsMessage(undefined);

        expect(message).not.toContain("this session");
        expect(message).not.toContain("--all-sessions");
    });
});
