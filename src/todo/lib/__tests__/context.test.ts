import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { env } from "@genesiscz/utils/env";
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
            },
            () => {
                expect(() => resolveSessionOption("current")).toThrow(/No current agent session/);
                expect(defaultSessionId(undefined)).toBeUndefined();
            }
        );
    });
});
