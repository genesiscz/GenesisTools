import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { listWorktrees, type OriginDriver, type PrInfo } from "@genesiscz/utils/git";
import { hermeticGitEnv, type ImportedCommit, TEST_REPO_EPOCH, TestRepo } from "@genesiscz/utils/git/test-repo";
import { SafeJSON } from "@genesiscz/utils/json";
import { type CollectContext, collectRefReport, listAllRefs } from "./collect";
import { executePrune, type PruneContext, planPrune } from "./prune";
import { contentVerdict, historicBlobsOf, quickVerdict } from "./verdict";

const repos: TestRepo[] = [];

afterEach(() => {
    for (const repo of repos.splice(0)) {
        repo.cleanup();
    }
});

function track(r: TestRepo): TestRepo {
    repos.push(r);
    return r;
}

async function repo(): Promise<TestRepo> {
    return track(await TestRepo.create({ prefix: "gt-merged-" }));
}

/**
 * A repository that already carries the default two-commit `feat/x`, built once per process.
 *
 * Eleven cases wanted exactly this. The bytes are deterministic, so the eleventh copy is the
 * same repository the first one built.
 */
async function repoWithFeature(): Promise<TestRepo> {
    return track(await TestRepo.fromScenario("merged:feat/x", (target) => feature(target), { prefix: "gt-merged-" }));
}

/** `importCommits` onto the checked-out `master`, then the index and working tree catch up with it. */
async function commitsOnCheckout(r: TestRepo, commits: ImportedCommit[]): Promise<void> {
    await r.importCommits({ branch: "master", from: "refs/heads/master", commits });
    await r.git(["reset", "-q", "--hard"]);
}

async function ctxFor(r: TestRepo, baseRef = "master"): Promise<CollectContext> {
    return {
        repoRoot: r.dir,
        worktrees: await listWorktrees(r.dir),
        base: { ref: baseRef, source: "flag", detail: "--base" },
        driver: null,
        wantPr: false,
        staleDays: 90,
        nowEpoch: TEST_REPO_EPOCH + 1000,
    };
}

async function pruneCtxFor(r: TestRepo, extra: Partial<PruneContext> = {}): Promise<PruneContext> {
    return {
        ...(await ctxFor(r)),
        remote: false,
        currentBranch: await r.git(["rev-parse", "--abbrev-ref", "HEAD"]),
        policyFor: () => ({ push: "confirm", matchedBy: "none" }),
        ...extra,
    };
}

/**
 * A two-commit feature branch off master per name, with content unique to its name; master stays
 * checked out. One process for all of them, where checkout -b, two add/commit pairs and the
 * checkout back were six per branch.
 */
async function feature(r: TestRepo, ...names: string[]): Promise<void> {
    await r.importCommits(
        (names.length ? names : ["feat/x"]).map((name) => {
            const tag = name.replace(/[^a-z0-9]+/gi, "-");
            return {
                branch: name,
                from: "refs/heads/master",
                commits: [
                    { files: { [`${tag}-a.txt`]: `alpha ${tag}\n` }, message: `add alpha ${tag}` },
                    { files: { [`${tag}-b.txt`]: `beta ${tag}\n` }, message: `add beta ${tag}` },
                ],
            };
        })
    );
}

