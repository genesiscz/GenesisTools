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

/**
 * The CLI as a real process, awaited rather than through `Bun.spawnSync`. On the Linux CI runner
 * Bun 1.4.2's spawnSync can lose its child's exit inside a long-lived test worker (a garbage
 * collection during the wait; oven-sh/bun#34069), and the call then spins until the 20 s test
 * timeout: on 2026-11-02 that was one or two of these five cases in each of four PR runs, each
 * printing `killed 1 dangling process`, while a clean run spent 0.5 s on the whole file. An awaited
 * spawn is watched by the event loop and does not take that path.
 */
async function run(repo: TestRepo, args: string[]): Promise<RunResult> {
    const proc = Bun.spawn([process.execPath, SCRIPT, ...args], {
        env: process.env,
        cwd: repo.dir,
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { exitCode, stdout, stderr };
}

let repo: TestRepo;
let base: string;

/** The base sha, recorded by the one real build of the scenario below. */
let builtBase: string | null = null;

/**
 * The branch renames src/a.ts to src/b.ts, edits src/keep.ts and adds src/new.ts. With rename
 * detection on, `git diff --name-only` hides src/a.ts, which is the delete half of the move.
 *
 * Built once per file and copied for every case (`TestRepo.fromScenario`): the commits are
 * deterministic, so every copy carries the base sha the first build recorded.
 */
beforeEach(async () => {
    repo = await TestRepo.fromScenario("recommit-plan-check:rename-edit-add", async (r) => {
        await r.commitMany({ files: { "src/a.ts": "export const a = 1;\n", "src/keep.ts": "keep\n" }, message: "app" });
        builtBase = await r.sha();
        await r.checkout("feat/move", { create: true });
        await r.git(["mv", "src/a.ts", "src/b.ts"]);
        await r.git(["commit", "-q", "-m", "move a to b"], { epoch: r.tick() });
        await r.commit({ file: "src/keep.ts", content: "keep more\n", message: "edit keep" });
        await r.commit({ file: "src/new.ts", content: "new\n", message: "add new" });
    });

    if (builtBase === null) {
        throw new Error("the scenario was copied before its build recorded the base sha");
    }

    base = builtBase;
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
    test("--list names the old path of a renamed file", async () => {
        const res = await run(repo, ["--base", base, "--list"]);

        expect(res.exitCode).toBe(0);
        expect(res.stdout.split("\n").filter(Boolean)).toEqual(["src/a.ts", "src/b.ts", "src/keep.ts", "src/new.ts"]);
    });

    test("a plan that misses the delete half fails before any commit exists", async () => {
        const file = plan(
            "COMMIT 1: move a to b\nFILES:\nsrc/b.ts\nCOMMIT 2: keep and new\nFILES:\nsrc/keep.ts\nsrc/new.ts\n"
        );
        const res = await run(repo, ["--base", base, "--plan", file]);

        expect(res.exitCode).toBe(1);
        expect(res.stderr).toContain("missing: src/a.ts");
        expect(res.stderr).toContain("tree");
    });

    test("a complete plan passes with tree identity", async () => {
        const file = plan(
            "COMMIT 1: move a to b\nFILES:\n- src/a.ts\n- src/b.ts\nCOMMIT 2: keep and new\nFILES:\n  src/keep.ts\n  src/new.ts\n"
        );
        const res = await run(repo, ["--base", base, "--plan", file]);

        expect(res.stderr).toBe("");
        expect(res.exitCode).toBe(0);
        expect(res.stdout).toContain("2 groups, 4 paths, tree identity OK");
    });

    test("a plan naming a path the branch never changed is rejected as extra", async () => {
        const file = plan(
            "COMMIT 1: move a to b\nFILES:\nsrc/a.ts\nsrc/b.ts\nsrc/README.md\nCOMMIT 2: keep and new\nFILES:\nsrc/keep.ts\nsrc/new.ts\n"
        );
        const res = await run(repo, ["--base", base, "--plan", file]);

        expect(res.exitCode).toBe(1);
        expect(res.stderr).toContain("extra: src/README.md (unchanged between base and head)");
        expect(res.stderr).not.toContain("missing:");
    });

    test("a path claimed by two groups and a group that changes nothing are both reported", async () => {
        const file = plan(
            "COMMIT 1: move a to b\nFILES:\nsrc/a.ts\nsrc/b.ts\nsrc/keep.ts\nCOMMIT 2: keep again\nFILES:\nsrc/keep.ts\nCOMMIT 3: new\nFILES:\nsrc/new.ts\n"
        );
        const res = await run(repo, ["--base", base, "--plan", file]);

        expect(res.exitCode).toBe(1);
        expect(res.stderr).toContain("duplicate: src/keep.ts");
        expect(res.stderr).toContain("group 2 changes nothing");
    });
});
