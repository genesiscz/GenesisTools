import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { captureContext, findProjectRoot } from "../context";

describe("findProjectRoot", () => {
    it("finds .git directory walking up from a nested path", () => {
        const root = findProjectRoot(resolve(import.meta.dir, ".."));
        expect(root).not.toBeNull();
        expect(root!.endsWith("GenesisTools")).toBe(true);
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
