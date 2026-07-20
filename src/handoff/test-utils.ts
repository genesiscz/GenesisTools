import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HandoffDeps } from "./executor";
import type { HandoffEventBy } from "./types";

export function byFor(sessionId: string | null, sessionName: string | null = null): HandoffEventBy {
    return {
        sessionId,
        sessionTitle: sessionName,
        agent: sessionId === null ? "unknown" : "claude-code",
        aiAgent: null,
        branch: "test-branch",
        cwd: "/tmp/test",
        repoRoot: "/tmp/test",
        project: "TestProj",
        commitSha: null,
        isWorktree: false,
    };
}

export interface TestEnv {
    base: string;
    dbPath: string;
    depsFor: (by: HandoffEventBy) => HandoffDeps;
}

export function freshEnv(): TestEnv {
    const dir = mkdtempSync(join(tmpdir(), "handoff-test-"));
    const base = join(dir, "log");
    const dbPath = join(dir, "qa.db");
    return { base, dbPath, depsFor: (by) => ({ base, dbPath, by }) };
}
