import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyBranches, detectBase, getCurrentBranch } from "./classify";

const SECONDS_PER_DAY = 86_400;
// Fixed wall-clock anchor so every committed date is deterministic.
const ANCHOR_EPOCH = 1_700_000_000;

// Hermetic git env: no global/system config (gpgsign, templateDir, hooks),
// fixed identity. Bun.spawn snapshots env at process start and ignores later
// process.env mutations, so we MUST pass this explicitly on every spawn — the
// repo-building git() helper below does exactly that.
const BASE_GIT_ENV = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
};

/** Direct git spawner that controls env (config isolation + commit dates). */
async function git(cwd: string, args: string[], epoch?: number): Promise<string> {
    const env =
        epoch === undefined
            ? BASE_GIT_ENV
            : { ...BASE_GIT_ENV, GIT_AUTHOR_DATE: `${epoch} +0000`, GIT_COMMITTER_DATE: `${epoch} +0000` };

    const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env });
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    if (code !== 0) {
        throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr.trim()}`);
    }

    return stdout.trim();
}

/** Commit a file at a fixed epoch so committer dates are deterministic. */
async function commit(cwd: string, file: string, content: string, epoch: number): Promise<void> {
    writeFileSync(join(cwd, file), content);
    await git(cwd, ["add", file]);
    await git(cwd, ["commit", "-q", "-m", `commit ${file}@${epoch}`], epoch);
}

async function makeRepo(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "branch-gc-"));
    await git(dir, ["init", "-q", "-b", "master"]);
    await commit(dir, "base.txt", "base\n", ANCHOR_EPOCH);
    return dir;
}

describe("classifyBranches", () => {
    it("detects a real merge as `merged`", async () => {
        const dir = await makeRepo();
        try {
            await git(dir, ["checkout", "-q", "-b", "feat/merged"]);
            await commit(dir, "f.txt", "feature\n", ANCHOR_EPOCH + 10);
            await git(dir, ["checkout", "-q", "master"]);
            await git(dir, ["merge", "--no-ff", "-q", "-m", "merge feat", "feat/merged"], ANCHOR_EPOCH + 15);

            const infos = await classifyBranches({
                cwd: dir,
                base: "master",
                current: "master",
                nowEpoch: ANCHOR_EPOCH + 20,
                staleDays: 90,
            });
            const feat = infos.find((b) => b.name === "feat/merged");
            expect(feat?.status).toBe("merged");
            expect(feat?.deletable).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("detects a squash-merge as `squash-merged` (where plain `git cherry` misses it)", async () => {
        const dir = await makeRepo();
        try {
            await git(dir, ["checkout", "-q", "-b", "feat/squashed"]);
            await commit(dir, "a.txt", "alpha\n", ANCHOR_EPOCH + 10);
            await commit(dir, "b.txt", "beta\n", ANCHOR_EPOCH + 20);
            // Squash-merge into master without a merge commit. Master tip stays
            // at the merge-base before this, so the combined patch matches.
            await git(dir, ["checkout", "-q", "master"]);
            await git(dir, ["merge", "--squash", "feat/squashed"]);
            await git(dir, ["commit", "-q", "-m", "squashed feat"], ANCHOR_EPOCH + 30);

            // Prove the naive heuristic fails: per-commit cherry sees the
            // branch's two commits as NOT present (leading "+").
            const cherry = await git(dir, ["cherry", "master", "feat/squashed"]);
            const cherryLines = cherry.split("\n").filter((l) => l.trim().length > 0);
            expect(cherryLines.length).toBeGreaterThan(0);
            expect(cherryLines.every((l) => l.startsWith("+"))).toBe(true);

            const infos = await classifyBranches({
                cwd: dir,
                base: "master",
                current: "master",
                nowEpoch: ANCHOR_EPOCH + 40,
                staleDays: 90,
            });
            const feat = infos.find((b) => b.name === "feat/squashed");
            expect(feat?.status).toBe("squash-merged");
            expect(feat?.deletable).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("classifies a genuinely unmerged recent branch as `active`", async () => {
        const dir = await makeRepo();
        try {
            await git(dir, ["checkout", "-q", "-b", "feat/wip"]);
            await commit(dir, "wip.txt", "wip\n", ANCHOR_EPOCH + 10);
            await git(dir, ["checkout", "-q", "master"]);

            const infos = await classifyBranches({
                cwd: dir,
                base: "master",
                current: "master",
                nowEpoch: ANCHOR_EPOCH + 20,
                staleDays: 90,
            });
            const feat = infos.find((b) => b.name === "feat/wip");
            expect(feat?.status).toBe("active");
            expect(feat?.deletable).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("flips between `stale` and `active` deterministically across the staleDays boundary", async () => {
        const dir = await makeRepo();
        try {
            const branchEpoch = ANCHOR_EPOCH + 10;
            await git(dir, ["checkout", "-q", "-b", "spike/old"]);
            await commit(dir, "spike.txt", "spike\n", branchEpoch);
            await git(dir, ["checkout", "-q", "master"]);

            const ageDays = 100;
            const nowEpoch = branchEpoch + ageDays * SECONDS_PER_DAY;

            const staleInfos = await classifyBranches({
                cwd: dir,
                base: "master",
                current: "master",
                nowEpoch,
                staleDays: ageDays - 1,
            });
            expect(staleInfos.find((b) => b.name === "spike/old")?.status).toBe("stale");

            const activeInfos = await classifyBranches({
                cwd: dir,
                base: "master",
                current: "master",
                nowEpoch,
                staleDays: ageDays + 1,
            });
            expect(activeInfos.find((b) => b.name === "spike/old")?.status).toBe("active");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("marks the current branch `current` and the base `base`, neither deletable", async () => {
        const dir = await makeRepo();
        try {
            await git(dir, ["checkout", "-q", "-b", "feat/onhead"]);
            await commit(dir, "h.txt", "head\n", ANCHOR_EPOCH + 10);

            const infos = await classifyBranches({
                cwd: dir,
                base: "master",
                current: "feat/onhead",
                nowEpoch: ANCHOR_EPOCH + 20,
                staleDays: 90,
            });
            const current = infos.find((b) => b.name === "feat/onhead");
            const base = infos.find((b) => b.name === "master");
            expect(current?.status).toBe("current");
            expect(current?.deletable).toBe(false);
            expect(base?.status).toBe("base");
            expect(base?.deletable).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("classifies a branch whose upstream was deleted as `gone`", async () => {
        const remote = mkdtempSync(join(tmpdir(), "branch-gc-remote-"));
        const dir = await makeRepo();
        try {
            await git(remote, ["init", "-q", "--bare", "-b", "master"]);
            await git(dir, ["remote", "add", "origin", remote]);
            await git(dir, ["push", "-q", "origin", "master"]);

            // Branch with a tracked, then deleted, upstream.
            await git(dir, ["checkout", "-q", "-b", "feat/gone"]);
            await commit(dir, "g.txt", "gone\n", ANCHOR_EPOCH + 10);
            await git(dir, ["push", "-q", "-u", "origin", "feat/gone"]);
            await git(dir, ["checkout", "-q", "master"]);
            await git(dir, ["push", "-q", "origin", "--delete", "feat/gone"]);
            await git(dir, ["fetch", "-q", "--prune", "origin"]);

            const infos = await classifyBranches({
                cwd: dir,
                base: "master",
                current: "master",
                nowEpoch: ANCHOR_EPOCH + 20,
                staleDays: 90,
            });
            const feat = infos.find((b) => b.name === "feat/gone");
            expect(feat?.status).toBe("gone");
            expect(feat?.deletable).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
            rmSync(remote, { recursive: true, force: true });
        }
    });

    it("reports ahead/behind matching git rev-list --left-right --count", async () => {
        const dir = await makeRepo();
        try {
            // Diverge: 1 commit on master, 2 on the branch off the original base.
            const baseSha = await git(dir, ["rev-parse", "HEAD"]);
            await git(dir, ["checkout", "-q", "-b", "feat/diverged", baseSha]);
            await commit(dir, "x.txt", "x\n", ANCHOR_EPOCH + 10);
            await commit(dir, "y.txt", "y\n", ANCHOR_EPOCH + 20);
            await git(dir, ["checkout", "-q", "master"]);
            await commit(dir, "m.txt", "m\n", ANCHOR_EPOCH + 30);

            const infos = await classifyBranches({
                cwd: dir,
                base: "master",
                current: "master",
                nowEpoch: ANCHOR_EPOCH + 40,
                staleDays: 90,
            });
            const feat = infos.find((b) => b.name === "feat/diverged");
            expect(feat?.ahead).toBe(2);
            expect(feat?.behind).toBe(1);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("detectBase / getCurrentBranch", () => {
    it("auto-detects master and reads the current branch", async () => {
        const dir = await makeRepo();
        try {
            expect(await detectBase(dir)).toBe("master");
            expect(await getCurrentBranch(dir)).toBe("master");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("throws BaseNotFoundError for an explicit base that does not exist", async () => {
        const dir = await makeRepo();
        try {
            await expect(detectBase(dir, "nope")).rejects.toThrow(/does not exist/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("auto-detects main when there is no master", async () => {
        const dir = mkdtempSync(join(tmpdir(), "branch-gc-"));
        try {
            await git(dir, ["init", "-q", "-b", "main"]);
            await commit(dir, "base.txt", "base\n", ANCHOR_EPOCH);
            expect(await detectBase(dir)).toBe("main");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("throws BaseNotFoundError when neither master nor main exists", async () => {
        const dir = mkdtempSync(join(tmpdir(), "branch-gc-"));
        try {
            await git(dir, ["init", "-q", "-b", "trunk"]);
            await commit(dir, "base.txt", "base\n", ANCHOR_EPOCH);
            await expect(detectBase(dir)).rejects.toThrow(/auto-detect a base branch/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("returns '' for getCurrentBranch on a detached HEAD", async () => {
        const dir = await makeRepo();
        try {
            await commit(dir, "second.txt", "second\n", ANCHOR_EPOCH + 10);
            const head = await git(dir, ["rev-parse", "HEAD"]);
            await git(dir, ["checkout", "-q", head]);
            expect(await getCurrentBranch(dir)).toBe("");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
