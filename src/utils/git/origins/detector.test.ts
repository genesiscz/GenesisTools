import { afterEach, describe, expect, it } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { TestRepo } from "../test-repo";
import { classifyOriginUrl, detectOrigin, originDriver } from "./detector";
import { ghDriver, parseGhPrList } from "./gh";
import { glabDriver, parseGlabMrList } from "./glab";
import {
    ghCheckStatus,
    glabPipelineStatus,
    glabPipelinesBySha,
    listPrs,
    parseGhPrRows,
    parseGhPrView,
    parseGlabMrRows,
    parsePrUrl,
    projectRefFromRemote,
    rollupCi,
    viewPr,
} from "./prs";
import type { CommandRunner } from "./types";
import { branchWebUrl, commitWebUrl, originWebBase } from "./web";

const repos: TestRepo[] = [];

afterEach(() => {
    for (const repo of repos.splice(0)) {
        repo.cleanup();
    }
});

async function repoWithOrigin(url: string | null): Promise<TestRepo> {
    const r = await TestRepo.create({ prefix: "gt-origins-" });
    repos.push(r);

    if (url) {
        await r.git(["remote", "add", "origin", url]);
    }

    return r;
}

describe("classifyOriginUrl", () => {
    it("recognises GitHub in every URL shape", () => {
        for (const url of [
            "git@github.com:genesiscz/GenesisTools.git",
            "ssh://git@github.com/genesiscz/GenesisTools.git",
            "https://github.com/genesiscz/GenesisTools",
            "https://user@github.com/genesiscz/GenesisTools.git",
            "GITHUB.COM:o/r",
        ]) {
            expect(classifyOriginUrl(url)).toMatchObject({ kind: "github", host: "github.com" });
        }
    });

    it("recognises any GitLab host, including self-hosted ones with a port", () => {
        expect(classifyOriginUrl("git@gitlab.com:g/p.git")).toMatchObject({ kind: "gitlab", host: "gitlab.com" });
        expect(classifyOriginUrl("ssh://git@gitlab.internal.example:2222/g/sub/p.git")).toMatchObject({
            kind: "gitlab",
            host: "gitlab.internal.example",
        });
        expect(classifyOriginUrl("https://gitlab.internal.example/g/p")).toMatchObject({ kind: "gitlab" });
    });

    it("has no driver for other hosts or unparsable strings", () => {
        expect(classifyOriginUrl("https://dev.azure.com/org/proj/_git/repo")).toMatchObject({
            kind: null,
            host: "dev.azure.com",
        });
        expect(classifyOriginUrl("git@bitbucket.org:t/r.git").kind).toBeNull();
        expect(classifyOriginUrl("../local/path.git")).toEqual({ url: "../local/path.git", host: null, kind: null });
        expect(classifyOriginUrl("/abs/path.git").host).toBeNull();
    });
});

describe("detectOrigin / originDriver", () => {
    it("returns null without an origin remote", async () => {
        const r = await repoWithOrigin(null);
        expect(await detectOrigin(r.dir)).toBeNull();
        expect(await originDriver(r.dir)).toBeNull();
    });

    it("picks the gh driver for GitHub and the glab driver for GitLab", async () => {
        const gh = await repoWithOrigin("git@github.com:o/r.git");
        expect((await originDriver(gh.dir))?.kind).toBe("github");

        const gl = await repoWithOrigin("https://gitlab.internal.example/g/p.git");
        expect((await originDriver(gl.dir))?.kind).toBe("gitlab");
    });

    it("returns null for a host without a driver", async () => {
        const r = await repoWithOrigin("https://dev.azure.com/org/proj/_git/repo");
        expect(await detectOrigin(r.dir)).toMatchObject({ host: "dev.azure.com", kind: null });
        expect(await originDriver(r.dir)).toBeNull();
    });
});

