import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { applicationRestorePatch, captureApplySnapshot, confinedPath, restoreApplySnapshot } from "./apply-recovery";
import { ApplySession } from "./apply-session";
import { runGitIn } from "./patch";

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

test("confinedPath normalizes trailing separators and relative project roots", async () => {
    expect(await confinedPath(`${projectDir}/`, "a.ts")).toBe(join(projectDir, "a.ts"));
    expect(await confinedPath(relative(process.cwd(), projectDir), "a.ts")).toBe(join(projectDir, "a.ts"));
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

describe("apply recovery files", () => {
    test("session state is written 0600 inside a 0700 directory, whatever the umask", async () => {
        const previous = process.umask(0o022);
        try {
            const nested = join(stateDir, "state");
            await ApplySession.start({ ...BASE_ARGS, stateDir: nested });
            const file = join(nested, `${BASE_ARGS.projectHash}--apply--${BASE_ARGS.stashId}.json`);
            expect((await stat(file)).mode & 0o777).toBe(0o600);
            expect((await stat(nested)).mode & 0o777).toBe(0o700);
        } finally {
            process.umask(previous);
        }
    });

    test("restore brings back the saved mode exactly under a restrictive umask", async () => {
        await runGitIn(projectDir, ["init", "-q"]);
        const script = join(projectDir, "run.sh");
        await writeFile(script, "echo before\n");
        await chmod(script, 0o755);
        const before = await captureApplySnapshot({ root: projectDir, files: ["run.sh"] });
        await writeFile(script, "echo after\n");
        const after = await captureApplySnapshot({ root: projectDir, files: ["run.sh"] });

        const previous = process.umask(0o077);
        try {
            await restoreApplySnapshot({ root: projectDir, before, after });
        } finally {
            process.umask(previous);
        }
        expect(await readFile(script, "utf8")).toBe("echo before\n");
        expect((await stat(script)).mode & 0o777).toBe(0o755);
    });

    test("an applied session whose finalization failed can still be restored", async () => {
        await runGitIn(projectDir, ["init", "-q"]);
        await writeFile(join(projectDir, "a.ts"), "original\n");
        const session = await ApplySession.start({
            ...BASE_ARGS,
            projectPath: projectDir,
            conflictedFiles: [],
            stateDir,
            before: await captureApplySnapshot({ root: projectDir, files: ["a.ts"] }),
        });
        await writeFile(join(projectDir, "a.ts"), "applied\n");
        await session.captureResult([], "applied");

        await session.restore();
        expect(await readFile(join(projectDir, "a.ts"), "utf8")).toBe("original\n");
        expect(session.snapshot().outcome).toBe("applied");
    });
});

describe("applicationRestorePatch unsupported changes", () => {
    test("a mode-only change and a new empty file are reported, not silently dropped", async () => {
        await runGitIn(projectDir, ["init", "-q"]);
        await writeFile(join(projectDir, "run.sh"), "echo hi\n");
        await chmod(join(projectDir, "run.sh"), 0o644);
        const before = await captureApplySnapshot({ root: projectDir, files: ["run.sh", "empty.txt"] });
        await chmod(join(projectDir, "run.sh"), 0o755);
        await writeFile(join(projectDir, "empty.txt"), "");

        const { patch, unsupportedFiles } = await applicationRestorePatch({ root: projectDir, before });

        expect(unsupportedFiles.sort()).toEqual(["empty.txt", "run.sh"]);
        expect(patch).not.toContain("@@");
    });

    test("session files are replaced atomically and stay 0600", async () => {
        const session = await ApplySession.start({ ...BASE_ARGS, stateDir });
        await session.captureResult([], "conflict");
        const file = join(stateDir, `${BASE_ARGS.projectHash}--apply--${BASE_ARGS.stashId}.json`);

        expect((await stat(file)).mode & 0o777).toBe(0o600);
        expect((await readdir(stateDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });
});
