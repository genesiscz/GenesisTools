import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createGit, listWorktrees } from "@genesiscz/utils/git";
import { hermeticGitEnv, TEST_REPO_EPOCH, TestRepo } from "@genesiscz/utils/git/test-repo";
import {
    abortCascade,
    buildPlan,
    cleanupBackups,
    continueCascade,
    countCommits,
    createBackups,
    planLines,
    pushLines,
    runCascade,
} from "./execute";
import { detectChildren, orderChildren } from "./plan";
import { loadState, statePath } from "./state";

const repos: TestRepo[] = [];

afterEach(() => {
    for (const repo of repos.splice(0)) {
        repo.cleanup();
    }
});

async function repo(): Promise<TestRepo> {
    const r = await TestRepo.create({ prefix: "gt-cascade-" });
    repos.push(r);
    return r;
}

const target = { ref: "master", source: "flag" as const, detail: "--onto" };

async function plan(r: TestRepo, parent: string, childOverride?: string[]) {
    return buildPlan({
        cwd: r.dir,
        repoRoot: r.dir,
        parent,
        target,
        childOverride,
        worktrees: await listWorktrees(r.dir),
        nowEpoch: TEST_REPO_EPOCH + 1000,
    });
}

/** master moves; parent has 2 commits; c1 forks from the parent tip, c2 from the parent's first commit. */
async function stack(r: TestRepo): Promise<void> {
    await r.checkout("feat/parent", { create: true });
    await r.commit({ file: "p1.txt", content: "p1\n", message: "parent one" });
    const p1 = await r.sha();
    await r.commit({ file: "p2.txt", content: "p2\n", message: "parent two" });
    await r.checkout("feat/c1", { create: true });
    await r.commit({ file: "c1.txt", content: "c1\n", message: "child one" });
    await r.checkout("feat/c2", { create: true });
    await r.git(["reset", "-q", "--hard", p1]);
    await r.commit({ file: "c2.txt", content: "c2\n", message: "child two" });
    await r.checkout("master");
    await r.commit({ file: "m.txt", content: "master moved\n", message: "master moves" });
    await r.checkout("feat/parent");
}

async function subjects(r: TestRepo, range: string): Promise<string[]> {
    return (await r.git(["log", "--reverse", "--format=%s", range])).split("\n").filter(Boolean);
}

describe("plan (pure)", () => {
    it("detects children by parent-only depth and stacks a child of a child on its sibling", () => {
        const children = detectChildren("p", [
            { name: "c1", depthViaParent: 2, depthVia: { c3: 0 } },
            { name: "c2", depthViaParent: 2, depthVia: { c1: 3, c3: 0 } },
            { name: "c3", depthViaParent: 0, depthVia: {} },
            { name: "p", depthViaParent: 9, depthVia: {} },
        ]);
        expect(children).toEqual([
            { name: "c1", directParent: "p" },
            { name: "c2", directParent: "c1" },
        ]);
        expect(orderChildren("p", [children[1], children[0]]).map((c) => c.name)).toEqual(["c1", "c2"]);
        expect(() =>
            orderChildren("p", [
                { name: "a", directParent: "b" },
                { name: "b", directParent: "a" },
            ])
        ).toThrow(/cycle/);
    });
});

