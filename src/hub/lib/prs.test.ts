import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { CommandRunner } from "@genesiscz/utils/git/origins";
import { TestRepo } from "@genesiscz/utils/git/test-repo";
import { SafeJSON } from "@genesiscz/utils/json";
import { hubPr, hubPrs, PrRefError, parsePrRef } from "./prs";
import { repoFacts } from "./repo";

const repos: TestRepo[] = [];

afterEach(() => {
    for (const repo of repos.splice(0)) {
        repo.cleanup();
    }
});

const GH_ROW = {
    number: 7,
    title: "Add x",
    state: "OPEN",
    isDraft: false,
    author: { login: "alice" },
    headRefName: "feat/x",
    baseRefName: "master",
    url: "https://github.com/o/r/pull/7",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
};

/** Answers `gh pr list`, `gh pr view` and `gh api user`; records every call. */
function fakeGh(calls: string[][]): CommandRunner {
    return async (cmd) => {
        calls.push(cmd);

        if (cmd[1] === "api") {
            return { code: 0, stdout: SafeJSON.stringify({ login: "alice" }), stderr: "" };
        }

        const body = cmd[2] === "view" ? { ...GH_ROW, body: "why", commits: [] } : [GH_ROW];
        return { code: 0, stdout: SafeJSON.stringify(body), stderr: "" };
    };
}

describe("parsePrRef", () => {
    it("accepts a URL or <repoPath>#<number>", () => {
        expect(parsePrRef("https://github.com/o/r/pull/7")).toEqual({ url: "https://github.com/o/r/pull/7" });
        expect(parsePrRef("/work/r#12")).toEqual({ path: "/work/r", number: 12 });
        expect(parsePrRef("/work/r")).toBeNull();
    });
});

describe("repoFacts", () => {
    it("reports a checkout whose branch has no commits yet, with its branch and origin", async () => {
        const repo = await TestRepo.create({ prefix: "gt-review-prs-", branch: "feat/x", seed: false });
        repos.push(repo);
        await repo.git(["remote", "add", "origin", "git@github.com:o/r.git"]);

        const facts = await repoFacts({ path: repo.dir });

        expect(facts).toMatchObject({
            root: repo.dir,
            repo: "repo",
            branch: "feat/x",
            head: null,
            origin: { kind: "github", web: "https://github.com/o/r" },
            branchUrl: "https://github.com/o/r/tree/feat/x",
            headUrl: null,
        });
    });
});

describe("hubPrs / hubPr", () => {
    it("counts a project once across its worktrees, maps the local worktree and skips non-git paths", async () => {
        const repo = await TestRepo.create({ prefix: "gt-review-prs-" });
        repos.push(repo);
        await repo.git(["remote", "add", "origin", "git@github.com:o/r.git"]);
        const worktree = join(repo.root, "wt-x");
        await repo.git(["worktree", "add", "-b", "feat/x", worktree]);
        const calls: string[][] = [];

        const result = await hubPrs({ paths: [repo.dir, worktree, repo.root], runner: fakeGh(calls) });

        expect(result.skipped).toEqual([{ path: repo.root, reason: "not a git checkout" }]);
        expect(result.repos).toHaveLength(1);
        expect(result.repos[0]).toMatchObject({
            repoRoot: repo.dir,
            paths: [repo.dir, worktree],
            count: 1,
            error: null,
        });
        expect(result.prs[0]).toMatchObject({
            repoRoot: repo.dir,
            origin: { kind: "github", host: "github.com", web: "https://github.com/o/r" },
            number: 7,
            localWorktree: worktree,
            isMine: true,
        });
        expect(calls.filter((cmd) => cmd[2] === "list")).toHaveLength(1);
        const readOnly = (cmd: string[]) =>
            (cmd[1] === "pr" && ["list", "view"].includes(cmd[2])) || (cmd[1] === "api" && cmd.at(-1) === "user");
        expect(calls.every(readOnly)).toBe(true);

        const detail = await hubPr({ ref: `${worktree}#7`, runner: fakeGh(calls) });
        expect(detail).toMatchObject({ number: 7, body: "why", repoRoot: repo.dir, localWorktree: worktree });
    });

    it("reports a failed lookup per project instead of dropping it", async () => {
        const repo = await TestRepo.create({ prefix: "gt-review-prs-" });
        repos.push(repo);
        await repo.git(["remote", "add", "origin", "git@github.com:o/r.git"]);
        const failing: CommandRunner = async () => ({ code: 1, stdout: "", stderr: "gh: auth required" });

        const result = await hubPrs({ paths: [repo.dir], runner: failing });

        expect(result.prs).toEqual([]);
        expect(result.repos[0]).toMatchObject({ count: 0, error: "gh: auth required" });
        await expect(hubPr({ ref: "https://github.com/o/r/pull/7", runner: failing })).rejects.toThrow(PrRefError);
    });
});
