import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExecCallOptions, Executor } from "@genesiscz/utils/cli/executor";
import { TestRepo } from "./test-repo";
import { backupWorktree, planWorktreeBackup } from "./worktree-backup";

/**
 * One repository for the whole file: a branch worktree with every kind of dirt, a detached worktree with a commit no
 * branch holds, a small worktree for the refusals, and a worktree whose merge holds a change no patch has. Each test reads what an earlier setup left, so the file stays
 * at a few dozen git processes.
 */
describe("worktree backup", () => {
    let repo: TestRepo;
    let backupRoot: string;
    let dirty: string;
    let detached: string;
    let spare: string;
    let merged: string;
    const now = new Date(2026, 10, 9, 12, 0);
    /** Whole seconds, so the mtime a file gets back reads exactly as before. */
    const draftTime = new Date(2026, 0, 1, 0, 0, 0);

    beforeAll(async () => {
        repo = await TestRepo.create({ prefix: "gt-wt-backup-" });
        await repo.commit({ file: ".gitignore", content: ".env.local\nnode_modules/\n", message: "ignore" });
        await repo.addOrigin();
        backupRoot = join(repo.root, "backups");

        await repo.branch("feat");
        dirty = await repo.worktreeAdd({ name: "dirty", ref: "feat" });
        await repo.commit({ file: "README.md", content: "seed\nfeature\n", message: "feature readme", cwd: dirty });
        await repo.commit({ file: "src/feature.txt", content: "one\n", message: "feature file", cwd: dirty });
        repo.write({ file: "README.md", content: "seed\nfeature\nwork in progress\n", cwd: dirty });
        repo.write({ file: "staged.txt", content: "staged\n", cwd: dirty });
        await repo.git(["add", "staged.txt"], { cwd: dirty });
        // Staged, then changed back in the working copy: only the index holds this version.
        repo.write({ file: "src/feature.txt", content: "one\nstaged only\n", cwd: dirty });
        await repo.git(["add", "src/feature.txt"], { cwd: dirty });
        repo.write({ file: "src/feature.txt", content: "one\n", cwd: dirty });
        // A split index names a sharedindex.<hash> file beside it: the staged proof must still read it.
        await repo.git(["update-index", "--split-index"], { cwd: dirty });
        repo.write({ file: "notes.txt", content: "untracked\n", cwd: dirty });
        repo.write({ file: ".env.local", content: "TOKEN=fixture\n", cwd: dirty });
        repo.write({ file: "node_modules/x/index.js", content: "module.exports = 1;\n", cwd: dirty });

        detached = await repo.worktreeAdd({ name: "detached", ref: "master", detach: true });
        await repo.commit({ file: "lost.txt", content: "on no branch\n", message: "lost commit", cwd: detached });

        await repo.branch("spare");
        spare = await repo.worktreeAdd({ name: "spare", ref: "spare" });
        repo.write({ file: "draft.txt", content: "draft\n", cwd: spare });
        utimesSync(join(spare, "draft.txt"), draftTime, draftTime);
        // Sorts first in `ls-files -z`, where a trimmed output would lose the space.
        repo.write({ file: " lead.txt", content: "leading space\n", cwd: spare });

        await repo.branch("merged");
        merged = await repo.worktreeAdd({ name: "merged", ref: "merged" });
        await repo.commit({ file: "ours.txt", content: "ours\n", message: "ours", cwd: merged });
        await repo.git(["checkout", "-q", "-b", "side", "HEAD~1"], { cwd: merged });
        await repo.commit({ file: "theirs.txt", content: "theirs\n", message: "theirs", cwd: merged });
        await repo.git(["checkout", "-q", "merged"], { cwd: merged });
        await repo.git(["merge", "-q", "--no-ff", "--no-commit", "side"], { cwd: merged });
        repo.write({ file: "resolution.txt", content: "only in the merge\n", cwd: merged });
        await repo.git(["add", "resolution.txt"], { cwd: merged });
        await repo.git(["commit", "-q", "-m", "merge side"], { cwd: merged });
    });

    afterAll(() => {
        repo.cleanup();
    });

    it("plans without writing: not even the index changes", async () => {
        const gitdir = join(repo.dir, ".git", "worktrees", "dirty");
        const indexBefore = readFileSync(join(gitdir, "index"));
        const plan = await planWorktreeBackup({ path: dirty });

        expect(readFileSync(join(gitdir, "index")).equals(indexBefore)).toBe(true);
        expect(existsSync(backupRoot)).toBe(false);
        expect(plan.branch).toBe("refs/heads/feat");
        expect(plan.base?.ref).toBe("refs/remotes/origin/master");
        expect(plan.commits.map((commit) => commit.subject)).toEqual(["feature readme", "feature file"]);
        expect(plan.unreachable).toBe(0);
        expect(plan.changed.sort()).toEqual(["README.md", "staged.txt"]);
        expect(plan.staged.sort()).toEqual(["src/feature.txt", "staged.txt"]);
        expect(plan.untracked).toEqual(["notes.txt"]);
        expect(plan.ignored).toEqual([".env.local"]);
        expect(plan.blockers).toEqual([]);
    });

    it("backs up a dirty branch worktree, proves it, and removes it while the branch stays", async () => {
        const result = await backupWorktree({
            path: dirty,
            remove: true,
            note: "fixture feature work",
            backupRoot,
            now,
        });

        expect(result.refusal).toBeNull();
        expect(result.proof).toEqual({
            uncommitted: "ok",
            staged: "ok",
            commits: "ok",
            treeMatches: true,
            copies: "ok",
        });
        expect(result.ref).toBeNull();
        expect(result.folder).toBe(join(backupRoot, "2026-11-09-repo-dirty"));

        const folder = result.folder ?? "";
        const short = result.plan.head.slice(0, 10);
        expect(statSync(folder).mode & 0o777).toBe(0o700);
        expect(readdirSync(folder).sort()).toEqual(
            [
                "README.md",
                "backup.json",
                "commits",
                "ignored",
                `staged-on-${short}.patch`,
                `uncommitted-on-${short}.patch`,
                "untracked",
            ].sort()
        );
        expect(readFileSync(join(folder, `staged-on-${short}.patch`), "utf8")).toContain("+staged only");
        expect(readdirSync(join(folder, "commits"))).toHaveLength(2);
        expect(readFileSync(join(folder, "untracked", "notes.txt"), "utf8")).toBe("untracked\n");
        expect(readFileSync(join(folder, "ignored", ".env.local"), "utf8")).toBe("TOKEN=fixture\n");
        expect(existsSync(join(folder, "ignored", "node_modules"))).toBe(false);

        const readme = readFileSync(join(folder, "README.md"), "utf8");
        expect(readme).toContain("fixture feature work");
        expect(readme).toContain(`worktree add ${dirty} feat`);
        expect(readme).toContain(`apply ${join(folder, `uncommitted-on-${short}.patch`)}`);
        expect(readme).toContain(`apply --cached ${join(folder, `staged-on-${short}.patch`)}`);

        expect(result.removed).toBe(true);
        expect(existsSync(dirty)).toBe(false);
        expect(await repo.git(["worktree", "list", "--porcelain"])).not.toContain(dirty);
        expect(await repo.git(["rev-parse", "--verify", "refs/heads/feat"])).toBe(result.plan.head);
    });

    it("keeps a detached worktree's lost commit alive under a safety ref", async () => {
        const result = await backupWorktree({ path: detached, backupRoot, now });

        expect(result.refusal).toBeNull();
        expect(result.plan.branch).toBeNull();
        expect(result.plan.unreachable).toBe(1);
        expect(result.ref).toBe("refs/backups/worktrees/2026-11-09-repo-detached");
        expect(await repo.git(["rev-parse", "--verify", result.ref ?? ""])).toBe(result.plan.head);
        expect(result.proof).toEqual({
            uncommitted: "none",
            staged: "none",
            commits: "ok",
            treeMatches: true,
            copies: "none",
        });
        expect(result.removed).toBe(false);
        expect(existsSync(detached)).toBe(true);
    });

    it("refuses a removal when a process works inside the worktree", async () => {
        const sleeper = Bun.spawn(["sleep", "30"], {
            cwd: detached,
            env: process.env,
            stdio: ["ignore", "ignore", "ignore"],
        });

        try {
            const plan = await planWorktreeBackup({ path: detached, remove: true });
            expect(plan.blockers.some((blocker) => blocker.startsWith(`Process ${sleeper.pid} `))).toBe(true);
        } finally {
            sleeper.kill();
            await sleeper.exited;
        }
    });

    it("keeps the worktree when a file is rewritten during the backup with the same size and mtime", async () => {
        const result = await backupWorktree({
            path: spare,
            remove: true,
            backupRoot,
            now,
            afterBackup: () => {
                const draft = join(spare, "draft.txt");
                writeFileSync(draft, "DRAFT\n");
                utimesSync(draft, draftTime, draftTime);
            },
        });

        expect(result.plan.untracked).toEqual([" lead.txt", "draft.txt"]);
        expect(result.proof.copies).toBe("ok");
        expect(result.refusal).toContain("changed during the backup");
        expect(result.removed).toBe(false);
        expect(existsSync(spare)).toBe(true);
        expect(readFileSync(join(result.folder ?? "", "untracked", "draft.txt"), "utf8")).toBe("draft\n");
        expect(readFileSync(join(result.folder ?? "", "untracked", " lead.txt"), "utf8")).toBe("leading space\n");
        expect(readFileSync(join(result.folder ?? "", "README.md"), "utf8")).toContain("changed during the backup");
    });

    it("keeps the worktree and the backup when the proof fails, and never reaches git worktree remove", async () => {
        const exec = Executor.prototype.exec;
        const spy = spyOn(Executor.prototype, "exec").mockImplementation(function (
            this: Executor,
            args: string[],
            options?: ExecCallOptions
        ) {
            if (args.includes("worktree") && args.includes("remove")) {
                throw new Error("git worktree remove ran after a failed proof");
            }

            return exec.call(this, args, options);
        });

        try {
            const result = await backupWorktree({ path: merged, remove: true, backupRoot, now });

            expect(result.plan.merges).toBe(1);
            expect(result.proof.treeMatches).toBe(false);
            expect(result.proof.commits).toContain("merge commit(s) are not in the patches");
            expect(result.refusal).toStartWith("The proof failed, so nothing was removed");
            expect(result.removed).toBe(false);
            // The spy saw the backup's git calls, so its silence about the removal is not a disconnected spy.
            expect(spy.mock.calls.length).toBeGreaterThan(0);
            expect(spy.mock.calls.some(([args]) => args.includes("worktree") && args.includes("remove"))).toBe(false);
            expect(existsSync(merged)).toBe(true);
            expect(readdirSync(join(result.folder ?? "", "commits"))).toHaveLength(2);
            expect(readFileSync(join(result.folder ?? "", "README.md"), "utf8")).toContain("The proof failed");
        } finally {
            spy.mockRestore();
        }
    });

    it("refuses to remove a locked worktree before writing anything", async () => {
        await repo.git(["worktree", "lock", "--reason", "busy", spare]);
        const result = await backupWorktree({ path: spare, remove: true, backupRoot, now });

        expect(result.plan.locked).toBe("busy");
        expect(result.refusal).toContain("locked (busy)");
        expect(result.folder).toBeNull();
        expect(existsSync(spare)).toBe(true);
    });

    it("throws for a main checkout and for a folder outside git", async () => {
        await expect(planWorktreeBackup({ path: repo.dir })).rejects.toThrow("main checkout");
        await expect(planWorktreeBackup({ path: backupRoot })).rejects.toThrow("no .git entry");
    });
});