describe("verdict ladder", () => {
    it("EMPTY when the branch has nothing of its own", async () => {
        const r = await repo();
        await r.branch("feat/empty");
        const report = await collectRefReport(await ctxFor(r), "feat/empty");
        expect(report).toMatchObject({ verdict: "EMPTY", how: "-", ahead: 0, touched: null });
    });

    it("MERGED by ancestor after a fast-forward merge, EMPTY when sitting exactly on the base", async () => {
        const r = await repoWithFeature();
        await r.git(["merge", "-q", "--ff-only", "feat/x"]);
        const atBase = await collectRefReport(await ctxFor(r), "feat/x");
        expect(atBase).toMatchObject({ verdict: "EMPTY", how: "-", ahead: 0 });

        await r.commit({ file: "m.txt", content: "master moved\n", message: "master moves" });
        const report = await collectRefReport(await ctxFor(r), "feat/x");
        expect(report).toMatchObject({ verdict: "MERGED", how: "ancestor", ahead: 0, behind: 1 });
    });

    it("MERGED by cherry when the commits were cherry-picked with new shas", async () => {
        const r = await repoWithFeature();
        await r.commit({ file: "m.txt", content: "master moved\n", message: "master moves" });
        await r.git(["cherry-pick", "master..feat/x"], { epoch: r.tick() });
        const report = await collectRefReport(await ctxFor(r), "feat/x");
        expect(report).toMatchObject({ verdict: "MERGED", how: "cherry", ahead: 2, cherryPlus: 0 });
    });

    it("MERGED by content after a squash merge, even once master moved on", async () => {
        const r = await repoWithFeature();
        await r.squashMerge("feat/x");
        await r.commit({ file: "m.txt", content: "master moved\n", message: "master moves" });

        const cherry = await r.git(["cherry", "master", "feat/x"]);
        expect(cherry.split("\n").every((l) => l.startsWith("+"))).toBe(true);

        const report = await collectRefReport(await ctxFor(r), "feat/x");
        expect(report).toMatchObject({ verdict: "MERGED", how: "content", ahead: 2, cherryPlus: 2, touched: 2 });
        expect(report.commands).toEqual(["git branch -D feat/x"]);
    });

    it("MERGED by content when three commits were recomposed into two with the same final tree", async () => {
        const r = await repo();
        await r.importCommits({
            branch: "feat/three",
            from: "refs/heads/master",
            commits: [
                { files: { "a.txt": "a1\n" }, message: "a first" },
                { files: { "a.txt": "a2\n" }, message: "a second" },
                { files: { "c.txt": "c\n" }, message: "c" },
            ],
        });
        await commitsOnCheckout(r, [
            { files: { "a.txt": "a2\n" }, message: "recomposed: a" },
            { files: { "c.txt": "c\n" }, message: "recomposed: c" },
            { files: { "m.txt": "later\n" }, message: "master moves" },
        ]);

        const report = await collectRefReport(await ctxFor(r), "feat/three");
        expect(report).toMatchObject({ verdict: "MERGED", how: "content", ahead: 3 });
    });

    it("STALE when the base rewrote every file the snapshot still holds an older copy of", async () => {
        const r = await repo();
        await r.importCommits({
            branch: "feat/pr",
            from: "refs/heads/master",
            commits: [
                { files: { "a.txt": "v1\n" }, message: "a v1" },
                { files: { "b.txt": "b\n" }, message: "b" },
            ],
        });
        await r.branch("backup/snapshot", "feat/pr");
        await r.importCommits({
            branch: "feat/pr",
            from: "refs/heads/feat/pr",
            commits: [{ files: { "a.txt": "v2\n" }, message: "a v2" }],
        });
        await r.squashMerge("feat/pr");

        const pr = await collectRefReport(await ctxFor(r), "feat/pr");
        expect(pr.verdict).toBe("MERGED");

        const snapshot = await collectRefReport(await ctxFor(r), "backup/snapshot");
        expect(snapshot).toMatchObject({ verdict: "STALE", how: "superseded", touched: 2 });
        expect(snapshot.unmerged).toEqual([{ path: "a.txt", status: "A", insertions: 1, deletions: 1 }]);
        // STALE never auto-suggests removal: the reader decides whether an older
        // draft is worth keeping, so --prune has to name it.
        expect(snapshot.commands).toEqual([]);
    });

    it("UNMERGED when a file the branch changed was never touched again on the base", async () => {
        const r = await repo();
        await r.importCommits({
            branch: "feat/orphan",
            from: "refs/heads/master",
            commits: [{ files: { "only-here.txt": "mine\n" }, message: "add only-here" }],
        });
        await commitsOnCheckout(r, [{ files: { "elsewhere.txt": "other\n" }, message: "unrelated work" }]);

        const report = await collectRefReport(await ctxFor(r), "feat/orphan");
        expect(report).toMatchObject({ verdict: "UNMERGED", how: "none" });
        expect(report.unmerged.map((u) => u.path)).toEqual(["only-here.txt"]);
        expect(report.commands).toEqual([]);
    });

    it("treats a deleted path as merged only when the base no longer has it", async () => {
        const r = await repo();
        await commitsOnCheckout(r, [{ files: { "old.txt": "old\n" }, message: "add old" }]);
        await r.importCommits({
            branch: "feat/del",
            from: "refs/heads/master",
            commits: [
                { deletes: ["old.txt"], message: "delete old.txt" },
                { files: { "new.txt": "new\n" }, message: "add new" },
            ],
        });

        const before = await collectRefReport(await ctxFor(r), "feat/del");
        expect(before.verdict).toBe("UNMERGED");
        expect(before.unmerged.map((u) => `${u.status} ${u.path}`)).toEqual(["A new.txt", "D old.txt"]);

        await r.squashMerge("feat/del");
        const after = await collectRefReport(await ctxFor(r), "feat/del");
        expect(after).toMatchObject({ verdict: "MERGED", how: "content" });
    });

    it("handles binary files by blob id and reports them as 0/0 when unmerged", async () => {
        const r = await repo();
        await r.importCommits({
            branch: "feat/bin",
            from: "refs/heads/master",
            commits: [{ files: { "blob.dat": "\u0000\u0001\u0002binary\u0000\n" }, message: "add binary" }],
        });

        const before = await collectRefReport(await ctxFor(r), "feat/bin");
        expect(before.unmerged).toEqual([{ path: "blob.dat", status: "A", insertions: 0, deletions: 0 }]);

        await r.squashMerge("feat/bin");
        expect((await collectRefReport(await ctxFor(r), "feat/bin")).verdict).toBe("MERGED");
    });

    it("does not penalise a branch far behind the base", async () => {
        const r = await repoWithFeature();
        await r.squashMerge("feat/x");

        await commitsOnCheckout(
            r,
            Array.from({ length: 30 }, (_, i) => ({ files: { [`m${i}.txt`]: `${i}\n` }, message: `master ${i}` }))
        );

        const report = await collectRefReport(await ctxFor(r), "feat/x");
        expect(report).toMatchObject({ verdict: "MERGED", how: "content", behind: 31 });
    });

    it("parses paths with spaces and non-ASCII characters", async () => {
        const r = await repo();
        await r.importCommits({
            branch: "feat/unicode",
            from: "refs/heads/master",
            commits: [
                { files: { "dir/ná me.txt": "čau\n" }, message: "add unicode path" },
                { files: { "dir/ná me.txt": "čau znovu\n" }, message: "edit unicode path" },
            ],
        });
        await r.squashMerge("feat/unicode");
        await r.commit({ file: "m.txt", content: "m\n", message: "master moves" });
        const report = await collectRefReport(await ctxFor(r), "feat/unicode");
        expect(report).toMatchObject({ verdict: "MERGED", how: "content", touched: 1 });
    });

    it("judges a worktree by path, detached or on a branch, and counts dirt", async () => {
        const r = await repoWithFeature();
        await r.squashMerge("feat/x");
        const detached = await r.worktreeAdd({ name: "wt-detached", ref: "feat/x", detach: true });
        const onBranch = await r.worktreeAdd({ name: "wt-branch", ref: "feat/x" });
        r.write({ file: "feat-x-a.txt", content: "dirty\n", cwd: onBranch });

        const ctx = await ctxFor(r);
        const byPath = await collectRefReport(ctx, detached);
        expect(byPath).toMatchObject({ verdict: "MERGED", how: "content", branch: null, worktree: detached, dirty: 0 });
        expect(byPath.commands).toEqual([`git worktree remove ${SafeJSON.stringify(detached)}`]);

        const byBranch = await collectRefReport(ctx, "feat/x");
        expect(byBranch).toMatchObject({ verdict: "MERGED", worktree: onBranch, dirty: 1, commands: [] });
    });

    it("reports upstream, unpushed and gone", async () => {
        const r = await repoWithFeature();
        await r.addOrigin(["feat/x"]);
        await r.checkout("feat/x");
        await r.commit({ file: "c.txt", content: "c\n", message: "local only" });
        await r.checkout("master");
        await r.squashMerge("feat/x");

        const report = await collectRefReport(await ctxFor(r), "feat/x");
        expect(report).toMatchObject({
            verdict: "MERGED",
            upstream: "origin/feat/x",
            unpushed: 1,
            upstreamGone: false,
        });

        await r.git(["push", "-q", "origin", "--delete", "feat/x"]);
        await r.git(["fetch", "-q", "--prune", "origin"]);
        const gone = await collectRefReport(await ctxFor(r), "feat/x");
        expect(gone).toMatchObject({ upstreamGone: true, unpushed: null });
    });

    it("rejects a name that is neither a worktree, a branch, nor a commit", async () => {
        const r = await repo();
        await expect(collectRefReport(await ctxFor(r), "nope")).rejects.toThrow(/neither a worktree path/);
    });

    it("judges a stacked child against the base its PR names", async () => {
        const r = await repo();
        await feature(r, "feat/parent");
        await r.importCommits({
            branch: "feat/child",
            from: "refs/heads/feat/parent",
            commits: [{ files: { "child.txt": "child\n" }, message: "child work" }],
        });

        const ctx = await ctxFor(r);
        const againstMaster = await collectRefReport(ctx, "feat/child");
        expect(againstMaster.verdict).toBe("UNMERGED");
        expect(againstMaster.unmerged.length).toBe(3);

        const pr: PrInfo = { number: 3, state: "OPEN", target: "feat/parent", url: "u" };
        const againstParent = await collectRefReport(
            {
                ...ctx,
                baseFor: async () => ({
                    ref: "feat/parent",
                    source: "pr",
                    detail: `OPEN PR #${pr.number} targets ${pr.target}`,
                    pr,
                }),
            },
            "feat/child"
        );
        expect(againstParent.base).toEqual({ ref: "feat/parent", source: "pr" });
        expect(againstParent.unmerged.map((u) => u.path)).toEqual(["child.txt"]);
    });
});

