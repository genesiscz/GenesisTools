import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { TestRepo } from "@genesiscz/utils/git/test-repo";

const SCRIPT = join(import.meta.dir, "recommit-plan-check.ts");

interface RunResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

function run(repo: TestRepo, args: string[]): RunResult {
    const proc = Bun.spawnSync([process.execPath, SCRIPT, ...args], { cwd: repo.dir, stdout: "pipe", stderr: "pipe" });
    return { exitCode: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

let repo: TestRepo;
let base: string;

/**
 * The branch renames src/a.ts to src/b.ts, edits src/keep.ts and adds src/new.ts. With rename
 * detection on, `git diff --name-only` hides src/a.ts, which is the delete half of the move.
 */
beforeEach(async () => {
    repo = await TestRepo.create();
    await repo.commitMany({ files: { "src/a.ts": "export const a = 1;\n", "src/keep.ts": "keep\n" }, message: "app" });
    base = await repo.sha();
    await repo.checkout("feat/move", { create: true });
    await repo.git(["mv", "src/a.ts", "src/b.ts"]);
    await repo.git(["commit", "-q", "-m", "move a to b"], { epoch: repo.tick() });
    await repo.commit({ file: "src/keep.ts", content: "keep more\n", message: "edit keep" });
    await repo.commit({ file: "src/new.ts", content: "new\n", message: "add new" });
});

afterEach(() => {
    repo.cleanup();
});

function plan(text: string): string {
    const path = join(repo.root, "plan.txt");
    writeFileSync(path, text);
    return path;
}

describe("recommit-plan-check", () => {
    test("--list names the old path of a renamed file", () => {
        const res = run(repo, ["--base", base, "--list"]);

        expect(res.exitCode).toBe(0);
        expect(res.stdout.split("\n").filter(Boolean)).toEqual(["src/a.ts", "src/b.ts", "src/keep.ts", "src/new.ts"]);
    });

    test("a plan that misses the delete half fails before any commit exists", () => {
        const file = plan(
            "COMMIT 1: move a to b\nFILES:\nsrc/b.ts\nCOMMIT 2: keep and new\nFILES:\nsrc/keep.ts\nsrc/new.ts\n"
        );
        const res = run(repo, ["--base", base, "--plan", file]);

        expect(res.exitCode).toBe(1);
        expect(res.stderr).toContain("missing: src/a.ts");
        expect(res.stderr).toContain("tree");
    });

    test("a complete plan passes with tree identity", () => {
        const file = plan(
            "COMMIT 1: move a to b\nFILES:\n- src/a.ts\n- src/b.ts\nCOMMIT 2: keep and new\nFILES:\n  src/keep.ts\n  src/new.ts\n"
        );
        const res = run(repo, ["--base", base, "--plan", file]);

        expect(res.stderr).toBe("");
        expect(res.exitCode).toBe(0);
        expect(res.stdout).toContain("2 groups, 4 paths, tree identity OK");
    });

    test("a plan naming a path the branch never changed is rejected as extra", () => {
        const file = plan(
            "COMMIT 1: move a to b\nFILES:\nsrc/a.ts\nsrc/b.ts\nsrc/README.md\nCOMMIT 2: keep and new\nFILES:\nsrc/keep.ts\nsrc/new.ts\n"
        );
        const res = run(repo, ["--base", base, "--plan", file]);

        expect(res.exitCode).toBe(1);
        expect(res.stderr).toContain("extra: src/README.md (unchanged between base and head)");
        expect(res.stderr).not.toContain("missing:");
    });

    test("a path claimed by two groups and a group that changes nothing are both reported", () => {
        const file = plan(
            "COMMIT 1: move a to b\nFILES:\nsrc/a.ts\nsrc/b.ts\nsrc/keep.ts\nCOMMIT 2: keep again\nFILES:\nsrc/keep.ts\nCOMMIT 3: new\nFILES:\nsrc/new.ts\n"
        );
        const res = run(repo, ["--base", base, "--plan", file]);

        expect(res.exitCode).toBe(1);
        expect(res.stderr).toContain("duplicate: src/keep.ts");
        expect(res.stderr).toContain("group 2 changes nothing");
    });
});
