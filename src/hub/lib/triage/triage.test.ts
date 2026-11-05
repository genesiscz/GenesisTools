import { describe, expect, test } from "bun:test";
import type { PrReadiness } from "../pr-readiness";
import type { HubPr } from "../prs";
import { mergePr, prTriage, type TriageDeps } from "./index";

function pr(number: number, updatedAt: string): HubPr {
    return {
        number,
        title: `Invented PR ${number}`,
        state: "OPEN",
        draft: false,
        author: "alice",
        headBranch: `feat/${number}`,
        baseBranch: "main",
        url: `https://github.com/example/shop/pull/${number}`,
        createdAt: updatedAt,
        updatedAt,
        labels: [],
        reviewers: [],
        reviewDecision: null,
        approvals: null,
        ci: "pending",
        comments: null,
        headSha: `sha${number}`,
        crossRepository: false,
        headRepo: null,
        repo: "shop",
        repoRoot: "/work/shop",
        origin: { kind: "github", host: "github.com", web: "https://github.com/example/shop" },
        localWorktree: number === 2 ? "/work/shop-feat-2" : null,
        isMine: true,
        proposal: null,
    };
}

function readinessOf(url: string, number: number, verdict: PrReadiness["verdict"]): PrReadiness {
    return {
        url,
        provider: "github",
        number,
        title: null,
        headSha: null,
        state: "open",
        draft: false,
        ci: "success",
        unresolved: number,
        unresolvedBy: [],
        outdatedUnresolved: 0,
        lastReviewAt: null,
        lastReviewBy: null,
        lastPushAt: null,
        reviewedHead: null,
        staleReviewers: [],
        reviewDecision: null,
        mergeable: "mergeable",
        verdict,
        reasons: [],
        summary: verdict,
        fetchedAt: "2026-11-04T12:00:00Z",
        cached: false,
    };
}

const deps = (verdicts: Record<number, "ready" | "blocked" | null>): TriageDeps => ({
    projectPaths: async () => ["/work/shop"],
    list: async () => ({
        prs: [pr(1, "2026-11-01T10:00:00Z"), pr(2, "2026-11-02T10:00:00Z"), pr(3, "2026-11-03T10:00:00Z")],
        repos: [
            {
                repo: "cart",
                repoRoot: "/work/cart",
                paths: ["/work/cart"],
                origin: null,
                count: 0,
                error: "host unreachable",
                errorSummary: "Cannot resolve the host",
                warnings: [],
            },
        ],
        skipped: [],
    }),
    readiness: async (inputs) =>
        inputs.map((input) => {
            const number = Number(/pull\/(\d+)/.exec(input)?.[1]);
            const verdict = verdicts[number] ?? null;
            return {
                input,
                error: verdict ? null : "rate limited",
                readiness: verdict ? readinessOf(input, number, verdict) : null,
            };
        }),
    now: () => new Date("2026-11-04T12:00:00Z"),
});

describe("pr triage (F20)", () => {
    test("ready first, then blocked, then unread; each row names its checkout and readiness", async () => {
        const result = await prTriage({}, deps({ 1: "blocked", 2: "ready", 3: null }));

        expect(result.prs.map((row) => [row.number, row.verdict])).toEqual([
            [2, "ready"],
            [1, "blocked"],
            [3, null],
        ]);
        expect(result.prs[0]).toMatchObject({ checkout: "/work/shop-feat-2", unresolved: 2, ci: "success" });
        expect(result.prs[2]).toMatchObject({ checkout: "/work/shop", readinessError: "rate limited", ci: "pending" });
        expect(result.skipped).toEqual([{ what: "cart", reason: "Cannot resolve the host" }]);
    });

    test("a merge runs the stack-safe merge for a GitHub PR and refuses a GitLab MR without running anything", async () => {
        const runs: string[][] = [];
        const run = async (args: string[]) => {
            runs.push(args);
            return { success: true, stdout: "merged #2", stderr: "" };
        };

        const merged = await mergePr({ url: "https://github.com/example/shop/pull/2", method: "rebase" }, run);
        expect(merged).toMatchObject({ merged: true, detail: "merged #2" });
        expect(runs).toEqual([["github", "merge", "https://github.com/example/shop/pull/2", "--rebase"]]);

        const refused = await mergePr(
            { url: "https://gitlab.example.com/group/app/-/merge_requests/4", method: "squash" },
            run
        );
        expect(refused.merged).toBe(false);
        expect(runs).toHaveLength(1);
    });
});
