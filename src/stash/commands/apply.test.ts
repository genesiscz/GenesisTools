import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGitIn } from "../lib/patch";
import { applyCommand } from "./apply";
import { saveCommand } from "./save";

let work: string;
let origStashRoot: string | undefined;
let origCwd: string;
let projectA: string;
let projectB: string;

beforeEach(async () => {
    origCwd = process.cwd();
    work = await mkdtemp(join(tmpdir(), "stash-apply-it-"));
    origStashRoot = process.env.GENESIS_TOOLS_STASH_ROOT;
    // Redirect the global stash store into the per-test tmpdir so parallel test files don't share state.
    process.env.GENESIS_TOOLS_STASH_ROOT = join(work, ".genesis-tools", "stash");
    projectA = join(work, "repo-a");
    projectB = join(work, "repo-b");
    for (const repo of [projectA, projectB]) {
        await runGitIn(work, ["init", repo.split("/").pop() ?? "", "--initial-branch=main"]);
        await runGitIn(repo, ["config", "user.email", "t@t"]);
        await runGitIn(repo, ["config", "user.name", "t"]);
        await writeFile(join(repo, "a.ts"), "fn();\n");
        await runGitIn(repo, ["add", "a.ts"]);
        await runGitIn(repo, ["commit", "-m", "init"]);
    }
});
afterEach(async () => {
    // Restore cwd BEFORE rm — see e2e.test.ts for the macOS posix_spawn-ENOENT-on-dead-cwd note.
    process.chdir(origCwd);
    if (origStashRoot !== undefined) {
        process.env.GENESIS_TOOLS_STASH_ROOT = origStashRoot;
    } else {
        delete process.env.GENESIS_TOOLS_STASH_ROOT;
    }
    await rm(work, { recursive: true, force: true });
});

describe.serial("apply integration", () => {
    test("save in A, apply to B, decorates with markers", async () => {
        process.chdir(projectA);
        await writeFile(join(projectA, "a.ts"), "fn();\ninserted();\n");
        await saveCommand({ name: "x", mode: "all", tags: [], description: undefined });

        process.chdir(projectB);
        await applyCommand({ name: "x", verboseMarkers: false });
        const result = await readFile(join(projectB, "a.ts"), "utf8");
        expect(result).toContain("#region @stash:x");
        expect(result).toContain("inserted();");
        expect(result).toContain("#endregion @stash:x");
    });
});
