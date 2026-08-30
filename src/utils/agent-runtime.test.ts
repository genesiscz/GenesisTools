import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentRuntimeContext, gitCommonRoot } from "./agent-runtime";

function git(args: string[], cwd: string): void {
    const r = Bun.spawnSync(["git", "-c", "user.email=t@t.t", "-c", "user.name=t", ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
    });
    if (r.exitCode !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
    }
}

/** A main checkout with one linked worktree, so repoRoot/worktree claims are real. */
function makeRepo(): { main: string; worktree: string; deep: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-runtime-")));
    const main = join(root, "MainRepo");
    mkdirSync(main);
    git(["init", "-q", "-b", "main"], main);
    Bun.write(join(main, "README.md"), "x");
    git(["add", "-A"], main);
    git(["commit", "-qm", "init"], main);

    const deep = join(main, "src", "deep");
    mkdirSync(deep, { recursive: true });

    const worktree = join(root, "wt");
    git(["worktree", "add", "-q", "-b", "feat/x", worktree], main);
    return { main, worktree, deep };
}

describe("getAgentRuntimeContext", () => {
    it("detects claude-code from CLAUDE_CODE_SESSION_ID + reads git/project", () => {
        const ctx = getAgentRuntimeContext({}, { CLAUDE_CODE_SESSION_ID: "sess-123", CLAUDECODE: "1" });
        expect(ctx.agent).toBe("claude-code");
        expect(ctx.sessionId).toBe("sess-123");
        expect(ctx.isInAgent).toBe(true);
        expect(typeof ctx.project).toBe("string");
        expect(ctx.project.length).toBeGreaterThan(0);
        expect(ctx.commitMessage === null || typeof ctx.commitMessage === "string").toBe(true);
    });

    it("honors explicit overrides over env", () => {
        const ctx = getAgentRuntimeContext(
            { sessionId: "override", project: "Foo" },
            { CLAUDE_CODE_SESSION_ID: "env" }
        );
        expect(ctx.sessionId).toBe("override");
        expect(ctx.project).toBe("Foo");
    });

    it("agent=unknown when no agent env present", () => {
        const ctx = getAgentRuntimeContext({}, {});
        expect(ctx.agent).toBe("unknown");
        expect(ctx.sessionId).toBeNull();
    });

    it("detects codex from CODEX_CI and reads CODEX_THREAD_ID as sessionId", () => {
        const ctx = getAgentRuntimeContext({}, { CODEX_CI: "1", CODEX_THREAD_ID: "thr-42" });
        expect(ctx.agent).toBe("codex");
        expect(ctx.sessionId).toBe("thr-42");
        expect(ctx.isInAgent).toBe(true);
    });

    it("codex detected via CODEX_THREAD_ID even if CODEX_CI absent", () => {
        const ctx = getAgentRuntimeContext({}, { CODEX_THREAD_ID: "thr-9" });
        expect(ctx.agent).toBe("codex");
        expect(ctx.sessionId).toBe("thr-9");
    });

    it("detects grok from GROK_SESSION_ID", () => {
        const ctx = getAgentRuntimeContext({}, { GROK_SESSION_ID: "01a048de-25a9-7052-bbb8-46f8ae503f43" });
        expect(ctx.agent).toBe("grok");
        expect(ctx.sessionId).toBe("01a048de-25a9-7052-bbb8-46f8ae503f43");
        expect(ctx.isInAgent).toBe(true);
    });

    it("the inherited outer host wins when two are present", () => {
        // grok launched from a Claude Code shell inherits CLAUDE_CODE_SESSION_ID.
        const ctx = getAgentRuntimeContext({}, { CLAUDE_CODE_SESSION_ID: "sess-1", GROK_SESSION_ID: "grok-1" });
        expect(ctx.agent).toBe("claude-code");
        expect(ctx.sessionId).toBe("sess-1");
    });
});

describe("getAgentRuntimeContext — git identity", () => {
    it("reports a linked worktree against the main checkout", () => {
        const { main, worktree } = makeRepo();
        const ctx = getAgentRuntimeContext({ cwd: worktree }, {});
        expect(ctx.isWorktree).toBe(true);
        expect(ctx.worktreePath).toBe(worktree);
        expect(ctx.repoRoot).toBe(main);
        expect(ctx.project).toBe("MainRepo");
        expect(ctx.branch).toBe("feat/x");
    });

    it("names the project after the repo, not the subdirectory the session sits in", () => {
        const { main, deep } = makeRepo();
        const ctx = getAgentRuntimeContext({ cwd: deep }, {});
        expect(ctx.isWorktree).toBe(false);
        expect(ctx.worktreePath).toBeNull();
        expect(ctx.repoRoot).toBe(main);
        expect(ctx.project).toBe("MainRepo");
        expect(ctx.branch).toBe("main");
    });

    it("falls back to the directory itself outside any repo", () => {
        const outside = realpathSync(mkdtempSync(join(tmpdir(), "no-repo-")));
        const ctx = getAgentRuntimeContext({ cwd: outside }, {});
        expect(ctx.isWorktree).toBe(false);
        expect(ctx.repoRoot).toBe(outside);
        expect(ctx.branch).toBeNull();
    });
});

describe("gitCommonRoot", () => {
    it("gives one repo ONE identity, reached directly or through a symlink", () => {
        // PR #343 review t1 round 13. `resolveAncestorCwd` canonicalises its
        // paths on purpose — the kernel reports /private/tmp where process.cwd()
        // keeps /tmp — so a lexically-resolved common dir compared against a
        // canonical one made the same repository look like two, which rejected
        // the live ancestor cwd and reinstated the stale-cwd bug.
        const { main } = makeRepo();
        const linkDir = realpathSync(mkdtempSync(join(tmpdir(), "agent-runtime-link-")));
        const link = join(linkDir, "AliasRepo");
        symlinkSync(main, link);

        const direct = gitCommonRoot(main);
        const viaLink = gitCommonRoot(link);

        expect(direct).toBeTruthy();
        expect(viaLink).toBe(direct);
    });

    it("a genuinely different repo still gets a different identity", () => {
        // The negative control: canonicalising must not collapse two repos into
        // one, which would let an unrelated ancestor cwd be adopted.
        const a = makeRepo();
        const b = makeRepo();

        expect(gitCommonRoot(a.main)).not.toBe(gitCommonRoot(b.main));
    });

    it("a linked worktree shares the main checkout's identity", () => {
        // The property the comparison exists for.
        const { main, worktree } = makeRepo();

        expect(gitCommonRoot(worktree)).toBe(gitCommonRoot(main));
    });

    it("is null outside any repository", () => {
        const outside = realpathSync(mkdtempSync(join(tmpdir(), "no-repo-")));

        expect(gitCommonRoot(outside)).toBeNull();
    });
});
