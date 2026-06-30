import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGitIn } from "../lib/patch";
import { openStashDb } from "../lib/stash-db";
import { StashStorage } from "../lib/storage";
import type { ApplicationRow } from "../types";
import { applyCommand } from "./apply";
import { saveCommand } from "./save";

let work: string;
let origStashRoot: string | undefined;
let origCwd: string;
let projectA: string;
let projectB: string;

beforeEach(async () => {
    origCwd = process.cwd();
    work = await mkdtemp(join(tmpdir(), "stash-conflict-it-"));
    origStashRoot = process.env.GENESIS_TOOLS_STASH_ROOT;
    process.env.GENESIS_TOOLS_STASH_ROOT = join(work, ".genesis-tools", "stash");
    projectA = join(work, "repo-a");
    projectB = join(work, "repo-b");

    for (const repo of [projectA, projectB]) {
        await runGitIn(work, ["init", repo.split("/").pop() ?? "", "--initial-branch=main"]);
        await runGitIn(repo, ["config", "user.email", "t@t"]);
        await runGitIn(repo, ["config", "user.name", "t"]);
        // Both repos start from the same baseline
        await writeFile(join(repo, "a.ts"), "fn();\n");
        await runGitIn(repo, ["add", "a.ts"]);
        await runGitIn(repo, ["commit", "-m", "init"]);
    }
});

afterEach(async () => {
    process.chdir(origCwd);
    if (origStashRoot !== undefined) {
        process.env.GENESIS_TOOLS_STASH_ROOT = origStashRoot;
    } else {
        delete process.env.GENESIS_TOOLS_STASH_ROOT;
    }
    await rm(work, { recursive: true, force: true });
});

function stateFileExists(projectBPath: string, stashId: string): boolean {
    const storage = new StashStorage();
    const stateDir = storage.stateDir();
    // On macOS, mkdtemp uses /tmp which is a symlink to /private/tmp; git and process.cwd() return
    // the real (symlink-resolved) path. Resolve here so the hash matches what apply.ts computes.
    const realProjectPath = realpathSync(projectBPath);
    const projectHash = createHash("sha256").update(realProjectPath).digest("hex");
    const stateFile = join(stateDir, `${projectHash}--apply--${stashId}.json`);
    return existsSync(stateFile);
}

function getStashId(stashName: string): string {
    const storage = new StashStorage();
    const db = openStashDb(new Database(storage.dbPath()));
    const row = db.query<{ id: string }, [string]>("SELECT id FROM stashes WHERE name = ?").get(stashName);
    db.close();
    if (!row) {
        throw new Error(`stash "${stashName}" not found`);
    }
    return row.id;
}

function getApplicationsRow(stashName: string, projectPath: string): ApplicationRow | null {
    const storage = new StashStorage();
    const db = openStashDb(new Database(storage.dbPath()));
    const stash = db.query<{ id: string }, [string]>("SELECT id FROM stashes WHERE name = ?").get(stashName);
    if (!stash) {
        db.close();
        return null;
    }
    // Resolve symlinks so the path matches what apply.ts stores (from git rev-parse --show-toplevel).
    const realProjectPath = realpathSync(projectPath);
    const row = db
        .query<ApplicationRow, [string, string]>(
            "SELECT * FROM applications WHERE stash_id = ? AND project_path = ? AND state = 'active'"
        )
        .get(stash.id, realProjectPath);
    db.close();
    return row;
}