describe("gh driver", () => {
    const GH_JSON = SafeJSON.stringify([
        { number: 12, state: "MERGED", baseRefName: "master", url: "https://github.com/o/r/pull/12" },
        { number: 15, state: "OPEN", baseRefName: "feat/parent", url: "https://github.com/o/r/pull/15" },
    ]);

    it("prefers an open PR over an older merged one and maps the fields", () => {
        expect(parseGhPrList(GH_JSON)).toEqual({
            pr: {
                number: 15,
                state: "OPEN",
                target: "feat/parent",
                url: "https://github.com/o/r/pull/15",
            },
            error: null,
        });
        expect(
            parseGhPrList(SafeJSON.stringify([{ number: 1, state: "weird", baseRefName: "m", url: "u" }])).pr?.state
        ).toBe("CLOSED");
    });

    it("separates an empty list from output it could not read", () => {
        expect(parseGhPrList("[]")).toEqual({ pr: null, error: null });

        const unparsable = parseGhPrList("not json");
        expect(unparsable.pr).toBeNull();
        expect(unparsable.error).toContain("unparsable");

        const notAList = parseGhPrList(SafeJSON.stringify({ number: 15 }));
        expect(notAList.pr).toBeNull();
        expect(notAList.error).toContain("not a list");

        const malformed = parseGhPrList(SafeJSON.stringify([{ number: 15, state: "OPEN" }]));
        expect(malformed.pr).toBeNull();
        expect(malformed.error).toContain("no row");
    });

    it("spawns gh with the head filter and turns a failure into null", async () => {
        const calls: string[][] = [];
        const okRunner: CommandRunner = async (cmd) => {
            calls.push(cmd);
            return { code: 0, stdout: GH_JSON, stderr: "" };
        };
        const { pr } = await ghDriver("/repo", okRunner).prForHead("feat/child");
        expect(pr?.number).toBe(15);
        expect(calls[0].slice(0, 5)).toEqual(["gh", "pr", "list", "--head", "feat/child"]);
        expect(calls[0]).toContain("--json");

        const failing: CommandRunner = async () => ({ code: 1, stdout: "", stderr: "gh: not logged in" });
        expect(await ghDriver("/repo", failing).prForHead("feat/child")).toEqual({
            pr: null,
            error: "gh: not logged in",
        });
    });
});

describe("glab driver", () => {
    const GLAB_JSON = SafeJSON.stringify([
        {
            iid: 7,
            state: "closed",
            target_branch: "develop",
            web_url: "https://gitlab.internal.example/g/p/-/merge_requests/7",
        },
        {
            iid: 9,
            state: "opened",
            target_branch: "feature/next",
            web_url: "https://gitlab.internal.example/g/p/-/merge_requests/9",
        },
    ]);

    it("maps opened/merged/closed/locked onto the shared vocabulary and prefers open MRs", () => {
        expect(parseGlabMrList(GLAB_JSON)).toEqual({
            pr: {
                number: 9,
                state: "OPEN",
                target: "feature/next",
                url: "https://gitlab.internal.example/g/p/-/merge_requests/9",
            },
            error: null,
        });
        expect(
            parseGlabMrList(SafeJSON.stringify([{ iid: 1, state: "merged", target_branch: "d", web_url: "u" }])).pr
                ?.state
        ).toBe("MERGED");
        expect(
            parseGlabMrList(SafeJSON.stringify([{ iid: 1, state: "locked", target_branch: "d", web_url: "u" }])).pr
                ?.state
        ).toBe("OPEN");
    });

    it("separates an empty list from output it could not read", () => {
        expect(parseGlabMrList("[]")).toEqual({ pr: null, error: null });

        const unparsable = parseGlabMrList("not json");
        expect(unparsable.pr).toBeNull();
        expect(unparsable.error).toContain("unparsable");

        const malformed = parseGlabMrList(SafeJSON.stringify([{ iid: 9, state: "opened" }]));
        expect(malformed.pr).toBeNull();
        expect(malformed.error).toContain("no row");
    });

    it("spawns glab with --source-branch, --all and JSON output", async () => {
        const calls: string[][] = [];
        const runner: CommandRunner = async (cmd) => {
            calls.push(cmd);
            return { code: 0, stdout: GLAB_JSON, stderr: "" };
        };
        const { pr: mr } = await glabDriver("/repo", runner).prForHead("feat/x");
        expect(mr?.target).toBe("feature/next");
        expect(calls[0]).toEqual(["glab", "mr", "list", "--source-branch", "feat/x", "--all", "--output", "json"]);
    });
});

