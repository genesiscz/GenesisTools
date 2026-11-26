import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { env } from "@genesiscz/utils/env";
import { TestRepo } from "@genesiscz/utils/git/test-repo";
import { captureContext, defaultSessionId, findProjectRoot, resolveSessionOption } from "../context";

describe("findProjectRoot", () => {
    it("finds .git directory walking up from a nested path", () => {
        const root = findProjectRoot(resolve(import.meta.dir, ".."));
        expect(root).not.toBeNull();
        // Works in both main repo and worktrees
        expect(existsSync(join(root!, ".git"))).toBe(true);
    });

    it("finds .git from the repo root itself", () => {
        const repoRoot = findProjectRoot(import.meta.dir);
        expect(repoRoot).not.toBeNull();
    });

    it("returns null for a path outside any git repo", () => {
        const result = findProjectRoot("/tmp");
        expect(result).toBeNull();
    });
});

describe("captureContext", () => {
    it("captures git info when inside a repo", async () => {
        const ctx = await captureContext();

        expect(ctx.cwd).toBe(process.cwd());
        expect(ctx.hostname).toBeTruthy();
        expect(ctx.createdAt).toBeTruthy();
        expect(ctx.updatedAt).toBeTruthy();
        expect(new Date(ctx.createdAt).toISOString()).toBe(ctx.createdAt);

        expect(ctx.git).toBeDefined();
        expect(ctx.git!.branch).toBeTruthy();
        expect(ctx.git!.commitSha).toMatch(/^[a-f0-9]{40}$/);
        expect(ctx.git!.commitMessage).toBeTruthy();
        expect(Array.isArray(ctx.git!.stagedFiles)).toBe(true);
        expect(Array.isArray(ctx.git!.unstagedFiles)).toBe(true);
        expect(Array.isArray(ctx.git!.untrackedFiles)).toBe(true);
    });

    it("uses explicit projectRoot when provided", async () => {
        const ctx = await captureContext({ projectRoot: process.cwd() });

        expect(ctx.projectRoot).toBe(process.cwd());
        expect(ctx.git).toBeDefined();
    });

    it("returns undefined git for a non-repo path", async () => {
        const ctx = await captureContext({ projectRoot: "/tmp" });

        expect(ctx.git).toBeUndefined();
        expect(ctx.projectRoot).toBe("/tmp");
        expect(ctx.cwd).toBe(process.cwd());
        expect(ctx.hostname).toBeTruthy();
    });

    it("captures remote URL when available", async () => {
        const ctx = await captureContext();

        if (ctx.git?.remote) {
            expect(ctx.git.remote).toMatch(/github\.com|gitlab|bitbucket|origin/);
        }
    });
});

describe("captureContext git fields", () => {
    let repo: TestRepo;

    beforeAll(async () => {
        repo = await TestRepo.create({ prefix: "todo-context-" });
        await repo.commitMany({
            files: { "docs/Guide.md": "guide\n", "src/app/Widget.tsx": "widget\n", "src/app/Old.tsx": "old\n" },
            message: "add the widget",
        });
        await repo.git(["remote", "add", "origin", "https://github.com/example/widget.git"]);
        // In porcelain order the first line is the unstaged edit: its leading space is what a trim ate.
        repo.write({ file: "docs/Guide.md", content: "guide v2\n" });
        repo.write({ file: "src/app/Widget.tsx", content: "widget v2\n" });
        await repo.git(["add", "src/app/Widget.tsx"]);
        await repo.git(["config", "status.renames", "true"]);
        await repo.git(["mv", "src/app/Old.tsx", "src/app/New.tsx"]);
        repo.write({ file: "notes/Příklad soubor.md", content: "x\n" });
    });

    afterAll(() => repo.cleanup());

    it("lists a file as staged only when its change is in the index, with its whole path", async () => {
        const git = (await captureContext({ projectRoot: repo.dir })).git;

        expect(git?.stagedFiles.toSorted()).toEqual(["src/app/New.tsx", "src/app/Widget.tsx"]);
    });

    it("lists a work-tree edit as unstaged, not staged, and does not cut its first character", async () => {
        const git = (await captureContext({ projectRoot: repo.dir })).git;

        expect(git?.unstagedFiles).toEqual(["docs/Guide.md"]);
        expect(git?.stagedFiles).not.toContain("ocs/Guide.md");
    });

    it("lists an untracked file by its real name", async () => {
        const git = (await captureContext({ projectRoot: repo.dir })).git;

        expect(git?.untrackedFiles).toEqual(["notes/Příklad soubor.md"]);
    });

    it("reads the branch, the commit, its subject and the origin", async () => {
        const git = (await captureContext({ projectRoot: repo.dir })).git;

        expect(git?.branch).toBe("master");
        expect(git?.commitSha).toBe(await repo.sha());
        expect(git?.commitMessage).toBe("add the widget");
        expect(git?.remote).toBe("https://github.com/example/widget.git");
    });

    it("names a detached HEAD `HEAD` and a repository with no commits by its branch", async () => {
        const detached = await TestRepo.create({ prefix: "todo-context-detached-" });
        const unborn = await TestRepo.create({ prefix: "todo-context-unborn-", seed: false });

        try {
            await detached.git(["checkout", "--detach"]);

            expect((await captureContext({ projectRoot: detached.dir })).git?.branch).toBe("HEAD");
            expect((await captureContext({ projectRoot: unborn.dir })).git).toMatchObject({
                branch: "master",
                commitSha: "",
                commitMessage: "",
            });
        } finally {
            detached.cleanup();
            unborn.cleanup();
        }
    });
});

describe("resolveSessionOption", () => {
    it("passes an explicit id through and leaves an omitted option alone", () => {
        expect(resolveSessionOption("abc123")).toBe("abc123");
        expect(resolveSessionOption(undefined)).toBeUndefined();
    });

    it("resolves 'current' from the host session", async () => {
        await env.testing.withOverrides({ CLAUDE_CODE_SESSION_ID: "sess-1", CLAUDECODE: "1" }, () => {
            expect(resolveSessionOption("current")).toBe("sess-1");
        });
    });

    it("throws when 'current' cannot resolve, instead of widening the query", async () => {
        // PR #343 review t31: returning undefined dropped the filter, so
        // `--session current` listed every todo in the project.
        await env.testing.withOverrides(
            {
                CLAUDE_CODE_SESSION_ID: undefined,
                CLAUDECODE: undefined,
                CODEX_THREAD_ID: undefined,
                CODEX_CI: undefined,
                GROK_SESSION_ID: undefined,
                COPILOT_AGENT_SESSION_ID: undefined,
            },
            () => {
                expect(() => resolveSessionOption("current")).toThrow(/No current agent session/);
                expect(defaultSessionId(undefined)).toBeUndefined();
            }
        );
    });
});