describe("listAllRefs", () => {
    it("lists every local branch except the base and master/main, plus detached worktrees", async () => {
        const r = await repoWithFeature();
        await r.branch("main");
        const detached = await r.worktreeAdd({ name: "wt-detached", ref: "feat/x", detach: true });
        await r.worktreeAdd({ name: "wt-branch", ref: "feat/x" });
        const refs = await listAllRefs(await ctxFor(r));
        expect(refs).toEqual(["feat/x", detached]);
    });
});

describe("prune", () => {
    it("refuses unmerged, dirty, current, base and main-checkout refs", async () => {
        const r = await repo();
        await feature(r, "feat/unmerged", "feat/dirty");
        await r.squashMerge("feat/dirty");
        const dirtyWt = await r.worktreeAdd({ name: "wt-dirty", ref: "feat/dirty" });
        r.write({ file: "feat-dirty-a.txt", content: "dirty\n", cwd: dirtyWt });

        const { plans, refusals } = await planPrune(await pruneCtxFor(r), [
            "feat/unmerged",
            "feat/dirty",
            "master",
            r.dir,
        ]);
        expect(plans).toEqual([]);
        expect(refusals.map((x) => x.reason)).toEqual([
            "UNMERGED: 2 file(s) never landed on master",
            "worktree has 1 uncommitted entry",
            "is the base branch",
            "is the main checkout",
        ]);

        await r.checkout("feat/unmerged");
        const current = await planPrune(
            await pruneCtxFor(r, { base: { ref: "feat/dirty", source: "flag", detail: "" } }),
            ["feat/unmerged"]
        );
        expect(current.refusals[0].reason).toBe("checked out in the current checkout");
    });

    it("removes a merged branch and its worktree, warning about an older remote copy", async () => {
        const r = await repoWithFeature();
        await r.addOrigin(["feat/x"]);
        await r.checkout("feat/x");
        await r.commit({ file: "c.txt", content: "c\n", message: "more" });
        await r.checkout("master");
        await r.squashMerge("feat/x");
        const wt = await r.worktreeAdd({ name: "wt-x", ref: "feat/x" });
        const tip = await r.sha("feat/x");

        const ctx = await pruneCtxFor(r);
        const { plans, refusals } = await planPrune(ctx, ["feat/x"]);
        expect(refusals).toEqual([]);
        expect(plans[0]).toMatchObject({ branch: "feat/x", tipSha: tip, worktreePath: wt, remoteBranch: null });
        expect(plans[0].warnings[0]).toContain("origin/feat/x holds an older copy (1 unpushed commit(s))");

        const outcomes = await executePrune(ctx, plans);
        expect(outcomes[0]).toMatchObject({
            removedWorktree: wt,
            deletedBranch: { name: "feat/x", sha: tip },
            failures: [],
        });
        expect(existsSync(wt)).toBe(false);
        expect(await r.git(["rev-parse", "--verify", "--quiet", "refs/heads/feat/x"], { allowFail: true })).toBe("");
        expect(await r.git(["ls-remote", "--heads", "origin", "feat/x"])).toContain("feat/x");
    });

    it("deletes the remote only with --remote, and keeps it for an open PR or a push:never policy", async () => {
        const r = await repo();
        await feature(r, "feat/open", "feat/never", "feat/ok");
        await r.addOrigin(["feat/open", "feat/never", "feat/ok"]);
        await r.squashMerge("feat/open");
        await r.squashMerge("feat/never");
        await r.squashMerge("feat/ok");

        const driver: OriginDriver = {
            kind: "github",
            prForHead: async (branch) => ({
                pr: branch === "feat/open" ? { number: 9, state: "OPEN", target: "master", url: "u" } : null,
                error: null,
            }),
        };
        const ctx = await pruneCtxFor(r, {
            remote: true,
            driver,
            policyFor: (branch) =>
                branch === "feat/never"
                    ? { push: "never", matchedBy: "name" }
                    : { push: "allowed", matchedBy: "catchAll" },
        });
        const { plans } = await planPrune(ctx, ["feat/open", "feat/never", "feat/ok"]);
        expect(plans.map((p) => p.remoteBranch)).toEqual([null, null, "feat/ok"]);
        expect(plans[0].warnings[0]).toContain("OPEN PR #9");
        expect(plans[1].warnings[0]).toContain("push policy is never");

        const outcomes = await executePrune(ctx, plans);
        expect(outcomes.map((o) => o.deletedRemote?.name ?? null)).toEqual([null, null, "feat/ok"]);
        expect(outcomes[2].deletedRemote?.sha).toMatch(/^[0-9a-f]{40}$/);
        const remoteHeads = await r.git(["ls-remote", "--heads", "origin"]);
        expect(remoteHeads).toContain("feat/open");
        expect(remoteHeads).toContain("feat/never");
        expect(remoteHeads).not.toContain("feat/ok");
    });

    it("deletes a remote-only origin/<branch> whose local copy is already gone", async () => {
        const r = await repo();
        await feature(r, "feat/gone");
        await r.addOrigin(["feat/gone"]);
        await r.squashMerge("feat/gone");
        await r.git(["branch", "-D", "feat/gone"]);

        const driver: OriginDriver = { kind: "github", prForHead: async () => ({ pr: null, error: null }) };
        const ctx = await pruneCtxFor(r, {
            remote: true,
            driver,
            policyFor: () => ({ push: "allowed", matchedBy: "catchAll" }),
        });
        const { plans, refusals } = await planPrune(ctx, ["origin/feat/gone"]);

        expect(refusals).toEqual([]);
        expect(plans[0]).toMatchObject({ remoteOnly: true, branch: null, remoteBranch: "feat/gone" });
        expect(plans[0].remoteSha).toMatch(/^[0-9a-f]{40}$/);

        const outcomes = await executePrune(ctx, plans);
        expect(outcomes[0].deletedRemote?.name).toBe("feat/gone");
        expect(outcomes[0].failures).toEqual([]);
        expect(await r.git(["ls-remote", "--heads", "origin"])).not.toContain("feat/gone");
    });

    it("refuses a remote-only ref without --remote, and never reports success having done nothing", async () => {
        const r = await repo();
        await feature(r, "feat/gone");
        await r.addOrigin(["feat/gone"]);
        await r.squashMerge("feat/gone");
        await r.git(["branch", "-D", "feat/gone"]);

        const ctx = await pruneCtxFor(r, { remote: false });
        const { plans, refusals } = await planPrune(ctx, ["origin/feat/gone"]);

        expect(plans).toEqual([]);
        expect(refusals[0].reason).toContain("--remote");
        expect(await r.git(["ls-remote", "--heads", "origin"])).toContain("feat/gone");
    });

    it("refuses a remote-only ref with an OPEN PR, a failed PR lookup, or a never push policy", async () => {
        const r = await repo();
        await feature(r, "feat/open", "feat/blind", "feat/never");
        await r.addOrigin(["feat/open", "feat/blind", "feat/never"]);
        await r.squashMerge("feat/open");
        await r.squashMerge("feat/blind");
        await r.squashMerge("feat/never");
        await r.git(["branch", "-D", "feat/open", "feat/blind", "feat/never"]);

        const driver: OriginDriver = {
            kind: "github",
            prForHead: async (branch) => {
                if (branch === "feat/open") {
                    return { pr: { number: 12, state: "OPEN", target: "master", url: "u" }, error: null };
                }

                return branch === "feat/blind"
                    ? { pr: null, error: "gh: command not found" }
                    : { pr: null, error: null };
            },
        };
        const ctx = await pruneCtxFor(r, {
            remote: true,
            driver,
            policyFor: (branch) =>
                branch === "feat/never"
                    ? { push: "never", matchedBy: "name" }
                    : { push: "allowed", matchedBy: "catchAll" },
        });
        const { plans, refusals } = await planPrune(ctx, [
            "origin/feat/open",
            "origin/feat/blind",
            "origin/feat/never",
        ]);

        expect(plans).toEqual([]);
        expect(refusals.map((x) => x.ref)).toEqual(["origin/feat/open", "origin/feat/blind", "origin/feat/never"]);
        expect(refusals[0].reason).toContain("OPEN PR #12");
        expect(refusals[1].reason).toContain("PR lookup failed");
        expect(refusals[2].reason).toContain("push policy is never");

        const heads = await r.git(["ls-remote", "--heads", "origin"]);
        expect(heads).toContain("feat/open");
        expect(heads).toContain("feat/blind");
        expect(heads).toContain("feat/never");
    });

    it("refuses origin/<base> even with --remote", async () => {
        const r = await repo();
        await r.addOrigin();
        const driver: OriginDriver = { kind: "github", prForHead: async () => ({ pr: null, error: null }) };
        const ctx = await pruneCtxFor(r, { remote: true, driver });
        const { plans, refusals } = await planPrune(ctx, ["origin/master"]);

        expect(plans).toEqual([]);
        expect(refusals[0].reason).toBe("is the base branch");
    });

    it("refuses to force-remove a worktree holding real edits, but clears deletion debris", async () => {
        const r = await repoWithFeature();
        await r.squashMerge("feat/x");
        const wt = await r.worktreeAdd({ name: "wt-x", ref: "feat/x" });
        const ctx = await pruneCtxFor(r);
        const { plans } = await planPrune(ctx, ["feat/x"]);
        expect(plans).toHaveLength(1);

        r.write({ file: "feat-x-a.txt", content: "edited after the plan\n", cwd: wt });
        const refused = await executePrune(ctx, plans);
        expect(refused[0].failures[0]).toContain("non-deletion entr");
        expect(existsSync(wt)).toBe(true);

        r.write({ file: "feat-x-a.txt", content: "alpha feat-x\n", cwd: wt });
        await r.git(["rm", "-q", "--", "feat-x-a.txt"], { cwd: wt });
        const cleared = await executePrune(ctx, plans);
        expect(cleared[0]).toMatchObject({ removedWorktree: wt, failures: [] });
        expect(existsSync(wt)).toBe(false);
    });
});

