import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hookStatusArgs, readHookStatus, readHookStatusAsync, worktreeGitDir } from "./hook-status";
import { admitWorktree, indexHash, readNarrowStatus } from "./narrow-status";
import type { StatusEntry } from "./porcelain";
import { TestRepo } from "./test-repo";

function shape(entries: readonly StatusEntry[]): string[] {
    return entries.map((entry) => `${entry.kind} ${entry.index}${entry.worktree} ${entry.path}`);
}

describe("hook status reads", () => {
    let repo: TestRepo;

    beforeAll(async () => {
        repo = await TestRepo.create({ prefix: "hook-status-" });
        writeFileSync(join(repo.dir, ".gitignore"), "ignored/\n");
        mkdirSync(join(repo.dir, "ignored"), { recursive: true });
        writeFileSync(join(repo.dir, "ignored", "kept.txt"), "kept\n");
        await repo.commitMany({
            files: { "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n", "touch.txt": "t\n" },
            message: "base",
        });
        await repo.git(["add", "-f", ".gitignore", "ignored/kept.txt"]);
        await repo.git(["commit", "-m", "ignored folder"]);
    });

    afterAll(() => {
        repo.cleanup();
    });

    it("builds one argument list with pathspecs after --", () => {
        expect(hookStatusArgs({ trackedOnly: true, pathspecs: ["x"] })).toEqual([
            "-c",
            "core.preloadIndex=false",
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--no-renames",
            "--no-ahead-behind",
            "--untracked-files=no",
            "--",
            "x",
        ]);
    });

    it("finds the admin folder without git", () => {
        expect(worktreeGitDir(repo.dir)).toBe(join(repo.dir, ".git"));
        expect(worktreeGitDir(join(repo.dir, "ignored"))).toBeNull();
    });

    it("a narrow read equals the full status, and admission refuses a staged file", async () => {
        const gitDir = worktreeGitDir(repo.dir) ?? "";
        const clean = admitWorktree(repo.dir, { head: await repo.sha(), gitDir });
        expect(clean.admission?.admitted).toBe(true);
        expect(clean.admission?.indexHash).toBe(indexHash(gitDir) ?? "missing");

        appendFileSync(join(repo.dir, "a.txt"), "edit\n");
        unlinkSync(join(repo.dir, "b.txt"));
        writeFileSync(join(repo.dir, "new.txt"), "new\n");
        mkdirSync(join(repo.dir, "fresh", "deep"), { recursive: true });
        writeFileSync(join(repo.dir, "fresh", "deep", "x.txt"), "x\n");
        utimesSync(join(repo.dir, "touch.txt"), new Date(), new Date(Date.now() + 5_000));
        appendFileSync(join(repo.dir, "ignored", "kept.txt"), "more\n");

        const narrow = readNarrowStatus(repo.dir, { need: "all" });
        const full = readHookStatus(repo.dir);
        expect(narrow.ok && full.ok).toBe(true);

        if (!narrow.ok || !full.ok) {
            return;
        }

        expect(shape(narrow.value)).toEqual(shape(full.value.entries));
        expect(shape(narrow.value)).toContain("changed .M ignored/kept.txt");
        expect(shape(narrow.value)).toContain("untracked ?? fresh/");
        expect(narrow.cost.spawns).toBe(2);
        expect(full.cost.cpuMs).toBeGreaterThan(0);

        const deletions = readNarrowStatus(repo.dir, { need: "deletions" });
        expect(deletions.ok && shape(deletions.value)).toEqual(["changed .D b.txt"]);

        const asyncFull = await readHookStatusAsync(repo.dir, { pathspecs: ["a.txt"] });
        expect(asyncFull.ok && shape(asyncFull.value.entries)).toEqual(["changed .M a.txt"]);

        await repo.git(["add", "a.txt"]);
        const staged = admitWorktree(repo.dir, { head: await repo.sha(), gitDir });
        expect(staged.admission?.admitted).toBe(false);
        expect(staged.admission?.refusal).toBe("staged");
        expect(staged.status.ok).toBe(true);
    });

    it("a failed git is ok: false, never an empty answer", async () => {
        const missing = join(repo.root, "no-such-folder");
        const sync = readHookStatus(missing);
        expect(sync.ok).toBe(false);
        expect(sync.ok ? "" : sync.reason).toBe("exit");
        expect(readNarrowStatus(missing, { need: "all" }).ok).toBe(false);
        expect((await readHookStatusAsync(missing)).ok).toBe(false);
    });
});
