import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCommand } from "../commands/apply";
import { saveCommand } from "../commands/save";
import { diffApplied } from "./diff-applied";
import { runGitIn } from "./patch";
import { detectProject } from "./projects";
import { openStashDb } from "./stash-db";
import { StashStorage } from "./storage";

let work: string;
let repo: string;
let origCwd: string;
let origStashRoot: string | undefined;

beforeEach(async () => {
    origCwd = process.cwd();
    work = await mkdtemp(join(tmpdir(), "diff-applied-test-"));
    origStashRoot = process.env.GENESIS_TOOLS_STASH_ROOT;
    process.env.GENESIS_TOOLS_STASH_ROOT = join(work, ".genesis-tools", "stash");

    repo = join(work, "repo");
    await runGitIn(work, ["init", "repo", "--initial-branch=main"]);
    await runGitIn(repo, ["config", "user.email", "t@t"]);
    await runGitIn(repo, ["config", "user.name", "t"]);
    await writeFile(join(repo, "a.ts"), "export const x = 1;\n");
    await runGitIn(repo, ["add", "a.ts"]);
    await runGitIn(repo, ["commit", "-qm", "init"]);
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

function openDb(): Database {
    const storage = new StashStorage();
    return openStashDb(new Database(storage.dbPath()));
}

describe.serial("diffApplied", () => {
    test("clean: no drift after apply with no edits → empty regions + exitCode 0", async () => {
        process.chdir(repo);
        await writeFile(join(repo, "a.ts"), "export const x = 1;\nconst log = () => console.log();\n");
        await saveCommand({ name: "x", mode: "all", tags: [], description: undefined });

        await runGitIn(repo, ["checkout", "a.ts"]);
        await applyCommand({ name: "x", verboseMarkers: false });

        const project = await detectProject(repo);
        const storage = new StashStorage();
        const db = openDb();
        const result = await diffApplied({ name: "x", projectRoot: project!.rootPath, db, storage });
        db.close();

        expect(result.regions).toEqual([]);
        expect(result.exitCode).toBe(0);
    });

    test("edited region appears as unified diff with file:hunk label, exitCode 1", async () => {
        process.chdir(repo);
        await writeFile(join(repo, "a.ts"), "export const x = 1;\nconst log = () => console.log();\n");
        await saveCommand({ name: "x", mode: "all", tags: [], description: undefined });

        await runGitIn(repo, ["checkout", "a.ts"]);
        await applyCommand({ name: "x", verboseMarkers: false });

        // Edit the applied region to introduce drift.
        const content = await readFile(join(repo, "a.ts"), "utf8");
        await writeFile(join(repo, "a.ts"), content.replace("console.log()", "console.warn()"));

        const project = await detectProject(repo);
        const storage = new StashStorage();
        const db = openDb();
        const result = await diffApplied({ name: "x", projectRoot: project!.rootPath, db, storage });
        db.close();

        expect(result.regions).toHaveLength(1);
        expect(result.regions[0]?.diff).toContain("--- a/");
        expect(result.regions[0]?.diff).toContain("+++ b/");
        expect(result.exitCode).toBe(1);
    });

    test("errors when stash is not applied in cwd", async () => {
        process.chdir(repo);
        await writeFile(join(repo, "a.ts"), "export const x = 1;\nconst log = () => console.log();\n");
        await saveCommand({ name: "never-applied", mode: "all", tags: [], description: undefined });

        const project = await detectProject(repo);
        const storage = new StashStorage();
        const db = openDb();
        await expect(
            diffApplied({ name: "never-applied", projectRoot: project!.rootPath, db, storage })
        ).rejects.toThrow(/not applied/);
        db.close();
    });
});