describe("originWebBase / branchWebUrl / commitWebUrl", () => {
    it("maps scp, ssh and https remotes to the project page", () => {
        expect(originWebBase("git@github.com:o/r.git")).toBe("https://github.com/o/r");
        expect(originWebBase("ssh://git@gitlab.internal.example:2222/g/sub/p.git")).toBe(
            "https://gitlab.internal.example/g/sub/p"
        );
        expect(originWebBase("https://user@gitlab.internal.example:8443/g/p.git/")).toBe(
            "https://gitlab.internal.example:8443/g/p"
        );
        expect(originWebBase("not a remote")).toBeNull();
    });

    it("keeps a plain http scheme and its port", () => {
        expect(originWebBase("http://gitlab.internal.example:8080/g/p.git")).toBe(
            "http://gitlab.internal.example:8080/g/p"
        );
    });

    it("builds host-specific branch and commit pages", () => {
        const gh = classifyOriginUrl("git@github.com:o/r.git");
        const gl = classifyOriginUrl("git@gitlab.internal.example:g/p.git");
        expect(branchWebUrl(gh, "feat/x")).toBe("https://github.com/o/r/tree/feat/x");
        expect(branchWebUrl(gl, "feat/x")).toBe("https://gitlab.internal.example/g/p/-/tree/feat/x");
        expect(commitWebUrl(gl, "abc123")).toBe("https://gitlab.internal.example/g/p/-/commit/abc123");
        expect(branchWebUrl(classifyOriginUrl("https://dev.azure.com/org/p/_git/r"), "main")).toBeNull();
        expect(branchWebUrl(gh, "HEAD")).toBeNull();
    });
});

describe("project refs and PR URLs", () => {
    it("derives the hosted project from a remote", () => {
        expect(projectRefFromRemote("git@github.com:o/r.git")).toEqual({
            kind: "github",
            host: "github.com",
            path: "o/r",
            web: "https://github.com/o/r",
        });
        expect(projectRefFromRemote("ssh://git@gitlab.internal.example:2222/g/sub/p.git")).toMatchObject({
            kind: "gitlab",
            host: "gitlab.internal.example",
            path: "g/sub/p",
        });
        expect(projectRefFromRemote("https://dev.azure.com/org/p/_git/r")).toBeNull();
    });

    it("splits GitHub and GitLab PR URLs, a trailing tab included", () => {
        expect(parsePrUrl("https://github.com/o/r/pull/12/files")).toEqual({
            project: { kind: "github", host: "github.com", path: "o/r", web: "https://github.com/o/r" },
            number: 12,
        });
        expect(parsePrUrl("https://gitlab.internal.example/g/sub/p/-/merge_requests/9/diffs")).toMatchObject({
            project: { kind: "gitlab", path: "g/sub/p" },
            number: 9,
        });
        expect(parsePrUrl("https://github.com/o/r/issues/12")).toBeNull();
        expect(parsePrUrl("not a url")).toBeNull();
    });
});

describe("CI vocabularies", () => {
    it("maps GitHub check runs and status contexts, worst wins in the rollup", () => {
        expect(ghCheckStatus({ status: "COMPLETED", conclusion: "SUCCESS" })).toBe("success");
        expect(ghCheckStatus({ status: "COMPLETED", conclusion: "TIMED_OUT" })).toBe("failed");
        expect(ghCheckStatus({ status: "COMPLETED", conclusion: "SKIPPED" })).toBe("skipped");
        expect(ghCheckStatus({ status: "IN_PROGRESS", conclusion: "" })).toBe("running");
        expect(ghCheckStatus({ status: "QUEUED" })).toBe("pending");
        expect(ghCheckStatus({ state: "ERROR" })).toBe("failed");
        expect(ghCheckStatus({ state: "EXPECTED" })).toBe("pending");
        expect(rollupCi(["success", "running", "failed"])).toBe("failed");
        expect(rollupCi(["success", "pending", "running"])).toBe("running");
        expect(rollupCi(["skipped", "success"])).toBe("success");
        expect(rollupCi([])).toBeNull();
    });

    it("maps GitLab pipeline statuses", () => {
        expect(glabPipelineStatus("success")).toBe("success");
        expect(glabPipelineStatus("canceled")).toBe("failed");
        expect(glabPipelineStatus("manual")).toBe("pending");
        expect(glabPipelineStatus(undefined)).toBeNull();
    });
});

