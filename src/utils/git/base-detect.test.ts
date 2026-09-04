import { afterEach, describe, expect, it } from "bun:test";
import { describeBase, detectBase } from "./base-detect";
import { BaseNotFoundError } from "./core";
import type { OriginDriver, PrInfo } from "./origins/types";
import { TestRepo } from "./test-repo";

const repos: TestRepo[] = [];

afterEach(() => {
    for (const repo of repos.splice(0)) {
        repo.cleanup();
    }
});

async function repo(): Promise<TestRepo> {
    const r = await TestRepo.create({ prefix: "gt-base-detect-" });
    repos.push(r);
    return r;
}

function fakeDriver(pr: PrInfo | null): OriginDriver {
    return { kind: "github", prForHead: async () => ({ pr, error: null }) };
}

describe("detectBase ladder", () => {
    it("returns a verified --base as source flag and throws on one that does not resolve", async () => {
        const r = await repo();
        expect(await detectBase({ cwd: r.dir, flag: "master" })).toMatchObject({ ref: "master", source: "flag" });
        await expect(detectBase({ cwd: r.dir, flag: "nope" })).rejects.toBeInstanceOf(BaseNotFoundError);
    });

    it("takes the PR target when a driver knows one, resolving it to the remote ref", async () => {
        const r = await repo();
        await r.checkout("develop", { create: true });
        await r.commit({ file: "d.txt", content: "d\n" });
        await r.checkout("master");
        await r.addOrigin(["develop"]);
        await r.checkout("feat/x", { create: true });
        await r.commit({ file: "x.txt", content: "x\n" });

        const pr: PrInfo = { number: 4, state: "OPEN", target: "develop", url: "u" };
        const base = await detectBase({ cwd: r.dir, branch: "feat/x", driver: fakeDriver(pr) });
        expect(base).toMatchObject({ ref: "origin/develop", source: "pr", pr });
        expect(describeBase(base)).toBe("origin/develop (pr: OPEN PR #4 targets develop)");
    });

    it("falls past a PR whose target does not exist locally", async () => {
        const r = await repo();
        const pr: PrInfo = { number: 4, state: "OPEN", target: "ghost", url: "u" };
        const base = await detectBase({ cwd: r.dir, branch: "master", driver: fakeDriver(pr) });
        expect(base.source).toBe("inferred");
    });

    it("uses the config's mainPrBranch before anything inferred", async () => {
        const r = await repo();
        await r.checkout("feature/next", { create: true });
        await r.commit({ file: "n.txt", content: "n\n" });
        await r.checkout("master");
        await r.addOrigin(["feature/next"]);

        const base = await detectBase({
            cwd: r.dir,
            branch: "master",
            config: { git: { mainPrBranch: "feature/next" } },
        });
        expect(base).toMatchObject({ ref: "origin/feature/next", source: "config" });
    });

    it("picks the closest declared branch when the config lists several", async () => {
        const r = await repo();
        await r.checkout("develop", { create: true });
        await r.commit({ file: "d.txt", content: "d\n" });
        await r.checkout("feat/from-develop", { create: true });
        await r.commit({ file: "f.txt", content: "f\n" });

        const config = { git: { branches: [{ name: "master" }, { name: "develop" }, { nameRegex: "^release/" }] } };
        const base = await detectBase({ cwd: r.dir, branch: "feat/from-develop", config });
        expect(base).toMatchObject({ ref: "develop", source: "declared" });
        expect(base.detail).toBe("closest declared branch, 1 commits");
    });

    it("infers the closest merge-base over every ref, preferring origin HEAD on a tie", async () => {
        const r = await repo();
        await r.addOrigin();
        await r.checkout("feature/next", { create: true });
        await r.commit({ file: "n.txt", content: "n\n" });
        await r.checkout("feat/child", { create: true });
        await r.commit({ file: "c.txt", content: "c\n" });

        const child = await detectBase({ cwd: r.dir, branch: "feat/child" });
        expect(child).toMatchObject({ ref: "feature/next", source: "inferred" });
        expect(child.detail).toBe("closest merge-base, 1 commits");

        await r.checkout("master");
        await r.checkout("feat/off-master", { create: true });
        await r.commit({ file: "m.txt", content: "m\n" });
        const offMaster = await detectBase({ cwd: r.dir, branch: "feat/off-master" });
        expect(offMaster).toMatchObject({ ref: "origin/master", source: "inferred" });
    });

    it("skips a candidate sitting on the very same commit, such as a backup branch", async () => {
        const r = await repo();
        await r.checkout("feat/x", { create: true });
        await r.commit({ file: "x.txt", content: "x\n" });
        await r.branch("backup/feat-x");
        const base = await detectBase({ cwd: r.dir, branch: "feat/x" });
        expect(base.ref).toBe("master");
    });

    it("a fresh branch sitting exactly on origin/master resolves to origin/master, not to a sibling cut from the same commit", async () => {
        const r = await repo();
        await r.addOrigin();
        await r.checkout("feat/sibling", { create: true });
        await r.commit({ file: "s.txt", content: "s\n" });
        await r.checkout("master");
        await r.checkout("feat/fresh", { create: true });
        const base = await detectBase({ cwd: r.dir, branch: "feat/fresh" });
        expect(base).toMatchObject({ ref: "origin/master", source: "inferred" });
    });

    it("without a branch answers origin HEAD, then a local master, then throws", async () => {
        const withOrigin = await repo();
        await withOrigin.addOrigin();
        expect(await detectBase({ cwd: withOrigin.dir })).toMatchObject({ ref: "origin/master", source: "inferred" });

        const local = await repo();
        expect(await detectBase({ cwd: local.dir })).toMatchObject({ ref: "master", detail: "local master" });

        const trunk = await TestRepo.create({ branch: "trunk", prefix: "gt-base-detect-trunk-" });
        repos.push(trunk);
        await expect(detectBase({ cwd: trunk.dir })).rejects.toBeInstanceOf(BaseNotFoundError);
    });
});