describe("prunable worktrees", () => {
    it("judges and prunes an entry whose folder is gone", async () => {
        const r = await repoWithFeature();
        await r.squashMerge("feat/x");
        const wt = await r.worktreeAdd({ name: "wt-gone", ref: "feat/x", detach: true });
        rmSync(wt, { recursive: true, force: true });

        const ctx = await pruneCtxFor(r);
        const report = await collectRefReport(ctx, wt);
        expect(report).toMatchObject({ kind: "path", verdict: "MERGED", worktree: wt, dirty: 0 });
        expect(report.prunable).not.toBeNull();
        expect(report.commands).toEqual(["git worktree prune"]);
        expect(await listAllRefs(ctx)).toContain(wt);

        const { plans, refusals } = await planPrune(ctx, [wt]);
        expect(refusals).toEqual([]);
        const [outcome] = await executePrune(ctx, plans);
        expect(outcome).toMatchObject({ removedWorktree: wt, leftFolder: null, failures: [] });
        expect((await listWorktrees(r.dir)).some((w) => w.path === wt)).toBe(false);
    });

    it("prunes an entry whose folder lost its .git file and reports the folder it left", async () => {
        const r = await repoWithFeature();
        await r.squashMerge("feat/x");
        const wt = await r.worktreeAdd({ name: "wt-nogit", ref: "feat/x" });
        rmSync(join(wt, ".git"), { force: true });

        const ctx = await pruneCtxFor(r);
        const byPath = await collectRefReport(ctx, wt);
        expect(byPath).toMatchObject({ kind: "path", branch: "feat/x", verdict: "MERGED", dirty: 0 });
        expect(byPath.prunable).not.toBeNull();

        const { plans } = await planPrune(ctx, ["feat/x"]);
        const [outcome] = await executePrune(ctx, plans);
        expect(outcome).toMatchObject({ removedWorktree: wt, leftFolder: wt, failures: [] });
        expect(outcome.deletedBranch?.name).toBe("feat/x");
        expect((await listWorktrees(r.dir)).some((w) => w.path === wt)).toBe(false);
        expect(existsSync(wt)).toBe(true);
    });
});

