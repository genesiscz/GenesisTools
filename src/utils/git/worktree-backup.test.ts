import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import {
    chmodSync,
    existsSync,
    readdirSync,
    readFileSync,
    statSync,
    symlinkSync,
    unlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type ExecCallOptions, Executor } from "@genesiscz/utils/cli/executor";
import { TestRepo } from "./test-repo";
import { backupWorktree, HASH_OBJECT_BATCH, planWorktreeBackup } from "./worktree-backup";

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

    it("a same-day backup in another root keeps the first safety ref, and copies a name ending in a backslash", async () => {
        const first = "refs/backups/worktrees/2026-11-09-repo-detached";
        const firstHead = await repo.git(["rev-parse", "--verify", first]);
        await repo.commit({ file: "later.txt", content: "later\n", message: "later lost commit", cwd: detached });
        repo.write({ file: "trail\\", content: "backslash\n", cwd: detached });
        // An ignored name ending in a backslash: split on it, "notes.log" would read as a rebuildable log and be dropped.
        repo.write({ file: join(".git", "info", "exclude"), content: "notes.log\\\\\n", cwd: repo.dir });
        repo.write({ file: "notes.log\\", content: "kept\n", cwd: detached });
        const result = await backupWorktree({ path: detached, backupRoot: join(repo.root, "backups-other"), now });

        expect(result.refusal).toBeNull();
        expect(result.ref).toBe(`${first}-2`);
        expect(await repo.git(["rev-parse", "--verify", first])).toBe(firstHead);
        expect(await repo.git(["rev-parse", "--verify", result.ref ?? ""])).toBe(result.plan.head);
        expect(result.plan.untracked).toEqual(["trail\\"]);
        expect(result.proof.copies).toBe("ok");
        expect(readFileSync(join(result.folder ?? "", "untracked", "trail\\"), "utf8")).toBe("backslash\n");
        expect(result.plan.ignored).toEqual(["notes.log\\"]);
        expect(readFileSync(join(result.folder ?? "", "ignored", "notes.log\\"), "utf8")).toBe("kept\n");
    });

    it("refuses a backup root inside the worktree, also through a symlink, before writing", async () => {
        const link = join(repo.root, "spare-link");
        symlinkSync(spare, link);
        const result = await backupWorktree({ path: spare, backupRoot: join(link, "node_modules", "backups"), now });

        expect(result.refusal).toContain("lies inside the worktree");
        expect(result.folder).toBeNull();
        expect(existsSync(join(spare, "node_modules"))).toBe(false);
    });

    it("refuses when assume-unchanged or skip-worktree hides an edit from git diff", async () => {
        await repo.git(["update-index", "--assume-unchanged", "README.md"], { cwd: spare });
        await repo.git(["update-index", "--skip-worktree", ".gitignore"], { cwd: spare });
        // The flags alone hide nothing.
        expect((await planWorktreeBackup({ path: spare })).blockers).toEqual([]);

        repo.write({ file: "README.md", content: "hidden edit\n", cwd: spare });
        const plan = await planWorktreeBackup({ path: spare });

        expect(plan.changed).toEqual([]);
        expect(plan.blockers).toHaveLength(1);
        expect(plan.blockers[0]).toContain("skip-worktree hides them from git diff (README.md)");
    });

    it("refuses an executable bit that assume-unchanged hides from git diff", async () => {
        // The test above left README.md assume-unchanged with an edit: its committed bytes come back first.
        repo.write({ file: "README.md", content: "seed\n", cwd: spare });
        expect((await planWorktreeBackup({ path: spare })).blockers).toEqual([]);

        chmodSync(join(spare, "README.md"), 0o755);
        const plan = await planWorktreeBackup({ path: spare });
        chmodSync(join(spare, "README.md"), 0o644);

        expect(plan.changed).toEqual([]);
        expect(plan.blockers).toHaveLength(1);
        expect(plan.blockers[0]).toContain("skip-worktree hides them from git diff (README.md)");
    });

    it("never starts the clean filter of a flagged file during a read-only plan", async () => {
        // A clean filter is a configured command, so the dry run must not run it; the raw bytes still show the edit.
        const marker = join(repo.root, "clean-filter-ran");
        const attributes = join(repo.root, "attributes");
        writeFileSync(attributes, "README.md filter=marker\n");
        await repo.git(["config", "core.attributesFile", attributes]);
        await repo.git(["config", "filter.marker.clean", `touch '${marker}'; cat`]);
        repo.write({ file: "README.md", content: "filtered edit\n", cwd: spare });

        try {
            const plan = await planWorktreeBackup({ path: spare });

            expect(existsSync(marker)).toBe(false);
            expect(plan.blockers).toHaveLength(1);
            expect(plan.blockers[0]).toContain("skip-worktree hides them from git diff (README.md)");
        } finally {
            await repo.git(["config", "--unset", "core.attributesFile"]);
            await repo.git(["config", "--remove-section", "filter.marker"]);
        }
    });

    it("hashes many flagged files in batches that stay lined up with their paths", async () => {
        repo.write({ file: "README.md", content: "seed\n", cwd: spare });
        const files = Object.fromEntries(
            Array.from({ length: HASH_OBJECT_BATCH + 10 }, (_, i) => [
                `many/f-${String(i).padStart(4, "0")}.txt`,
                `${i}\n`,
            ])
        );
        await repo.commitMany({ files, message: "many files", cwd: spare });
        const names = Object.keys(files);
        const first = names[0] ?? "";
        const last = names.at(-1) ?? "";
        await repo.git(["update-index", "--assume-unchanged", "--", ...names], { cwd: spare });
        // One edit in the first batch and one in the second: a batch read out of line would name other files.
        repo.write({ file: first, content: "edited\n", cwd: spare });
        repo.write({ file: last, content: "edited\n", cwd: spare });

        const exec = Executor.prototype.exec;
        const hashed: number[] = [];
        const spy = spyOn(Executor.prototype, "exec").mockImplementation(function (
            this: Executor,
            args: string[],
            options?: ExecCallOptions
        ) {
            if (args.includes("hash-object")) {
                hashed.push(args.length - args.indexOf("--") - 1);
            }

            return exec.call(this, args, options);
        });

        try {
            const plan = await planWorktreeBackup({ path: spare });

            // README.md and .gitignore are flagged too, so 2 files more than the many.
            expect(hashed).toEqual([HASH_OBJECT_BATCH, names.length + 2 - HASH_OBJECT_BATCH]);
            expect(plan.blockers).toHaveLength(1);
            expect(plan.blockers[0]).toContain(`hides them from git diff (${first}, ${last})`);
        } finally {
            spy.mockRestore();
        }
    });

    it("refuses a deletion that assume-unchanged hides, and passes a skip-worktree file a sparse checkout left out", async () => {
        // The test above edited the first and the last of the many files: their committed bytes come back first.
        const last = HASH_OBJECT_BATCH + 9;
        repo.write({ file: "many/f-0000.txt", content: "0\n", cwd: spare });
        repo.write({ file: `many/f-${String(last).padStart(4, "0")}.txt`, content: `${last}\n`, cwd: spare });
        expect((await planWorktreeBackup({ path: spare })).blockers).toEqual([]);

        // Two calls: one update-index with both flags leaves the entry with neither.
        await repo.git(["update-index", "--no-assume-unchanged", "many/f-0002.txt"], { cwd: spare });
        await repo.git(["update-index", "--skip-worktree", "many/f-0002.txt"], { cwd: spare });
        unlinkSync(join(spare, "many", "f-0001.txt"));
        unlinkSync(join(spare, "many", "f-0002.txt"));
        const plan = await planWorktreeBackup({ path: spare });

        expect(plan.changed).toEqual([]);
        expect(plan.blockers).toHaveLength(1);
        expect(plan.blockers[0]).toContain("hides them from git diff (many/f-0001.txt)");
    });

    it("takes the base from the other branches when no candidate gives one, and refuses --remove without a base", async () => {
        const lone = await TestRepo.create({ prefix: "gt-wt-backup-nobase-" });

        try {
            await lone.branch("side");
            const side = await lone.worktreeAdd({ name: "side", ref: "side" });
            await lone.commit({ file: "side.txt", content: "side\n", message: "side work", cwd: side });
            // No origin and a detached main checkout, as in a bare clone: no candidate gives a merge base.
            await lone.git(["checkout", "-q", "--detach"]);
            const result = await backupWorktree({ path: side, backupRoot: join(lone.root, "backups"), now });

            expect(result.plan.base?.sha).toBe(await lone.git(["rev-parse", "master"]));
            expect(result.plan.commits.map((commit) => commit.subject)).toEqual(["side work"]);
            expect(result.proof.commits).toBe("ok");
            expect(readdirSync(join(result.folder ?? "", "commits"))).toHaveLength(1);

            await lone.git(["checkout", "-q", "--orphan", "alone"], { cwd: side });
            await lone.commit({ file: "root.txt", content: "root\n", message: "orphan root", cwd: side });
            const orphan = await planWorktreeBackup({ path: side, remove: true });

            expect(orphan.base).toBeNull();
            expect(orphan.blockers.some((blocker) => blocker.startsWith("No base commit was found"))).toBe(true);
        } finally {
            lone.cleanup();
        }
    });

    it("throws for a main checkout and for a folder outside git", async () => {
        await expect(planWorktreeBackup({ path: repo.dir })).rejects.toThrow("main checkout");
        await expect(planWorktreeBackup({ path: backupRoot })).rejects.toThrow("no .git entry");
    });
});
