import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TestRepo } from "./test-repo";
import { backupWorktree, planWorktreeBackup } from "./worktree-backup";

/**
 * One repository for the whole file: a branch worktree with every kind of dirt, a detached worktree with a commit no
 * branch holds, and a small worktree for the refusals. Each test reads what an earlier setup left, so the file stays
 * at a few dozen git processes.
 */
describe("worktree backup", () => {
    let repo: TestRepo;
    let backupRoot: string;
    let dirty: string;
    let detached: string;
    let spare: string;
    const now = new Date(2026, 10, 9, 12, 0);

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
        repo.write({ file: "notes.txt", content: "untracked\n", cwd: dirty });
        repo.write({ file: ".env.local", content: "TOKEN=fixture\n", cwd: dirty });
        repo.write({ file: "node_modules/x/index.js", content: "module.exports = 1;\n", cwd: dirty });

        detached = await repo.worktreeAdd({ name: "detached", ref: "master", detach: true });
        await repo.commit({ file: "lost.txt", content: "on no branch\n", message: "lost commit", cwd: detached });

        await repo.branch("spare");
        spare = await repo.worktreeAdd({ name: "spare", ref: "spare" });
        repo.write({ file: "draft.txt", content: "draft\n", cwd: spare });
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
        expect(result.proof).toEqual({ uncommitted: "ok", commits: "ok", treeMatches: true });
        expect(result.ref).toBeNull();
        expect(result.folder).toBe(join(backupRoot, "2026-11-09-repo-dirty"));

        const folder = result.folder ?? "";
        const short = result.plan.head.slice(0, 10);
        expect(readdirSync(folder).sort()).toEqual(
            ["README.md", "backup.json", "commits", "ignored", `uncommitted-on-${short}.patch`, "untracked"].sort()
        );
        expect(readdirSync(join(folder, "commits"))).toHaveLength(2);
        expect(readFileSync(join(folder, "untracked", "notes.txt"), "utf8")).toBe("untracked\n");
        expect(readFileSync(join(folder, "ignored", ".env.local"), "utf8")).toBe("TOKEN=fixture\n");
        expect(existsSync(join(folder, "ignored", "node_modules"))).toBe(false);

        const readme = readFileSync(join(folder, "README.md"), "utf8");
        expect(readme).toContain("fixture feature work");
        expect(readme).toContain(`worktree add ${dirty} feat`);
        expect(readme).toContain(`apply ${join(folder, `uncommitted-on-${short}.patch`)}`);

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
        expect(result.proof).toEqual({ uncommitted: "none", commits: "ok", treeMatches: true });
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

    it("keeps the worktree and the backup when the worktree changes during the backup", async () => {
        const result = await backupWorktree({
            path: spare,
            remove: true,
            backupRoot,
            now,
            afterBackup: () => {
                writeFileSync(join(spare, "late.txt"), "written during the backup\n");
            },
        });

        expect(result.refusal).toContain("changed during the backup");
        expect(result.removed).toBe(false);
        expect(existsSync(spare)).toBe(true);
        expect(existsSync(join(result.folder ?? "", "untracked", "draft.txt"))).toBe(true);
        expect(readFileSync(join(result.folder ?? "", "README.md"), "utf8")).toContain("changed during the backup");
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