describe("pure verdict", () => {
    it("decides the cheap tiers and groups raw changes by path", () => {
        expect(quickVerdict({ ahead: 0, atBase: true, cherryPlus: 0 })?.verdict).toBe("EMPTY");
        expect(quickVerdict({ ahead: 0, atBase: false, cherryPlus: 0 })?.how).toBe("ancestor");
        expect(quickVerdict({ ahead: 2, atBase: false, cherryPlus: 0 })?.how).toBe("cherry");
        expect(quickVerdict({ ahead: 2, atBase: false, cherryPlus: 1 })).toBeNull();

        const blobs = historicBlobsOf([
            { commit: "c1", oldMode: "0", newMode: "0", oldSha: "0", newSha: "1111", status: "M", path: "a.txt" },
            { commit: "c2", oldMode: "0", newMode: "0", oldSha: "1111", newSha: "2222", status: "M", path: "a.txt" },
            { commit: "c2", oldMode: "0", newMode: "0", oldSha: "0", newSha: "3333", status: "A", path: "b.txt" },
        ]);
        expect(blobs.get("a.txt")).toEqual(new Set(["1111", "2222"]));

        const result = contentVerdict({
            changes: [
                { status: "M", path: "a.txt" },
                { status: "A", path: "b.txt" },
                { status: "D", path: "gone.txt" },
                { status: "D", path: "still.txt" },
            ],
            branchBlobs: new Map([
                ["a.txt", "2222"],
                ["b.txt", "9999"],
            ]),
            baseBlobs: new Map([["still.txt", "abcd"]]),
            historicBlobs: blobs,
        });
        expect(result.verdict).toBe("UNMERGED");
        expect(result.unmerged.map((u) => u.path)).toEqual(["b.txt", "still.txt"]);
    });
});