const GH_ROWS = SafeJSON.stringify([
    {
        number: 15,
        title: "Add x",
        state: "OPEN",
        isDraft: true,
        author: { login: "alice" },
        headRefName: "feat/x",
        baseRefName: "master",
        headRefOid: "abc",
        url: "https://github.com/o/r/pull/15",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
        labels: [{ name: "bug" }],
        reviewDecision: "",
        reviewRequests: [{ login: "bob" }, { slug: "core-team" }],
        latestReviews: [
            { state: "APPROVED", author: { login: "bob" } },
            { state: "COMMENTED", author: { login: "carol" } },
        ],
        statusCheckRollup: [
            { status: "COMPLETED", conclusion: "SUCCESS", name: "lint", workflowName: "CI" },
            { status: "IN_PROGRESS", conclusion: "", name: "test", workflowName: "CI" },
        ],
    },
    { number: "broken" },
]);

describe("gh PR list and view", () => {
    it("maps list rows onto the shared shape and drops rows without number or url", () => {
        const [pr, ...rest] = parseGhPrRows(GH_ROWS);
        expect(rest).toEqual([]);
        expect(pr).toEqual({
            number: 15,
            title: "Add x",
            state: "OPEN",
            draft: true,
            author: "alice",
            headBranch: "feat/x",
            baseBranch: "master",
            url: "https://github.com/o/r/pull/15",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-02T00:00:00Z",
            labels: ["bug"],
            reviewers: ["bob", "core-team"],
            reviewDecision: null,
            approvals: 1,
            ci: "running",
            comments: null,
            headSha: "abc",
        });
        expect(() => parseGhPrRows("not json")).toThrow("unparsable");
    });

    it("lists read-only through gh with --repo, state, limit and --author @me", async () => {
        const calls: string[][] = [];
        const runner: CommandRunner = async (cmd) => {
            calls.push(cmd);
            return { code: 0, stdout: GH_ROWS, stderr: "" };
        };
        const project = projectRefFromRemote("git@github.com:o/r.git");

        if (!project) {
            throw new Error("fixture remote did not parse");
        }

        const result = await listPrs({ project, state: "merged", mine: true, limit: 5, runner });
        expect(result.prs.map((pr) => pr.number)).toEqual([15]);
        expect(result.error).toBeNull();
        expect(calls[0].slice(0, 10)).toEqual([
            "gh",
            "pr",
            "list",
            "--repo",
            "github.com/o/r",
            "--state",
            "merged",
            "--limit",
            "5",
            "--author",
        ]);

        const failing: CommandRunner = async () => ({ code: 4, stdout: "", stderr: "gh: auth required" });
        expect(await listPrs({ project, runner: failing })).toEqual({
            prs: [],
            error: "gh: auth required",
            warnings: [],
        });
    });

    it("maps a view with body, commits, checks and merge state", () => {
        const row = SafeJSON.parse(GH_ROWS, { strict: true })[0];
        const detail = parseGhPrView(
            SafeJSON.stringify({
                ...row,
                body: "## Why",
                comments: [{}, {}],
                commits: [
                    {
                        oid: "c1",
                        messageHeadline: "first",
                        authors: [{ login: "alice" }],
                        committedDate: "2026-01-01T01:00:00Z",
                    },
                ],
                changedFiles: 3,
                additions: 10,
                deletions: 2,
                baseRefOid: "base",
                mergeable: "CONFLICTING",
                mergeStateStatus: "DIRTY",
            })
        );
        expect(detail).toMatchObject({
            body: "## Why",
            comments: 2,
            commits: [{ sha: "c1", title: "first", author: "alice", date: "2026-01-01T01:00:00Z" }],
            changedFiles: 3,
            additions: 10,
            deletions: 2,
            baseSha: "base",
            mergeable: "conflicting",
            mergeStatus: "DIRTY",
            webUrls: { files: "https://github.com/o/r/pull/15/files" },
        });
        expect(detail.checks).toEqual([
            { name: "CI / lint", status: "success", url: null },
            { name: "CI / test", status: "running", url: null },
        ]);
    });
});