describe.serial("apply conflict state machine", () => {
    test("conflict: state file created, markers in file, applications row NOT inserted", async () => {
        // Save stash from projectA: adds 'inserted();' after 'fn();'
        process.chdir(projectA);
        await writeFile(join(projectA, "a.ts"), "fn();\ninserted();\n");
        await saveCommand({ name: "conflict-stash", mode: "all", tags: [], description: undefined });

        // In projectB: commit a diverging change to force a 3-way conflict
        await writeFile(join(projectB, "a.ts"), "fn();\nlocal_change();\n");
        await runGitIn(projectB, ["add", "a.ts"]);
        await runGitIn(projectB, ["commit", "-m", "local change"]);

        process.chdir(projectB);
        let _exitCode = 0;
        try {
            await applyCommand({ name: "conflict-stash", verboseMarkers: false, action: "start" });
        } catch {
            _exitCode = 1;
        }
        // process.exit(1) is called on conflict — we catch it via the mock below; see test note.
        // In bun test, process.exit throws an error in the test context.

        const content = await readFile(join(projectB, "a.ts"), "utf8");
        expect(content).toContain("<<<<<<<");

        const stashId = getStashId("conflict-stash");
        expect(stateFileExists(projectB, stashId)).toBe(true);

        const appRow = getApplicationsRow("conflict-stash", projectB);
        expect(appRow).toBeNull();
    });

    test("resume: after resolving conflicts, decorates markers and inserts application row", async () => {
        // Setup conflict
        process.chdir(projectA);
        await writeFile(join(projectA, "a.ts"), "fn();\ninserted();\n");
        await saveCommand({ name: "conflict-stash", mode: "all", tags: [], description: undefined });

        await writeFile(join(projectB, "a.ts"), "fn();\nlocal_change();\n");
        await runGitIn(projectB, ["add", "a.ts"]);
        await runGitIn(projectB, ["commit", "-m", "local change"]);

        process.chdir(projectB);
        // Trigger conflicted apply
        try {
            await applyCommand({ name: "conflict-stash", verboseMarkers: false, action: "start" });
        } catch {
            // expected process.exit
        }

        // Verify we're in conflict state
        const content = await readFile(join(projectB, "a.ts"), "utf8");
        expect(content).toContain("<<<<<<<");

        // Manually resolve: write a clean file with no conflict markers
        await writeFile(join(projectB, "a.ts"), "fn();\ninserted();\nlocal_change();\n");

        // Resume
        await applyCommand({ name: "conflict-stash", verboseMarkers: false, action: "resume" });

        const resolved = await readFile(join(projectB, "a.ts"), "utf8");
        expect(resolved).not.toContain("<<<<<<<");
        expect(resolved).toContain("#region @stash:conflict-stash");
        expect(resolved).toContain("#endregion @stash:conflict-stash");

        const appRow = getApplicationsRow("conflict-stash", projectB);
        expect(appRow).not.toBeNull();

        // State file should be deleted after successful resume
        const stashId = getStashId("conflict-stash");
        expect(stateFileExists(projectB, stashId)).toBe(false);
    });

    test("abort: restores conflicted file to HEAD content, deletes state file", async () => {
        // Setup conflict
        process.chdir(projectA);
        await writeFile(join(projectA, "a.ts"), "fn();\ninserted();\n");
        await saveCommand({ name: "conflict-stash", mode: "all", tags: [], description: undefined });

        await writeFile(join(projectB, "a.ts"), "fn();\nlocal_change();\n");
        await runGitIn(projectB, ["add", "a.ts"]);
        await runGitIn(projectB, ["commit", "-m", "local change"]);

        process.chdir(projectB);
        // Trigger conflicted apply
        try {
            await applyCommand({ name: "conflict-stash", verboseMarkers: false, action: "start" });
        } catch {
            // expected process.exit
        }

        // Verify conflict markers are present
        const withConflict = await readFile(join(projectB, "a.ts"), "utf8");
        expect(withConflict).toContain("<<<<<<<");

        // Abort
        await applyCommand({ name: "conflict-stash", verboseMarkers: false, action: "abort" });

        const restored = await readFile(join(projectB, "a.ts"), "utf8");
        expect(restored).not.toContain("<<<<<<<");
        expect(restored).toBe("fn();\nlocal_change();\n");

        const stashId = getStashId("conflict-stash");
        expect(stateFileExists(projectB, stashId)).toBe(false);

        // No application row should exist
        const appRow = getApplicationsRow("conflict-stash", projectB);
        expect(appRow).toBeNull();
    });

    test("resume with remaining conflicts exits non-zero without inserting row", async () => {
        process.chdir(projectA);
        await writeFile(join(projectA, "a.ts"), "fn();\ninserted();\n");
        await saveCommand({ name: "conflict-stash", mode: "all", tags: [], description: undefined });

        await writeFile(join(projectB, "a.ts"), "fn();\nlocal_change();\n");
        await runGitIn(projectB, ["add", "a.ts"]);
        await runGitIn(projectB, ["commit", "-m", "local change"]);

        process.chdir(projectB);
        try {
            await applyCommand({ name: "conflict-stash", verboseMarkers: false, action: "start" });
        } catch {
            // expected
        }

        // Do NOT resolve the conflict — call --resume with markers still present
        const content = await readFile(join(projectB, "a.ts"), "utf8");
        expect(content).toContain("<<<<<<<");

        let exitedWithError = false;
        try {
            await applyCommand({ name: "conflict-stash", verboseMarkers: false, action: "resume" });
        } catch {
            exitedWithError = true;
        }
        expect(exitedWithError).toBe(true);

        // Application row still not inserted
        const appRow = getApplicationsRow("conflict-stash", projectB);
        expect(appRow).toBeNull();
    });
});