describe("CLI", () => {
    it("prints JSON with the base and per-ref verdicts and exits 1 on an unmerged ref", async () => {
        const r = await repo();
        await feature(r, "feat/merged", "feat/open");
        await r.squashMerge("feat/merged");

        const proc = Bun.spawn(
            [
                "bun",
                join(import.meta.dir, "../../index.ts"),
                "merged",
                "--json",
                "-C",
                r.dir,
                "feat/merged",
                "feat/open",
            ],
            { stdout: "pipe", stderr: "pipe", env: hermeticGitEnv() }
        );
        const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
        expect(code).toBe(1);
        const parsed = SafeJSON.parse(stdout, { strict: true });
        expect(parsed.base.ref).toBe("master");
        expect(parsed.reports.map((x: { ref: string; verdict: string }) => [x.ref, x.verdict])).toEqual([
            ["feat/merged", "MERGED"],
            ["feat/open", "UNMERGED"],
        ]);
    });

    it("exits 2 with no refs and no --all", async () => {
        const r = await repo();
        const proc = Bun.spawn(["bun", join(import.meta.dir, "../../index.ts"), "merged", "-C", r.dir], {
            stdout: "pipe",
            stderr: "pipe",
            env: hermeticGitEnv(),
        });
        expect(await proc.exited).toBe(2);
    });
});