const GL_MRS = SafeJSON.stringify([
    {
        iid: 9,
        title: "Fix y",
        state: "opened",
        draft: false,
        author: { username: "bob" },
        source_branch: "feature/y",
        target_branch: "develop",
        web_url: "https://gitlab.internal.example/g/p/-/merge_requests/9",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-03T00:00:00Z",
        labels: ["ui"],
        reviewers: [{ username: "alice" }],
        user_notes_count: 4,
        sha: "s9",
        has_conflicts: false,
        detailed_merge_status: "not_approved",
    },
]);

describe("GitLab MR list and view", () => {
    const project = projectRefFromRemote("git@gitlab.internal.example:g/p.git");

    it("joins MRs to the newest pipeline of their head sha", () => {
        const ciBySha = glabPipelinesBySha(
            SafeJSON.stringify([
                { id: 3, sha: "s9", status: "failed" },
                { id: 2, sha: "s9", status: "success" },
            ])
        );
        expect(parseGlabMrRows(GL_MRS, ciBySha)[0]).toMatchObject({
            number: 9,
            state: "OPEN",
            author: "bob",
            headBranch: "feature/y",
            baseBranch: "develop",
            labels: ["ui"],
            reviewers: ["alice"],
            comments: 4,
            ci: "failed",
            approvals: null,
        });
        expect(parseGlabMrRows(GL_MRS)[0].ci).toBeNull();
    });

    it("lists through glab api GETs and keeps the MRs when the pipeline call fails", async () => {
        if (!project) {
            throw new Error("fixture remote did not parse");
        }

        const calls: string[][] = [];
        const runner: CommandRunner = async (cmd) => {
            calls.push(cmd);
            return cmd[4].includes("/pipelines")
                ? { code: 1, stdout: "", stderr: "403 Forbidden" }
                : { code: 0, stdout: GL_MRS, stderr: "" };
        };
        const result = await listPrs({ project, state: "open", mine: true, limit: 10, runner });
        expect(result.prs).toHaveLength(1);
        expect(result.warnings).toEqual(["pipelines: 403 Forbidden"]);
        expect(calls.every((cmd) => cmd.slice(0, 4).join(" ") === "glab api --hostname gitlab.internal.example")).toBe(
            true
        );
        const mrCall = calls.find((cmd) => cmd[4].includes("/merge_requests"));
        expect(mrCall?.[4]).toStartWith("projects/g%2Fp/merge_requests?");
        expect(mrCall?.[4]).toContain("state=opened");
        expect(mrCall?.[4]).toContain("scope=created_by_me");
    });

    it("views an MR, a failed secondary call leaves its fields empty", async () => {
        if (!project) {
            throw new Error("fixture remote did not parse");
        }

        const mr = SafeJSON.stringify({
            ...SafeJSON.parse(GL_MRS, { strict: true })[0],
            description: "body",
            changes_count: "12",
            diff_refs: { base_sha: "b", head_sha: "h" },
            head_pipeline: { status: "running" },
        });
        const runner: CommandRunner = async (cmd) => {
            const endpoint = cmd[4];

            if (endpoint.endsWith("/approvals")) {
                return {
                    code: 0,
                    stdout: SafeJSON.stringify({ approved: false, approvals_left: 1, approved_by: [] }),
                    stderr: "",
                };
            }

            if (endpoint.includes("/commits")) {
                return { code: 1, stdout: "", stderr: "timeout" };
            }

            if (endpoint.endsWith("/pipelines")) {
                return {
                    code: 0,
                    stdout: SafeJSON.stringify([{ id: 5, ref: "feature/y", status: "running" }]),
                    stderr: "",
                };
            }

            return { code: 0, stdout: mr, stderr: "" };
        };
        const { pr, error, warnings } = await viewPr({ project, number: 9, runner });
        expect(error).toBeNull();
        expect(warnings).toEqual(["commits: timeout"]);
        expect(pr).toMatchObject({
            body: "body",
            ci: "running",
            headSha: "h",
            baseSha: "b",
            changedFiles: 12,
            additions: null,
            approvals: 0,
            reviewDecision: "REVIEW_REQUIRED",
            mergeable: "mergeable",
            mergeStatus: "not_approved",
            commits: [],
            checks: [{ name: "pipeline 5 (feature/y)", status: "running", url: null }],
            webUrls: { files: "https://gitlab.internal.example/g/p/-/merge_requests/9/diffs" },
        });
    });
});