describe("cascade end to end", () => {
    it("rebases the parent and transplants both children by their own fork points", async () => {
        const r = await repo();
        await stack(r);
        const { plan: built, parentReport } = await plan(r, "feat/parent");
        expect(parentReport.verdict).toBe("UNMERGED");
        expect(built.parentRoute).toBe("rebase");
        expect(built.children.map((c) => [c.name, c.directParent, c.commits])).toEqual([
            ["feat/c1", "feat/parent", 1],
            ["feat/c2", "feat/parent", 1],
        ]);
        expect(planLines(built).join("\n")).toContain("git rebase master feat/parent");

        const git = createGit({ cwd: r.dir });
        await createBackups({ git, plan: built, stamp: "20260904-0500" });
        const result = await runCascade({ git, commonDir: join(r.dir, ".git"), plan: built, report: () => {} });
        expect(result.status).toBe("done");

        expect(await subjects(r, "master..feat/parent")).toEqual(["parent one", "parent two"]);
        expect(await subjects(r, "feat/parent..feat/c1")).toEqual(["child one"]);
        expect(await subjects(r, "feat/parent..feat/c2")).toEqual(["child two"]);
        expect(await r.git(["merge-base", "--is-ancestor", "master", "feat/c2"], { allowFail: true })).toBe("");
        expect(await r.git(["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feat/parent");
        expect(await r.git(["rev-parse", built.backups["feat/parent"].tag])).toBe(built.oldParent);
        expect(loadState(join(r.dir, ".git"))?.phase).toBe("done");
        expect(pushLines(built)).toEqual([
            "git push -u origin feat/parent",
            "git push -u origin feat/c1",
            "git push -u origin feat/c2",
        ]);

        await cleanupBackups({ git, commonDir: join(r.dir, ".git"), report: () => {} });
        expect(existsSync(statePath(join(r.dir, ".git")))).toBe(false);
        expect(await r.git(["tag", "-l", "bkp/cascade/*"])).toBe("");
    });

    it("orders a child of a child after its sibling and transplants it onto the rebased sibling", async () => {
        const r = await repo();
        await r.checkout("feat/parent", { create: true });
        await r.commit({ file: "p.txt", content: "p\n", message: "parent" });
        await r.checkout("feat/c1", { create: true });
        await r.commit({ file: "c1.txt", content: "c1\n", message: "child one" });
        await r.checkout("feat/c2", { create: true });
        await r.commit({ file: "c2.txt", content: "c2\n", message: "grandchild" });
        await r.checkout("master");
        await r.commit({ file: "m.txt", content: "m\n", message: "master moves" });

        const { plan: built } = await plan(r, "feat/parent");
        expect(built.children.map((c) => [c.name, c.directParent])).toEqual([
            ["feat/c1", "feat/parent"],
            ["feat/c2", "feat/c1"],
        ]);

        const git = createGit({ cwd: r.dir });
        await createBackups({ git, plan: built, stamp: "s" });
        expect((await runCascade({ git, commonDir: join(r.dir, ".git"), plan: built, report: () => {} })).status).toBe(
            "done"
        );
        expect(await subjects(r, "feat/c1..feat/c2")).toEqual(["grandchild"]);
        expect(await subjects(r, "master..feat/c2")).toEqual(["parent", "child one", "grandchild"]);
    });

    it("rebases a child checked out in another worktree inside that worktree", async () => {
        const r = await repo();
        await stack(r);
        const wt = await r.worktreeAdd({ name: "wt-c1", ref: "feat/c1" });
        const { plan: built } = await plan(r, "feat/parent");
        expect(built.children.find((c) => c.name === "feat/c1")?.worktree).toBe(wt);

        const git = createGit({ cwd: r.dir });
        await createBackups({ git, plan: built, stamp: "s" });
        const lines: string[] = [];
        expect(
            (await runCascade({ git, commonDir: join(r.dir, ".git"), plan: built, report: (l) => lines.push(l) }))
                .status
        ).toBe("done");
        expect(lines.some((l) => l.startsWith(`$ git -C ${wt} rebase --onto`))).toBe(true);
        expect(await r.git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: wt })).toBe("feat/c1");
        expect(await subjects(r, "feat/parent..feat/c1")).toEqual(["child one"]);
    });

    it("leaves a merged parent alone and transplants its children straight onto the target", async () => {
        const r = await repo();
        await stack(r);
        await r.checkout("master");
        await r.squashMerge("feat/parent");
        await r.checkout("feat/parent");

        const { plan: built, parentReport } = await plan(r, "feat/parent");
        expect(parentReport).toMatchObject({ verdict: "MERGED", how: "content" });
        expect(built.parentRoute).toBe("merged");
        expect(planLines(built).join("\n")).toContain("tools git merged --prune feat/parent");

        const git = createGit({ cwd: r.dir });
        const before = await r.sha("feat/parent");
        await createBackups({ git, plan: built, stamp: "s" });
        expect((await runCascade({ git, commonDir: join(r.dir, ".git"), plan: built, report: () => {} })).status).toBe(
            "done"
        );
        expect(await r.sha("feat/parent")).toBe(before);
        expect(await subjects(r, "master..feat/c1")).toEqual(["child one"]);
        expect(await subjects(r, "master..feat/c2")).toEqual(["child two"]);
        expect(pushLines(built)).toEqual(["git push -u origin feat/c1", "git push -u origin feat/c2"]);
    });

    it("routes a recomposed parent through the oracle merge and moves nothing until --continue", async () => {
        const r = await repo();
        await r.checkout("feat/parent", { create: true });

        for (const f of ["a", "b", "c", "d", "e"]) {
            await r.commit({ file: `${f}.txt`, content: `${f}\n`, message: `add ${f}` });
        }

        await r.checkout("feat/child", { create: true });
        await r.commit({ file: "child.txt", content: "child\n", message: "child" });
        await r.checkout("master");
        await r.commitMany({
            files: { "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n", "d.txt": "d\n" },
            message: "recomposed a-d",
        });
        await r.checkout("feat/parent");

        const { plan: built } = await plan(r, "feat/parent");
        expect(built.parentRoute).toBe("oracle");
        expect(built.parentEvidence).toMatchObject({ touched: 5, unmerged: 1, cherryPlus: 5 });

        const git = createGit({ cwd: r.dir });
        const commonDir = join(r.dir, ".git");
        await createBackups({ git, plan: built, stamp: "s" });
        const stopped = await runCascade({ git, commonDir: commonDir, plan: built, report: () => {} });
        expect(stopped.status).toBe("stopped");
        expect(await r.sha("feat/parent")).toBe(built.oldParent);
        expect(loadState(commonDir)).toMatchObject({ phase: "parent", current: "feat/parent" });

        await r.git(["rebase", "--empty=drop", "master"]);
        const saved = loadState(commonDir);
        expect(saved).not.toBeNull();
        const done = await continueCascade({
            git,
            commonDir,
            plan: saved as NonNullable<typeof saved>,
            report: () => {},
        });
        expect(done.status).toBe("done");
        expect(await subjects(r, "master..feat/parent")).toEqual(["add e"]);
        expect(await subjects(r, "feat/parent..feat/child")).toEqual(["child"]);
    });

    it("stops on a conflict, resumes with --continue after the human resolves, and can abort back to the backups", async () => {
        const r = await repo();
        await r.commit({ file: "shared.txt", content: "base\n", message: "shared base" });
        await r.checkout("feat/parent", { create: true });
        await r.commit({ file: "p.txt", content: "p\n", message: "parent" });
        await r.checkout("feat/child", { create: true });
        await r.commit({ file: "shared.txt", content: "child\n", message: "child edits shared" });
        await r.checkout("master");
        await r.commit({ file: "shared.txt", content: "master\n", message: "master edits shared" });
        await r.checkout("feat/parent");

        const git = createGit({ cwd: r.dir });
        const commonDir = join(r.dir, ".git");
        const { plan: built } = await plan(r, "feat/parent");
        await createBackups({ git, plan: built, stamp: "s" });
        const first = await runCascade({ git, commonDir: commonDir, plan: built, report: () => {} });
        expect(first.status).toBe("conflict");
        expect(first.branch).toBe("feat/child");
        expect(first.conflictFiles).toEqual(["shared.txt"]);

        const stillBusy = await continueCascade({
            git,
            commonDir,
            plan: loadState(commonDir) as NonNullable<ReturnType<typeof loadState>>,
            report: () => {},
        });
        expect(stillBusy.status).toBe("conflict");

        r.write({ file: "shared.txt", content: "master\nchild\n" });
        await r.git(["add", "shared.txt"]);
        await r.git(["rebase", "--continue"]);
        const done = await continueCascade({
            git,
            commonDir,
            plan: loadState(commonDir) as NonNullable<ReturnType<typeof loadState>>,
            report: () => {},
        });
        expect(done.status).toBe("done");
        expect(await subjects(r, "feat/parent..feat/child")).toEqual(["child edits shared"]);
        expect(await r.git(["show", "feat/child:shared.txt"])).toBe("master\nchild");

        const { plan: again } = await plan(r, "feat/parent");
        expect(again.children).toHaveLength(1);
    });

    it("abort restores every branch to its backup even mid-conflict", async () => {
        const r = await repo();
        await r.commit({ file: "shared.txt", content: "base\n", message: "shared base" });
        await r.checkout("feat/parent", { create: true });
        await r.commit({ file: "shared.txt", content: "parent\n", message: "parent edits shared" });
        await r.checkout("feat/child", { create: true });
        await r.commit({ file: "c.txt", content: "c\n", message: "child" });
        await r.checkout("master");
        await r.commit({ file: "shared.txt", content: "master\n", message: "master edits shared" });
        await r.checkout("feat/child");

        const git = createGit({ cwd: r.dir });
        const commonDir = join(r.dir, ".git");
        const { plan: built } = await plan(r, "feat/parent");
        await createBackups({ git, plan: built, stamp: "s" });
        const first = await runCascade({ git, commonDir: commonDir, plan: built, report: () => {} });
        expect(first).toMatchObject({ status: "conflict", branch: "feat/parent" });

        await abortCascade({
            git,
            commonDir,
            plan: loadState(commonDir) as NonNullable<ReturnType<typeof loadState>>,
            report: () => {},
        });
        expect(await r.sha("feat/parent")).toBe(built.oldTips["feat/parent"]);
        expect(await r.sha("feat/child")).toBe(built.oldTips["feat/child"]);
        expect(await r.git(["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feat/child");
        expect(existsSync(join(r.dir, ".git", "rebase-merge"))).toBe(false);
        expect(loadState(commonDir)).toBeNull();
        expect(await r.git(["tag", "-l", "bkp/cascade/*"])).toContain("bkp/cascade/feat-parent-s");
    });

    it("--dry-run prints the plan from a dirty checkout and moves nothing", async () => {
        const r = await repo();
        await stack(r);
        r.write({ file: "scratch.txt", content: "uncommitted\n" });
        const before = await r.sha("feat/c1");
        const proc = Bun.spawn(
            [
                "bun",
                join(import.meta.dir, "../../index.ts"),
                "rebase-cascade",
                "feat/parent",
                "--onto",
                "master",
                "--dry-run",
                "--offline",
                "-C",
                r.dir,
            ],
            { stdout: "pipe", stderr: "pipe", env: hermeticGitEnv() }
        );
        const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
        expect(code).toBe(0);
        expect(stdout).toContain("child:  feat/c1 (1 commit)");
        expect(await r.sha("feat/c1")).toBe(before);
        expect(loadState(join(r.dir, ".git"))).toBeNull();
    });

    it("honours --child overrides and refuses unknown branches", async () => {
        const r = await repo();
        await stack(r);
        const { plan: built } = await plan(r, "feat/parent", ["feat/c2"]);
        expect(built.children.map((c) => c.name)).toEqual(["feat/c2"]);
        await expect(plan(r, "feat/parent", ["nope"])).rejects.toThrow(/does not exist/);
        await expect(plan(r, "ghost")).rejects.toThrow(/does not exist/);
    });
});

describe("review round 1", () => {
    it("countCommits throws on a range git cannot resolve instead of answering 0", async () => {
        const r = await repo();
        const git = createGit({ cwd: r.dir });
        await expect(countCommits(git, "nope..nope")).rejects.toThrow(/rev-list/);
        expect(await countCommits(git, "HEAD~0..HEAD")).toBe(0);
    });

    it("--cleanup refuses to delete the backups of a cascade that is still in progress unless --yes", async () => {
        const r = await repo();
        await r.commit({ file: "shared.txt", content: "base\n", message: "shared base" });
        await r.checkout("feat/parent", { create: true });
        await r.commit({ file: "p.txt", content: "p\n", message: "parent" });
        await r.checkout("feat/child", { create: true });
        await r.commit({ file: "shared.txt", content: "child\n", message: "child edits shared" });
        await r.checkout("master");
        await r.commit({ file: "shared.txt", content: "master\n", message: "master edits shared" });
        await r.checkout("feat/parent");

        const git = createGit({ cwd: r.dir });
        const commonDir = join(r.dir, ".git");
        const { plan: built } = await plan(r, "feat/parent");
        await createBackups({ git, plan: built, stamp: "s" });
        const first = await runCascade({ git, commonDir, plan: built, report: () => {} });
        expect(first.status).toBe("conflict");

        const cleanup = async (extra: string[]) => {
            const proc = Bun.spawn(
                ["bun", join(import.meta.dir, "../../index.ts"), "rebase-cascade", "--cleanup", ...extra, "-C", r.dir],
                { stdout: "pipe", stderr: "pipe", env: hermeticGitEnv() }
            );
            const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
            return { code, stderr };
        };

        const refused = await cleanup([]);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("in progress");
        expect(await r.git(["tag", "-l", "bkp/cascade/*"])).toContain("bkp/cascade/feat-parent-s");
        expect(loadState(commonDir)).not.toBeNull();

        const forced = await cleanup(["--yes"]);
        expect(forced.code).toBe(0);
        expect(await r.git(["tag", "-l", "bkp/cascade/*"])).toBe("");
        expect(loadState(commonDir)).toBeNull();
    });
});

describe("judge round 1", () => {
    it("leaves a zero-commit branch that merely points at an older parent commit alone", async () => {
        const r = await repo();
        await stack(r);
        await r.branch("parent-snapshot", "feat/parent~1");
        const snapshot = await r.sha("parent-snapshot");
        const { plan: built } = await plan(r, "feat/parent");
        expect(built.children.map((c) => c.name)).toEqual(["feat/c1", "feat/c2"]);
        expect(built.skipped).toEqual([{ name: "parent-snapshot", reason: "0 commits of its own" }]);

        const git = createGit({ cwd: r.dir });
        await createBackups({ git, plan: built, stamp: "s" });
        const result = await runCascade({ git, commonDir: join(r.dir, ".git"), plan: built, report: () => {} });
        expect(result.status).toBe("done");
        expect(await r.sha("parent-snapshot")).toBe(snapshot);
    });

    it("--abort leaves a dirty worktree where it is and names it, and restores the others", async () => {
        const r = await repo();
        await r.commit({ file: "shared.txt", content: "base\n", message: "shared base" });
        await r.checkout("feat/parent", { create: true });
        await r.commit({ file: "p.txt", content: "p\n", message: "parent" });
        await r.checkout("feat/c1", { create: true });
        await r.commit({ file: "c1.txt", content: "c1\n", message: "child one" });
        await r.checkout("feat/c2", { create: true });
        await r.git(["reset", "-q", "--hard", "feat/parent"]);
        await r.commit({ file: "shared.txt", content: "child\n", message: "child two edits shared" });
        await r.checkout("master");
        await r.commit({ file: "shared.txt", content: "master\n", message: "master edits shared" });
        await r.checkout("feat/parent");
        const wt = await r.worktreeAdd({ name: "wt-c1", ref: "feat/c1" });

        const git = createGit({ cwd: r.dir });
        const commonDir = join(r.dir, ".git");
        const { plan: built } = await plan(r, "feat/parent");
        await createBackups({ git, plan: built, stamp: "s" });
        const first = await runCascade({ git, commonDir, plan: built, report: () => {} });
        expect(first).toMatchObject({ status: "conflict", branch: "feat/c2" });
        const rebasedC1 = await r.sha("feat/c1");
        expect(rebasedC1).not.toBe(built.backups["feat/c1"].sha);

        r.write({ file: "c1.txt", content: "edited while investigating\n", cwd: wt });
        const lines: string[] = [];
        await abortCascade({ git, commonDir, plan: built, report: (l) => lines.push(l) });

        expect(await r.sha("feat/c1")).toBe(rebasedC1);
        expect(await r.git(["show", `feat/c1:c1.txt`])).toBe("c1");
        expect(await r.git(["diff", "--name-only"], { cwd: wt })).toBe("c1.txt");
        expect(lines.find((l) => l.includes("feat/c1"))).toContain("dirty");
        expect(await r.sha("feat/c2")).toBe(built.backups["feat/c2"].sha);
        expect(await r.sha("feat/parent")).toBe(built.backups["feat/parent"].sha);
    });
});