describe("review round 1", () => {
    it("credits a blob that master only ever held through a merge commit's conflict resolution", async () => {
        const r = await repo();
        await commitsOnCheckout(r, [{ files: { "x.txt": "seed x\n" }, message: "seed x" }]);
        await r.importCommits([
            {
                branch: "feat/x",
                from: "refs/heads/master",
                commits: [{ files: { "x.txt": "resolved\n" }, message: "feature resolves x" }],
            },
            {
                branch: "other",
                from: "refs/heads/master",
                commits: [{ files: { "x.txt": "other\n" }, message: "other edits x" }],
            },
        ]);
        await commitsOnCheckout(r, [{ files: { "x.txt": "master\n" }, message: "master edits x" }]);
        await r.git(["merge", "-q", "other"], { allowFail: true });
        r.write({ file: "x.txt", content: "resolved\n" });
        await r.git(["add", "x.txt"]);
        await r.git(["commit", "-q", "-m", "merge other, resolved like the feature"], { epoch: r.tick() });
        await r.commit({ file: "x.txt", content: "later\n", message: "master moves x again" });

        const report = await collectRefReport(await ctxFor(r), "feat/x");
        expect(report.how).toBe("content");
        expect(report.verdict).toBe("MERGED");
    });

    it("checks a deleted path against the base the PR names, not the run base", async () => {
        const r = await repo();
        await commitsOnCheckout(r, [{ files: { "f.txt": "f\n" }, message: "add f" }]);
        await r.importCommits([
            {
                branch: "feat/parent",
                from: "refs/heads/master",
                commits: [{ files: { "p.txt": "p\n" }, message: "parent work" }],
            },
            {
                branch: "feat/child",
                from: "refs/heads/feat/parent",
                commits: [
                    { deletes: ["f.txt"], message: "child drops f" },
                    { files: { "child.txt": "child\n" }, message: "child work" },
                ],
            },
        ]);
        await r.checkout("feat/parent");
        await r.squashMerge("feat/child");
        await r.checkout("master");

        const ctx = await ctxFor(r);
        const pr: PrInfo = { number: 4, state: "OPEN", target: "feat/parent", url: "u" };
        const report = await collectRefReport(
            {
                ...ctx,
                baseFor: async () => ({ ref: "feat/parent", source: "pr", detail: "OPEN PR #4", pr }),
            },
            "feat/child"
        );
        expect(report.unmerged.map((u) => u.path)).toEqual([]);
        expect(report.verdict).toBe("MERGED");
    });

    it("refuses a branch that moved after confirmation before removing its worktree", async () => {
        const r = await repoWithFeature();
        await r.squashMerge("feat/x");
        const wt = await r.worktreeAdd({ name: "wt-moved", ref: "feat/x" });
        const ctx = await pruneCtxFor(r);
        const { plans } = await planPrune(ctx, ["feat/x"]);
        const approved = plans[0].tipSha;

        await r.commit({ file: "late.txt", content: "late\n", message: "late branch work", cwd: wt });
        const moved = await r.sha("feat/x");
        const outcomes = await executePrune(ctx, plans);

        expect(moved).not.toBe(approved);
        expect(outcomes[0].removedWorktree).toBeNull();
        expect(outcomes[0].deletedBranch).toBeNull();
        expect(outcomes[0].failures.join("\n")).toContain("moved after confirmation");
        expect(existsSync(wt)).toBe(true);
        expect(await r.sha("feat/x")).toBe(moved);
    });

    it("preserves a branch checked out in a new worktree after confirmation", async () => {
        const r = await repoWithFeature();
        await r.squashMerge("feat/x");
        const ctx = await pruneCtxFor(r);
        const { plans } = await planPrune(ctx, ["feat/x"]);
        const expected = plans[0].tipSha;
        if (!expected) {
            throw new Error("prune plan did not retain the confirmed branch SHA");
        }

        const lateWorktree = await r.worktreeAdd({ name: "wt-late", ref: "feat/x" });
        const outcomes = await executePrune(ctx, plans);

        expect(outcomes[0].deletedBranch).toBeNull();
        expect(outcomes[0].failures.join("\n")).toContain(`checked out in ${lateWorktree}`);
        expect(await r.sha("feat/x")).toBe(expected);
        expect(existsSync(lateWorktree)).toBe(true);
    });

    it("a remote lease preserves work pushed after confirmation", async () => {
        const r = await repo();
        await feature(r, "feat/remote-moved");
        await r.addOrigin(["feat/remote-moved"]);
        await r.squashMerge("feat/remote-moved");
        await r.git(["branch", "-D", "feat/remote-moved"]);
        const ctx = await pruneCtxFor(r, {
            remote: true,
            driver: { kind: "github", prForHead: async () => ({ pr: null, error: null }) },
            policyFor: () => ({ push: "allowed", matchedBy: "catchAll" }),
        });
        const { plans } = await planPrune(ctx, ["origin/feat/remote-moved"]);
        const approved = plans[0].remoteSha;

        await r.importCommits({
            branch: "late-remote",
            from: "refs/remotes/origin/feat/remote-moved",
            commits: [{ files: { "late-remote.txt": "late\n" }, message: "late remote work" }],
        });
        await r.git(["push", "origin", "late-remote:refs/heads/feat/remote-moved"]);
        const moved = (await r.git(["ls-remote", "--heads", "origin", "feat/remote-moved"])).split(/\s+/)[0];
        const outcomes = await executePrune(ctx, plans);

        expect(moved).not.toBe(approved);
        expect(outcomes[0].deletedRemote).toBeNull();
        expect(outcomes[0].failures.join("\n")).toContain("leased remote delete");
        expect(await r.git(["ls-remote", "--heads", "origin", "feat/remote-moved"])).toContain(moved);
    });

    it("prunes a worktree whose directory vanished without failing and keeps pruning the rest", async () => {
        const r = await repo();
        await feature(r, "feat/gone", "feat/fine");
        await r.squashMerge("feat/gone");
        await r.squashMerge("feat/fine");
        const wt = await r.worktreeAdd({ name: "wt-gone", ref: "feat/gone" });
        const ctx = await pruneCtxFor(r);
        const { plans } = await planPrune(ctx, ["feat/gone", "feat/fine"]);
        expect(plans).toHaveLength(2);

        rmSync(wt, { recursive: true, force: true });
        const outcomes = await executePrune(ctx, plans);
        expect(outcomes[0]).toMatchObject({ removedWorktree: wt, deletedBranch: { name: "feat/gone" }, failures: [] });
        expect(outcomes[1]).toMatchObject({ deletedBranch: { name: "feat/fine" }, failures: [] });
        expect(await r.git(["worktree", "list", "--porcelain"])).not.toContain("wt-gone");
    });
});

