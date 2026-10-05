import { afterEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandRunner } from "@genesiscz/utils/git/origins";
import { TestRepo } from "@genesiscz/utils/git/test-repo";
import { SafeJSON } from "@genesiscz/utils/json";
import { setupStorageSandbox } from "@genesiscz/utils/storage/test-sandbox";
import { hubPr, hubPrs, missingCommits, PrRefError } from "./prs";

setupStorageSandbox();

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

        // A date range reaches the host as update order cut at the bound, not the newest 30 PRs by creation.
        const ranged: string[][] = [];
        const graph: CommandRunner = async (cmd) => {
            ranged.push(cmd);
            const node = { ...GH_ROW, updatedAt: "2026-03-02T00:00:00Z", labels: { nodes: [] } };
            const answer =
                cmd[2] === "graphql"
                    ? { data: { repository: { pullRequests: { nodes: [node] } } } }
                    : { login: "alice" };
            return { code: 0, stdout: SafeJSON.stringify(answer), stderr: "" };
        };
        const bounded = await hubPrs({
            paths: [repo.dir],
            runner: graph,
            updatedSince: new Date("2026-03-01T10:00:00Z"),
        });
        expect(bounded.prs.map((pr) => pr.number)).toEqual([7]);
        const query = ranged.find((cmd) => cmd[2] === "graphql") ?? [];
        expect(query.slice(0, 5)).toEqual(["gh", "api", "graphql", "--hostname", "github.com"]);
        expect(query.join(" ")).toContain("orderBy: {field: UPDATED_AT, direction: DESC}");
        expect(ranged.some((cmd) => cmd[2] === "list")).toBe(false);

        const detail = await hubPr({ ref: `${worktree}#7`, runner: fakeGh(calls) });
        expect(detail).toMatchObject({ number: 7, body: "why", repoRoot: repo.dir, localWorktree: worktree });
    });

    it("passes the search query to the host", async () => {
        const repo = await TestRepo.create({ prefix: "gt-review-prs-" });
        repos.push(repo);
        await repo.git(["remote", "add", "origin", "git@github.com:o/r.git"]);
        const calls: string[][] = [];

        const result = await hubPrs({ paths: [repo.dir], query: "!7", runner: fakeGh(calls) });

        expect(result.prs.map((pr) => pr.number)).toEqual([7]);
        expect(calls.some((cmd) => cmd[2] === "view" && cmd[3] === "7")).toBe(true);
        expect(calls.some((cmd) => cmd[2] === "list")).toBe(false);
    });

    it("answers fresh by default and serves a stored answer only within --max-cache-age", async () => {
        const repo = await TestRepo.create({ prefix: "gt-review-prs-" });
        repos.push(repo);
        await repo.git(["remote", "add", "origin", "git@github.com:o/r.git"]);
        const calls: string[][] = [];
        const lists = () => calls.filter((cmd) => cmd[2] === "list").length;
        const views = () => calls.filter((cmd) => cmd[2] === "view").length;

        await hubPrs({ paths: [repo.dir], runner: fakeGh(calls) });
        await hubPrs({ paths: [repo.dir], runner: fakeGh(calls) });
        expect(lists()).toBe(2);
        expect((await hubPrs({ paths: [repo.dir], maxCacheAgeSeconds: 300, runner: fakeGh(calls) })).prs).toHaveLength(
            1
        );
        expect(lists()).toBe(2);
        await hubPrs({ paths: [repo.dir], state: "all", maxCacheAgeSeconds: 300, runner: fakeGh(calls) });
        expect(lists()).toBe(3);

        const ref = "https://github.com/o/r/pull/7";
        await hubPr({ ref, runner: fakeGh(calls) });
        expect((await hubPr({ ref, maxCacheAgeSeconds: 300, runner: fakeGh(calls) })).number).toBe(7);
        expect(views()).toBe(1);
        // GH_ROW carries no head sha, so a caller that knows one is never served the stored answer.
        await hubPr({ ref, maxCacheAgeSeconds: 300, headSha: "abc123", runner: fakeGh(calls) });
        expect(views()).toBe(2);
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
describe("missingCommits", () => {
    it("names the commits the repository lacks and none it holds", async () => {
        const repo = await TestRepo.create({ prefix: "gt-review-prs-" });
        repos.push(repo);
        const head = Bun.spawnSync(["git", "-C", repo.dir, "rev-parse", "HEAD"], { env: process.env })
            .stdout.toString()
            .trim();

        const gone = await missingCommits(repo.dir, [head, "0".repeat(40)]);

        expect([...(gone ?? [])]).toEqual([1]);
    });

    it("answers null instead of waiting forever when git hangs, so no worktree is dropped on a guess", async () => {
        const repo = await TestRepo.create({ prefix: "gt-review-prs-" });
        repos.push(repo);
        const stuck = join(repo.dir, "stuck-git");
        writeFileSync(stuck, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
        const started = Date.now();

        const gone = await missingCommits(repo.dir, ["0".repeat(40)], { timeoutMs: 300, git: stuck });

        expect(gone).toBeNull();
        expect(Date.now() - started).toBeLessThan(5000);
    });

    it("answers null when git exits with an error", async () => {
        const gone = await missingCommits("/nonexistent-gt-repo-path", ["0".repeat(40)]);

        expect(gone).toBeNull();
    });
});
