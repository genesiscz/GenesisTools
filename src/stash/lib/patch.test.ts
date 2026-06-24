import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatch, diffWorkingTree, reversePatch, runGitIn } from "./patch";

let dir: string;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "stash-patch-"));
    await runGitIn(dir, ["init", "--initial-branch=main"]);
    await runGitIn(dir, ["config", "user.email", "t@t"]);
    await runGitIn(dir, ["config", "user.name", "t"]);
    await writeFile(join(dir, "a.ts"), "line1\nline2\nline3\n");
    await runGitIn(dir, ["add", "a.ts"]);
    await runGitIn(dir, ["commit", "-m", "init"]);
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe("patch", () => {
    test("diffWorkingTree captures uncommitted change as unified diff", async () => {
        await writeFile(join(dir, "a.ts"), "line1\nINSERTED\nline2\nline3\n");
        const diff = await diffWorkingTree({ repoDir: dir, mode: "all" });
        expect(diff).toContain("a.ts");
        expect(diff).toContain("+INSERTED");
    });

    test("applyPatch round-trips a diff", async () => {
        await writeFile(join(dir, "a.ts"), "line1\nINSERTED\nline2\nline3\n");
        const diff = await diffWorkingTree({ repoDir: dir, mode: "all" });
        await writeFile(join(dir, "a.ts"), "line1\nline2\nline3\n");
        await applyPatch({ repoDir: dir, patch: diff, threeWay: true });
        const after = await readFile(join(dir, "a.ts"), "utf8");
        expect(after).toBe("line1\nINSERTED\nline2\nline3\n");
    });

    test("reversePatch removes the change", async () => {
        await writeFile(join(dir, "a.ts"), "line1\nINSERTED\nline2\nline3\n");
        const diff = await diffWorkingTree({ repoDir: dir, mode: "all" });
        await runGitIn(dir, ["add", "a.ts"]);
        await runGitIn(dir, ["commit", "-m", "with insert"]);
        await reversePatch({ repoDir: dir, patch: diff, threeWay: true });
        const after = await readFile(join(dir, "a.ts"), "utf8");
        expect(after).toBe("line1\nline2\nline3\n");
    });
});
