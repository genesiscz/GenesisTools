import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { listWorktrees, type OriginDriver, type PrInfo } from "@genesiscz/utils/git";
import { hermeticGitEnv, TEST_REPO_EPOCH, TestRepo } from "@genesiscz/utils/git/test-repo";
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

async function repo(): Promise<TestRepo> {
    const r = await TestRepo.create({ prefix: "gt-merged-" });
    repos.push(r);
    return r;
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

/** A two-commit feature branch off master with content unique to its name; returns to master. */
async function feature(r: TestRepo, name = "feat/x"): Promise<void> {
    const tag = name.replace(/[^a-z0-9]+/gi, "-");
    await r.checkout(name, { create: true });
    await r.commit({ file: `${tag}-a.txt`, content: `alpha ${tag}\n`, message: `add alpha ${tag}` });
    await r.commit({ file: `${tag}-b.txt`, content: `beta ${tag}\n`, message: `add beta ${tag}` });
    await r.checkout("master");
}

describe("verdict ladder", () => {
    it("EMPTY when the branch has nothing of its own", async () => {
        const r = await repo();
        await r.branch("feat/empty");
        const report = await collectRefReport(await ctxFor(r), "feat/empty");
        expect(report).toMatchObject({ verdict: "EMPTY", how: "-", ahead: 0, touched: null });
    });

    it("MERGED by ancestor after a fast-forward merge, EMPTY when sitting exactly on the base", async () => {
        const r = await repo();
        await feature(r);
        await r.git(["merge", "-q", "--ff-only", "feat/x"]);
        const atBase = await collectRefReport(await ctxFor(r), "feat/x");
        expect(atBase).toMatchObject({ verdict: "EMPTY", how: "-", ahead: 0 });

        await r.commit({ file: "m.txt", content: "master moved\n", message: "master moves" });
        const report = await collectRefReport(await ctxFor(r), "feat/x");
        expect(report).toMatchObject({ verdict: "MERGED", how: "ancestor", ahead: 0, behind: 1 });
    });

    it("MERGED by cherry when the commits were cherry-picked with new shas", async () => {
        const r = await repo();
        await feature(r);
        await r.commit({ file: "m.txt", content: "master moved\n", message: "master moves" });
        await r.git(["cherry-pick", "master..feat/x"], { epoch: r.tick() });
        const report = await collectRefReport(await ctxFor(r), "feat/x");
        expect(report).toMatchObject({ verdict: "MERGED", how: "cherry", ahead: 2, cherryPlus: 0 });
    });

    it("MERGED by content after a squash merge, even once master moved on", async () => {
        const r = await repo();
        await feature(r);
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
        await r.checkout("feat/three", { create: true });
        await r.commit({ file: "a.txt", content: "a1\n", message: "a first" });
        await r.commit({ file: "a.txt", content: "a2\n", message: "a second" });
        await r.commit({ file: "c.txt", content: "c\n", message: "c" });
        await r.checkout("master");
        await r.commitMany({ files: { "a.txt": "a2\n" }, message: "recomposed: a" });
        await r.commit({ file: "c.txt", content: "c\n", message: "recomposed: c" });
        await r.commit({ file: "m.txt", content: "later\n", message: "master moves" });

        const report = await collectRefReport(await ctxFor(r), "feat/three");
        expect(report).toMatchObject({ verdict: "MERGED", how: "content", ahead: 3 });
    });

    it("UNMERGED listing the one file whose snapshot version never landed", async () => {
        const r = await repo();
        await r.checkout("feat/pr", { create: true });
        await r.commit({ file: "a.txt", content: "v1\n", message: "a v1" });
        await r.commit({ file: "b.txt", content: "b\n", message: "b" });
        await r.branch("backup/snapshot");
        await r.commit({ file: "a.txt", content: "v2\n", message: "a v2" });
        await r.checkout("master");
        await r.squashMerge("feat/pr");

        const pr = await collectRefReport(await ctxFor(r), "feat/pr");
        expect(pr.verdict).toBe("MERGED");

        const snapshot = await collectRefReport(await ctxFor(r), "backup/snapshot");
        expect(snapshot).toMatchObject({ verdict: "UNMERGED", how: "none", touched: 2 });
        expect(snapshot.unmerged).toEqual([{ path: "a.txt", status: "A", insertions: 1, deletions: 1 }]);
        expect(snapshot.commands).toEqual([]);
    });

    it("treats a deleted path as merged only when the base no longer has it", async () => {
        const r = await repo();
        await r.commit({ file: "old.txt", content: "old\n", message: "add old" });
        await r.checkout("feat/del", { create: true });
        await r.commitDelete({ file: "old.txt" });
        await r.commit({ file: "new.txt", content: "new\n", message: "add new" });
        await r.checkout("master");

        const before = await collectRefReport(await ctxFor(r), "feat/del");
        expect(before.verdict).toBe("UNMERGED");
        expect(before.unmerged.map((u) => `${u.status} ${u.path}`)).toEqual(["A new.txt", "D old.txt"]);

        await r.squashMerge("feat/del");
        const after = await collectRefReport(await ctxFor(r), "feat/del");
        expect(after).toMatchObject({ verdict: "MERGED", how: "content" });
    });

    it("handles binary files by blob id and reports them as 0/0 when unmerged", async () => {
        const r = await repo();
        await r.checkout("feat/bin", { create: true });
        await r.commit({ file: "blob.dat", content: "\u0000\u0001\u0002binary\u0000\n", message: "add binary" });
        await r.checkout("master");

        const before = await collectRefReport(await ctxFor(r), "feat/bin");
        expect(before.unmerged).toEqual([{ path: "blob.dat", status: "A", insertions: 0, deletions: 0 }]);

        await r.squashMerge("feat/bin");
        expect((await collectRefReport(await ctxFor(r), "feat/bin")).verdict).toBe("MERGED");
    });

    it("does not penalise a branch far behind the base", async () => {
        const r = await repo();
        await feature(r);
        await r.squashMerge("feat/x");

        for (let i = 0; i < 30; i++) {
            await r.commit({ file: `m${i}.txt`, content: `${i}\n`, message: `master ${i}` });
        }

        const report = await collectRefReport(await ctxFor(r), "feat/x");
        expect(report).toMatchObject({ verdict: "MERGED", how: "content", behind: 31 });
    });

    it("parses paths with spaces and non-ASCII characters", async () => {
        const r = await repo();
        await r.checkout("feat/unicode", { create: true });
        await r.commit({ file: "dir/ná me.txt", content: "čau\n", message: "add unicode path" });
        await r.commit({ file: "dir/ná me.txt", content: "čau znovu\n", message: "edit unicode path" });
        await r.checkout("master");
        await r.squashMerge("feat/unicode");
        await r.commit({ file: "m.txt", content: "m\n", message: "master moves" });
        const report = await collectRefReport(await ctxFor(r), "feat/unicode");
        expect(report).toMatchObject({ verdict: "MERGED", how: "content", touched: 1 });
    });

    it("judges a worktree by path, detached or on a branch, and counts dirt", async () => {
        const r = await repo();
        await feature(r);
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
        const r = await repo();
        await feature(r);
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
        await r.checkout("feat/child", { create: true });
        await r.git(["reset", "-q", "--hard", "feat/parent"]);
        await r.commit({ file: "child.txt", content: "child\n", message: "child work" });
        await r.checkout("master");

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
        const r = await repo();
        await feature(r);
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
        await feature(r, "feat/unmerged");
        await feature(r, "feat/dirty");
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
        const r = await repo();
        await feature(r);
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
        await feature(r, "feat/open");
        await feature(r, "feat/never");
        await feature(r, "feat/ok");
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
        expect(outcomes.map((o) => o.deletedRemote)).toEqual([null, null, "feat/ok"]);
        const remoteHeads = await r.git(["ls-remote", "--heads", "origin"]);
        expect(remoteHeads).toContain("feat/open");
        expect(remoteHeads).toContain("feat/never");
        expect(remoteHeads).not.toContain("feat/ok");
    });

    it("refuses to force-remove a worktree holding real edits, but clears deletion debris", async () => {
        const r = await repo();
        await feature(r);
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
        await feature(r, "feat/merged");
        await feature(r, "feat/open");
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
        await r.commit({ file: "x.txt", content: "seed x\n", message: "seed x" });
        await r.checkout("feat/x", { create: true });
        await r.commit({ file: "x.txt", content: "resolved\n", message: "feature resolves x" });
        await r.checkout("master");
        await r.checkout("other", { create: true });
        await r.commit({ file: "x.txt", content: "other\n", message: "other edits x" });
        await r.checkout("master");
        await r.commit({ file: "x.txt", content: "master\n", message: "master edits x" });
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
        await r.commit({ file: "f.txt", content: "f\n", message: "add f" });
        await r.checkout("feat/parent", { create: true });
        await r.commit({ file: "p.txt", content: "p\n", message: "parent work" });
        await r.checkout("feat/child", { create: true });
        await r.commitDelete({ file: "f.txt", message: "child drops f" });
        await r.commit({ file: "child.txt", content: "child\n", message: "child work" });
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

    it("prunes a worktree whose directory vanished without failing and keeps pruning the rest", async () => {
        const r = await repo();
        await feature(r, "feat/gone");
        await feature(r, "feat/fine");
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
        const r = await repo();
        await feature(r, "feat/x");
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
        const r = await repo();
        await feature(r, "feat/x");
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
