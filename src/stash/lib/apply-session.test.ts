import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplySession } from "./apply-session";

let stateDir: string;
let projectDir: string;

beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "stash-apply-session-state-"));
    projectDir = await mkdtemp(join(tmpdir(), "stash-apply-session-project-"));
});

afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
});

const BASE_ARGS = {
    stashId: "abc123def456",
    stashName: "my-stash",
    versionId: "v-uuid-1",
    version: 1,
    projectPath: "/fake/project",
    projectHash: "deadbeef".repeat(8),
    conflictedFiles: ["src/a.ts", "src/b.ts"],
};

describe("ApplySession", () => {
    test("start + persist + load round-trip preserves all fields", async () => {
        const session = await ApplySession.start({ ...BASE_ARGS, stateDir });
        const snap = session.snapshot();
        expect(snap.stashId).toBe(BASE_ARGS.stashId);
        expect(snap.stashName).toBe(BASE_ARGS.stashName);
        expect(snap.versionId).toBe(BASE_ARGS.versionId);
        expect(snap.version).toBe(1);
        expect(snap.projectPath).toBe(BASE_ARGS.projectPath);
        expect(snap.projectHash).toBe(BASE_ARGS.projectHash);
        expect(snap.conflictedFiles).toEqual(BASE_ARGS.conflictedFiles);
        expect(snap.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

        const loaded = await ApplySession.load({
            stashId: BASE_ARGS.stashId,
            projectHash: BASE_ARGS.projectHash,
            stateDir,
        });
        expect(loaded).not.toBeNull();
        const loadedSnap = loaded!.snapshot();
        expect(loadedSnap.stashId).toBe(BASE_ARGS.stashId);
        expect(loadedSnap.conflictedFiles).toEqual(BASE_ARGS.conflictedFiles);
        expect(loadedSnap.startedAt).toBe(snap.startedAt);
    });

    test("load returns null when no state file exists", async () => {
        const result = await ApplySession.load({
            stashId: "nonexistent",
            projectHash: BASE_ARGS.projectHash,
            stateDir,
        });
        expect(result).toBeNull();
    });

    test("remainingConflicts returns files with conflict markers", async () => {
        const conflicted = join(projectDir, "a.ts");
        const clean = join(projectDir, "b.ts");

        await writeFile(conflicted, "fn();\n<<<<<<< HEAD\nlocal();\n=======\nstashed();\n>>>>>>> stash\n");
        await writeFile(clean, "fn();\nstashed();\n");

        const session = await ApplySession.start({
            ...BASE_ARGS,
            projectPath: projectDir,
            conflictedFiles: ["a.ts", "b.ts"],
            stateDir,
        });

        const remaining = await session.remainingConflicts();
        expect(remaining).toContain("a.ts");
        expect(remaining).not.toContain("b.ts");
    });

    test("remainingConflicts treats unreadable files as resolved", async () => {
        const session = await ApplySession.start({
            ...BASE_ARGS,
            projectPath: projectDir,
            conflictedFiles: ["missing.ts"],
            stateDir,
        });

        const remaining = await session.remainingConflicts();
        expect(remaining).toHaveLength(0);
    });

    test("complete() deletes the state file", async () => {
        const session = await ApplySession.start({ ...BASE_ARGS, stateDir });
        await session.complete();

        const loaded = await ApplySession.load({
            stashId: BASE_ARGS.stashId,
            projectHash: BASE_ARGS.projectHash,
            stateDir,
        });
        expect(loaded).toBeNull();
    });

    test("abort() deletes the state file", async () => {
        const session = await ApplySession.start({ ...BASE_ARGS, stateDir });

        // Verify it exists first
        const loaded = await ApplySession.load({
            stashId: BASE_ARGS.stashId,
            projectHash: BASE_ARGS.projectHash,
            stateDir,
        });
        expect(loaded).not.toBeNull();

        await session.abort();
        const afterAbort = await ApplySession.load({
            stashId: BASE_ARGS.stashId,
            projectHash: BASE_ARGS.projectHash,
            stateDir,
        });
        expect(afterAbort).toBeNull();
    });

    test("complete() and abort() are idempotent on missing state file", async () => {
        const session = await ApplySession.start({ ...BASE_ARGS, stateDir });
        await session.complete();
        // Second call on already-deleted file should not throw
        await expect(session.complete()).resolves.toBeUndefined();
        await expect(session.abort()).resolves.toBeUndefined();
    });
});