describe("judge round 1", () => {
    it("keeps the remote when the PR lookup fails, and says so", async () => {
        const r = await repoWithFeature();
        await r.addOrigin(["feat/x"]);
        await r.squashMerge("feat/x");
        const driver: OriginDriver = {
            kind: "github",
            prForHead: async () => ({ pr: null, error: "gh: command not found" }),
        };
        const ctx = await pruneCtxFor(r, { remote: true, driver });
        const { plans } = await planPrune(ctx, ["feat/x"]);
        expect(plans).toHaveLength(1);
        expect(plans[0].remoteBranch).toBeNull();
        expect(plans[0].warnings.join("\n")).toContain("PR lookup failed");

        const outcomes = await executePrune(ctx, plans);
        expect(outcomes[0].deletedRemote).toBeNull();
        expect(await r.git(["ls-remote", "--heads", "origin", "feat/x"])).toContain("feat/x");
    });

    it("credits a blob the base tip holds right now even when the history walk missed it", () => {
        const result = contentVerdict({
            changes: [{ status: "M", path: "a.txt" }],
            branchBlobs: new Map([["a.txt", "2222"]]),
            baseBlobs: new Map([["a.txt", "2222"]]),
            historicBlobs: new Map(),
        });
        expect(result).toEqual({ verdict: "MERGED", how: "content", unmerged: [] });
    });

    it("--prune --yes on an inferred base proceeds but names the inference", async () => {
        const r = await repoWithFeature();
        await r.squashMerge("feat/x");
        const proc = Bun.spawn(
            ["bun", join(import.meta.dir, "../../index.ts"), "merged", "--prune", "feat/x", "--yes", "-C", r.dir],
            { stdout: "pipe", stderr: "pipe", env: hermeticGitEnv() }
        );
        const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
        expect(code).toBe(0);
        expect(stderr).toContain("base was inferred");
        expect(await r.git(["rev-parse", "--verify", "--quiet", "refs/heads/feat/x"], { allowFail: true })).toBe("");
    });
});
