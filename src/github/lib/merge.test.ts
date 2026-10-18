import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as realOctokit from "@genesiscz/utils/github/octokit";
import type {
    DependentPull,
    MergeGitHubClient,
    MergeMethod,
    MergePullOptions,
    MergePullResult,
    PullRef,
} from "./merge";
import { NATIVE_STACK_BASE_ERROR } from "./native-stack";
import { postReviewComment, type ReviewCommentClient } from "./review-comments";
import type { PullCommitSubject } from "./squash-message";
import type { RestackBranchInput, RestackBranchResult, StackRestackOps } from "./stack-restack";

type OctokitCall = { op: string; params: Record<string, unknown> };

let octokitCalls: OctokitCall[] = [];
let octokitAnswers = new Map<string, (params: Record<string, unknown>) => unknown>();

/** Records the call, then answers from the case's script; a call the case did not script throws. */
function octokitAnswer(op: string, params: Record<string, unknown>): unknown {
    octokitCalls.push({ op, params });
    const handler = octokitAnswers.get(op);

    if (!handler) {
        throw new Error(`unscripted octokit call ${op}`);
    }

    return handler(params);
}

const fakeOctokit = {
    rest: {
        pulls: {
            get: async (params: Record<string, unknown>) => octokitAnswer("pulls.get", params),
            list: async (params: Record<string, unknown>) => octokitAnswer("pulls.list", params),
            listCommits: async (params: Record<string, unknown>) => octokitAnswer("pulls.listCommits", params),
            merge: async (params: Record<string, unknown>) => octokitAnswer("pulls.merge", params),
            update: async (params: Record<string, unknown>) => octokitAnswer("pulls.update", params),
        },
        repos: {
            compareCommitsWithBasehead: async (params: Record<string, unknown>) =>
                octokitAnswer("repos.compare", params),
        },
        git: {
            updateRef: async (params: Record<string, unknown>) => octokitAnswer("git.updateRef", params),
            deleteRef: async (params: Record<string, unknown>) => octokitAnswer("git.deleteRef", params),
        },
    },
    request: async (params: Record<string, unknown>) => octokitAnswer("request", params),
    graphql: async (query: string, variables: Record<string, unknown>) =>
        octokitAnswer("graphql", { query, ...variables }),
};

mock.module("@genesiscz/utils/github/octokit", () => ({
    ...realOctokit,
    getOctokitForWrite: () => fakeOctokit,
}));

const { createOctokitMergeClient, forcePushBeforeTips, resolveMergeMethod, safeMergePull } = await import("./merge");

beforeEach(() => {
    octokitCalls = [];
    octokitAnswers = new Map();
});

type CallLog = Array<{ op: string; args: unknown[] }>;

function makeMock(opts: {
    pr: PullRef;
    dependents?: DependentPull[];
    /** Dependents returned after merge (defaults to pre-merge list). */
    postMergeDependents?: DependentPull[];
    /** Commit subjects returned by listPullCommits (oldest first). */
    commits?: PullCommitSubject[];
    mergeResult?: MergePullResult;
    /** Fail updatePullBase for these PR numbers. */
    failRetarget?: number[];
    /**
     * Throw the native-stack 422 from updatePullBase until unstack() has run.
     * After unstack, PATCH succeeds the second time (the real GitHub sequence).
     */
    stackBaseErrorUntilUnstack?: number[];
    /** Native stack number returned by getPullStackNumber. */
    stackByPr?: Record<number, number | null>;
    /** Fail unstack(). */
    failUnstack?: boolean;
    /** Fail deleteBranch. */
    failDelete?: boolean;
    /** listBaseForcePushTips answers per PR number; a PR missing here has none. */
    baseForcePushTips?: Record<number, string[]>;
    /** Throw from listBaseForcePushTips. */
    failBaseForcePushTips?: boolean;
    /** Fail fastForwardBase. */
    failFf?: boolean | string;
    /** Mutate dependent state after base update. */
    afterRetarget?: (dep: DependentPull, newBase: string) => DependentPull;
}): { client: MergeGitHubClient; calls: CallLog } {
    const calls: CallLog = [];
    const dependents = opts.dependents ?? [];
    const postMerge = opts.postMergeDependents ?? dependents;
    let merged = opts.pr.merged;
    const unstackedStacks = new Set<number>();

    const stackNumberFor = (number: number): number | null => {
        if (opts.stackByPr && Object.hasOwn(opts.stackByPr, number)) {
            return opts.stackByPr[number];
        }

        return (
            [...dependents, ...postMerge].find((d) => d.number === number)?.stackNumber ?? opts.pr.stackNumber ?? null
        );
    };

    const client: MergeGitHubClient = {
        async getPull(_owner, _repo, number) {
            calls.push({ op: "getPull", args: [number] });
            // Dependents may refresh head SHA via getPull after merge.
            const dep = [...dependents, ...postMerge].find((d) => d.number === number);
            if (dep && number !== opts.pr.number) {
                return {
                    number: dep.number,
                    title: dep.title,
                    state: dep.state,
                    merged: false,
                    draft: false,
                    mergeable: true,
                    headRef: dep.headRef,
                    baseRef: dep.baseRef,
                    headSha: dep.headSha ?? "dddddddddddddddddddddddddddddddddddddddd",
                    baseSha: opts.pr.baseSha,
                    commitCount: 1,
                    htmlUrl: dep.htmlUrl,
                };
            }
            return { ...opts.pr, number, merged };
        },
        async listPullCommits(_owner, _repo, pr) {
            calls.push({ op: "listPullCommits", args: [pr.number] });
            return (opts.commits ?? []).map((c) => ({ ...c }));
        },
        async listOpenPullsByBase(_owner, _repo, base) {
            calls.push({ op: "listOpenPullsByBase", args: [base] });
            // After merge, return post-merge set; before, pre-merge.
            const list = merged ? postMerge : dependents;
            return list.filter((d) => d.baseRef === base).map((d) => ({ ...d }));
        },
        async mergePull(_owner, _repo, number, options: MergePullOptions) {
            calls.push({ op: "mergePull", args: [number, options] });
            merged = true;
            return (
                opts.mergeResult ?? {
                    sha: "abc123deadbeef",
                    merged: true,
                    message: "Pull Request successfully merged",
                }
            );
        },
        async fastForwardBase(_owner, _repo, baseRef, headSha) {
            calls.push({ op: "fastForwardBase", args: [baseRef, headSha] });
            if (opts.failFf) {
                throw new Error(
                    typeof opts.failFf === "string" ? opts.failFf : `Cannot fast-forward origin/${baseRef}`
                );
            }
            merged = true;
            return (
                opts.mergeResult ?? {
                    sha: headSha,
                    merged: true,
                    message: `Fast-forwarded origin/${baseRef} to ${headSha.slice(0, 7)}`,
                }
            );
        },
        async updatePullBase(_owner, _repo, number, base) {
            calls.push({ op: "updatePullBase", args: [number, base] });

            const stackNumber = stackNumberFor(number);
            if (
                opts.stackBaseErrorUntilUnstack?.includes(number) &&
                (stackNumber === null || !unstackedStacks.has(stackNumber))
            ) {
                throw new Error(
                    `Validation Failed: {"message":"${NATIVE_STACK_BASE_ERROR}","resource":"PullRequest","field":"base","code":"invalid"}`
                );
            }

            if (opts.failRetarget?.includes(number)) {
                throw new Error(`API error retargeting #${number}`);
            }

            const dep = [...dependents, ...postMerge].find((d) => d.number === number);
            if (!dep) {
                throw new Error(`unknown PR #${number}`);
            }

            const updated: DependentPull = {
                ...dep,
                baseRef: base,
                state: "open",
            };

            if (opts.afterRetarget) {
                return opts.afterRetarget(updated, base);
            }

            return updated;
        },
        async getPullStackNumber(_owner, _repo, number) {
            calls.push({ op: "getPullStackNumber", args: [number] });
            if (opts.stackByPr && Object.hasOwn(opts.stackByPr, number)) {
                return opts.stackByPr[number];
            }

            const found = [...dependents, ...postMerge].find((d) => d.number === number);
            return found?.stackNumber ?? opts.pr.stackNumber ?? null;
        },
        async unstack(_owner, _repo, stackNumber) {
            calls.push({ op: "unstack", args: [stackNumber] });
            if (opts.failUnstack) {
                throw new Error(`unstack failed for stack #${stackNumber}`);
            }

            unstackedStacks.add(stackNumber);
        },
        async deleteBranch(_owner, _repo, branch) {
            calls.push({ op: "deleteBranch", args: [branch] });

            if (opts.failDelete) {
                throw new Error(`ref heads/${branch} not found`);
            }
        },
        async listBaseForcePushTips(_owner, _repo, number) {
            calls.push({ op: "listBaseForcePushTips", args: [number] });

            if (opts.failBaseForcePushTips) {
                throw new Error("graphql timeline unavailable");
            }

            return opts.baseForcePushTips?.[number] ?? [];
        },
    };

    return { client, calls };
}

function makeRestackMock(opts?: {
    /** Map branch → result override. */
    byBranch?: Record<string, Partial<RestackBranchResult>>;
    /** Fail restack for these branch names. */
    failBranches?: string[];
}): { restack: StackRestackOps; calls: RestackBranchInput[] } {
    const calls: RestackBranchInput[] = [];
    const restack: StackRestackOps = {
        async restackBranch(input) {
            calls.push(input);
            if (opts?.failBranches?.includes(input.branch)) {
                throw new Error(`restack conflict on ${input.branch}`);
            }
            const over = opts?.byBranch?.[input.branch];
            const rebased = over?.rebased ?? false;
            return {
                headSha:
                    over?.headSha ?? (rebased ? "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" : input.expectedHeadSha),
                rebased,
                alreadyLinear: over?.alreadyLinear ?? !rebased,
            };
        },
    };
    return { restack, calls };
}

const HEAD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function basePr(over: Partial<PullRef> = {}): PullRef {
    return {
        number: 1,
        title: "PR A",
        state: "open",
        merged: false,
        draft: false,
        mergeable: true,
        headRef: "branch-a",
        baseRef: "main",
        headSha: HEAD_SHA,
        baseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        commitCount: 1,
        htmlUrl: "https://github.com/o/r/pull/1",
        ...over,
    };
}

function dep(over: Partial<DependentPull> & { number: number }): DependentPull {
    return {
        title: `PR ${over.number}`,
        headRef: `branch-${over.number}`,
        baseRef: "branch-a",
        htmlUrl: `https://github.com/o/r/pull/${over.number}`,
        state: "open",
        headSha: `c${String(over.number).padStart(39, "c")}`,
        ...over,
    };
}

describe("forcePushBeforeTips", () => {
    test("lists each replaced tip once, newest first, skipping events without a commit", () => {
        const nodes = [
            { beforeCommit: { oid: "old" } },
            null,
            { beforeCommit: null },
            { beforeCommit: { oid: "new" } },
        ];
        expect(forcePushBeforeTips({ repository: { pullRequest: { timelineItems: { nodes } } } })).toEqual([
            "new",
            "old",
        ]);
        expect(forcePushBeforeTips({ repository: { pullRequest: null } })).toEqual([]);
    });
});

describe("resolveMergeMethod", () => {
    test("accepts each single method flag", () => {
        expect(resolveMergeMethod({ merge: true })).toBe("merge");
        expect(resolveMergeMethod({ rebase: true })).toBe("rebase");
        expect(resolveMergeMethod({ squash: true })).toBe("squash");
        expect(resolveMergeMethod({ ffOnly: true })).toBe("ff-only");
        expect(resolveMergeMethod({ ff: true })).toBe("ff-only");
    });

    test("rejects zero or multiple flags", () => {
        expect(() => resolveMergeMethod({})).toThrow(/exactly one/);
        expect(() => resolveMergeMethod({ merge: true, rebase: true })).toThrow(/Conflicting/);
        expect(() => resolveMergeMethod({ ffOnly: true, rebase: true })).toThrow(/Conflicting/);
    });
});

describe("safeMergePull — stack retarget order (cli/cli#1168)", () => {
    test("stack-safe --rebase uses FF (not merge API), retargets, restacks dependents", async () => {
        const logs: string[] = [];
        const headSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        const { client, calls } = makeMock({
            pr: basePr({ headSha }),
            dependents: [dep({ number: 2, title: "PR B", headRef: "branch-b", baseRef: "branch-a" })],
        });
        const { restack, calls: restackCalls } = makeRestackMock();

        const result = await safeMergePull({
            owner: "o",
            repo: "r",
            number: 1,
            method: "rebase",
            restackChildren: true,
            deleteBranch: false,
            client,
            restack,
            log: (m) => logs.push(m),
        });

        expect(result.branchDeleted).toBe(false);
        expect(result.rebaseMode).toBe("stack-safe-ff");
        expect(result.retargeted).toEqual([
            {
                number: 2,
                title: "PR B",
                fromBase: "branch-a",
                toBase: "main",
                ok: true,
                state: "open",
            },
        ]);
        expect(result.dependentsRestacked).toHaveLength(1);
        expect(result.dependentsRestacked[0].ok).toBe(true);

        // Order: discover → restack head → FF → retarget → restack child. No delete, no rewrite merge.
        const ops = calls.map((c) => c.op);
        expect(ops).toContain("fastForwardBase");
        expect(ops).not.toContain("mergePull");
        expect(ops).toContain("updatePullBase");
        expect(ops).not.toContain("deleteBranch");

        const ffIdx = ops.indexOf("fastForwardBase");
        const retargetIdx = ops.indexOf("updatePullBase");
        expect(ffIdx).toBeLessThan(retargetIdx);

        expect(calls.find((c) => c.op === "fastForwardBase")?.args).toEqual(["main", headSha]);

        // Head restack + child restack with --onto old parent tip.
        expect(restackCalls.length).toBeGreaterThanOrEqual(2);
        expect(restackCalls[0]).toMatchObject({
            branch: "branch-a",
            newBase: "main",
            expectedHeadSha: headSha,
        });
        expect(restackCalls[0].oldBaseSha).toBeUndefined();
        const childCall = restackCalls.find((c) => c.branch === "branch-b");
        expect(childCall).toMatchObject({
            newBase: "main",
            oldBaseSha: headSha,
        });

        expect(logs.some((l) => l.includes("Stack-safe rebase"))).toBe(true);
        expect(logs.some((l) => l.includes("Keeping remote branch"))).toBe(true);
    });

    test("by default only the merged PR's branch is pushed: children are retargeted, never restacked (#496)", async () => {
        const logs: string[] = [];
        const headSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        const { client, calls } = makeMock({
            pr: basePr({ headSha }),
            dependents: [dep({ number: 2, title: "PR B", headRef: "branch-b", baseRef: "branch-a" })],
            baseForcePushTips: { 1: ["main-before-push"] },
        });
        const { restack, calls: restackCalls } = makeRestackMock({ byBranch: { "branch-a": { rebased: true } } });

        const result = await safeMergePull({
            owner: "o",
            repo: "r",
            number: 1,
            method: "rebase",
            deleteBranch: false,
            client,
            restack,
            log: (m) => logs.push(m),
        });

        expect(restackCalls.map((c) => c.branch)).toEqual(["branch-a"]);
        expect(restackCalls[0].priorBaseShas).toEqual(["main-before-push"]);
        expect(result.dependentsRestacked).toEqual([]);
        expect(result.retargeted.map((r) => [r.number, r.toBase, r.ok])).toEqual([[2, "main", true]]);
        expect(calls.some((c) => c.op === "listBaseForcePushTips" && c.args[0] === 2)).toBe(false);
        expect(logs.some((l) => l.includes("Children keep their branches"))).toBe(true);
    });

    test("every restack gets its own PR's earlier base tips, so a child on a replaced parent tip restacks cleanly", async () => {
        const headSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        const { client } = makeMock({
            pr: basePr({ headSha }),
            dependents: [dep({ number: 2, title: "PR B", headRef: "branch-b", baseRef: "branch-a" })],
            baseForcePushTips: { 1: ["main-before-push"], 2: ["branch-a-before-restack", "branch-a-older"] },
        });
        const { restack, calls: restackCalls } = makeRestackMock();

        await safeMergePull({
            owner: "o",
            repo: "r",
            number: 1,
            method: "rebase",
            restackChildren: true,
            deleteBranch: false,
            client,
            restack,
        });

        expect(restackCalls.find((c) => c.branch === "branch-a")?.priorBaseShas).toEqual(["main-before-push"]);
        expect(restackCalls.find((c) => c.branch === "branch-b")).toMatchObject({
            oldBaseSha: headSha,
            priorBaseShas: ["branch-a-before-restack", "branch-a-older"],
        });
    });

    test("a failed base force-push lookup is logged and every restack gets null, so a needed rebase stops", async () => {
        const logs: string[] = [];
        const { client } = makeMock({
            pr: basePr(),
            dependents: [dep({ number: 2, title: "PR B", headRef: "branch-b", baseRef: "branch-a" })],
            failBaseForcePushTips: true,
        });
        const { restack, calls: restackCalls } = makeRestackMock();

        const result = await safeMergePull({
            owner: "o",
            repo: "r",
            number: 1,
            method: "rebase",
            restackChildren: true,
            deleteBranch: false,
            client,
            restack,
            log: (m) => logs.push(m),
        });

        expect(result.dependentsRestacked[0].ok).toBe(true);
        expect(restackCalls.length).toBeGreaterThan(0);
        expect(restackCalls.every((c) => c.priorBaseShas === null)).toBe(true);
        expect(logs.some((l) => l.includes("could not read the earlier base tips of #2"))).toBe(true);
    });

    test("a client without the base force-push lookup passes null, so a needed rebase stops", async () => {
        const { client } = makeMock({ pr: basePr(), dependents: [] });
        const { listBaseForcePushTips: _unused, ...withoutLookup } = client;
        const { restack, calls: restackCalls } = makeRestackMock();

        await safeMergePull({
            owner: "o",
            repo: "r",
            number: 1,
            method: "rebase",
            deleteBranch: false,
            client: withoutLookup,
            restack,
        });

        expect(restackCalls.map((c) => c.priorBaseShas)).toEqual([null]);
    });

    test("--rebase --no-restack uses GitHub rewrite merge API", async () => {
        const { client, calls } = makeMock({
            pr: basePr(),
            dependents: [dep({ number: 2, title: "PR B", headRef: "branch-b", baseRef: "branch-a" })],
        });

        const result = await safeMergePull({
            owner: "o",
            repo: "r",
            number: 1,
            method: "rebase",
            noRestack: true,
            deleteBranch: false,
            client,
        });

        expect(result.rebaseMode).toBe("api-rewrite");
        expect(result.dependentsRestacked).toEqual([]);
        const ops = calls.map((c) => c.op);
        expect(ops).toContain("mergePull");
        expect(ops).not.toContain("fastForwardBase");
        const mergeCall = calls.find((c) => c.op === "mergePull");
        expect(mergeCall?.args[1]).toEqual({ method: "rebase", commitTitle: undefined, commitMessage: undefined });
    });

    test("with --delete-branch: retarget ALL dependents BEFORE delete", async () => {
        const { client, calls } = makeMock({
            pr: basePr(),
            dependents: [
                dep({ number: 2, title: "PR B", headRef: "branch-b", baseRef: "branch-a" }),
                dep({ number: 5, title: "PR X also on A", headRef: "branch-x", baseRef: "branch-a" }),
            ],
        });

        const result = await safeMergePull({
            owner: "o",
            repo: "r",
            number: 1,
            method: "merge",
            deleteBranch: true,
            client,
        });

        expect(result.branchDeleted).toBe(true);
        expect(result.retargeted.map((r) => r.number)).toEqual([2, 5]);
        expect(result.retargeted.every((r) => r.ok && r.toBase === "main")).toBe(true);

        const ops = calls.map((c) => c.op);
        const lastRetarget = ops.lastIndexOf("updatePullBase");
        const deleteIdx = ops.indexOf("deleteBranch");
        expect(deleteIdx).toBeGreaterThan(lastRetarget);
        expect(calls.find((c) => c.op === "deleteBranch")?.args[0]).toBe("branch-a");
    });

    test("does NOT delete branch when any retarget fails (avoids closing children)", async () => {
        const logs: string[] = [];
        const { client, calls } = makeMock({
            pr: basePr(),
            dependents: [
                dep({ number: 2, title: "PR B", headRef: "branch-b", baseRef: "branch-a" }),
                dep({ number: 3, title: "PR C", headRef: "branch-c", baseRef: "branch-a" }),
            ],
            failRetarget: [3],
        });

        const result = await safeMergePull({
            owner: "o",
            repo: "r",
            number: 1,
            method: "squash",
            deleteBranch: true,
            client,
            log: (m) => logs.push(m),
        });

        expect(result.branchDeleted).toBe(false);
        expect(result.retargeted.find((r) => r.number === 3)?.ok).toBe(false);
        expect(result.remainingWork.some((l) => l.startsWith("MERGED #1"))).toBe(true);
        expect(calls.map((c) => c.op)).not.toContain("deleteBranch");
        // Merge still happened — failure is post-merge remaining work, not a botched merge.
        expect(calls.map((c) => c.op)).toContain("mergePull");
        expect(logs.some((l) => l.includes("MERGED #1"))).toBe(true);
    });

    test("independent PR (no dependents) stack-safe rebases via FF and can delete branch", async () => {
        const headSha = "ffffffffffffffffffffffffffffffffffffffff";
        const { client, calls } = makeMock({
            pr: basePr({ number: 6, title: "Independent", headRef: "branch-f", baseRef: "main", headSha }),
            dependents: [],
        });
        const { restack } = makeRestackMock();

        const result = await safeMergePull({
            owner: "o",
            repo: "r",
            number: 6,
            method: "rebase",
            deleteBranch: true,
            client,
            restack,
        });

        expect(result.dependentsFound).toEqual([]);
        expect(result.retargeted).toEqual([]);
        expect(result.dependentsRestacked).toEqual([]);
        expect(result.branchDeleted).toBe(true);
        expect(calls.map((c) => c.op)).toContain("fastForwardBase");
        expect(calls.map((c) => c.op)).toContain("deleteBranch");
        expect(calls.map((c) => c.op)).not.toContain("mergePull");
    });

    test("stack-safe rebase: head restack rewrites tip then FF uses new SHA", async () => {
        const oldSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        const newSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        const { client, calls } = makeMock({
            pr: basePr({ headSha: oldSha }),
            dependents: [],
        });
        const { restack, calls: restackCalls } = makeRestackMock({
            byBranch: {
                "branch-a": { rebased: true, headSha: newSha, alreadyLinear: false },
            },
        });

        const result = await safeMergePull({
            owner: "o",
            repo: "r",
            number: 1,
            method: "rebase",
            client,
            restack,
        });

        expect(result.headRestack?.rebased).toBe(true);
        expect(result.headRestack?.headSha).toBe(newSha);
        expect(calls.find((c) => c.op === "fastForwardBase")?.args).toEqual(["main", newSha]);
        expect(restackCalls[0].expectedHeadSha).toBe(oldSha);
    });

    test("stack-safe rebase: failed dependent restack blocks branch delete and reports remaining work", async () => {
        const { client, calls } = makeMock({
            pr: basePr(),
            dependents: [dep({ number: 2, title: "PR B", headRef: "branch-b", baseRef: "branch-a" })],
        });
        const { restack } = makeRestackMock({ failBranches: ["branch-b"] });

        const result = await safeMergePull({
            owner: "o",
            repo: "r",
            number: 1,
            method: "rebase",
            restackChildren: true,
            deleteBranch: true,
            client,
            restack,
        });

        expect(result.branchDeleted).toBe(false);
        expect(result.retargeted[0].ok).toBe(true);
        expect(result.dependentsRestacked[0].ok).toBe(false);
        expect(result.remainingWork.some((l) => l.startsWith("MERGED #1"))).toBe(true);
        expect(result.remainingWork.some((l) => /Restack #2/.test(l))).toBe(true);
        expect(calls.map((c) => c.op)).toContain("fastForwardBase");
        expect(calls.map((c) => c.op)).toContain("updatePullBase");
        expect(calls.map((c) => c.op)).not.toContain("deleteBranch");
    });

    test("rejects already-merged / closed / draft PRs before calling merge", async () => {
        for (const pr of [
            basePr({ merged: true, state: "closed" }),
            basePr({ state: "closed", merged: false }),
            basePr({ draft: true }),
        ]) {
            const { client, calls } = makeMock({ pr });
            await expect(
                safeMergePull({ owner: "o", repo: "r", number: 1, method: "merge", client })
            ).rejects.toThrow();
            expect(calls.map((c) => c.op)).not.toContain("mergePull");
        }
    });

    test("linear stack A←B←C: merging A retargets only B (base=A), not C", async () => {
        // C is based on B, not A — only PRs with base=branch-a are dependents of A.
        const { client, calls } = makeMock({
            pr: basePr({ number: 1, headRef: "branch-a", baseRef: "main" }),
            dependents: [dep({ number: 2, title: "PR B", headRef: "branch-b", baseRef: "branch-a" })],
            // C exists in the repo but is NOT returned by listOpenPullsByBase("branch-a")
        });
        const { restack } = makeRestackMock();

        const result = await safeMergePull({
            owner: "o",
            repo: "r",
            number: 1,
            method: "rebase",
            deleteBranch: true,
            client,
            restack,
        });

        expect(result.retargeted.map((r) => r.number)).toEqual([2]);
        const retargetCalls = calls.filter((c) => c.op === "updatePullBase");
        expect(retargetCalls).toHaveLength(1);
        expect(retargetCalls[0].args).toEqual([2, "main"]);
    });

    test("an explicit --body skips the commit fetch, so a failing collector can never block it", async () => {
        const { client, calls } = makeMock({ pr: basePr(), commits: [] });
        client.listPullCommits = async () => {
            throw new Error("Could not collect every PR commit");
        };

        const result = await safeMergePull({
            owner: "o",
            repo: "r",
            number: 1,
            method: "squash",
            commitMessage: "* hand-written",
            client,
        });

        expect(calls.map((c) => c.op)).not.toContain("listPullCommits");
        expect(calls.find((c) => c.op === "mergePull")?.args[1]).toEqual({
            method: "squash",
            commitTitle: "PR A (#1)",
            commitMessage: "* hand-written",
            expectedHeadSha: HEAD_SHA,
        });
        expect(result.squashMessage?.titleGenerated).toBe(true);
        expect(result.squashMessage?.bodyGenerated).toBe(false);
    });

    test("passes explicit squash subject/body through to merge API unchanged", async () => {
        const { client, calls } = makeMock({
            pr: basePr(),
            commits: [{ sha: "1111111", subject: "ignored: explicit values win" }],
        });

        const result = await safeMergePull({
            owner: "o",
            repo: "r",
            number: 1,
            method: "squash",
            commitTitle: "feat: ship it (#1)",
            commitMessage: "commit one\ncommit two",
            client,
        });

        const mergeCall = calls.find((c) => c.op === "mergePull");
        expect(mergeCall?.args[1]).toEqual({
            method: "squash",
            commitTitle: "feat: ship it (#1)",
            commitMessage: "commit one\ncommit two",
            expectedHeadSha: HEAD_SHA,
        });
        expect(result.squashMessage?.titleGenerated).toBe(false);
        expect(result.squashMessage?.bodyGenerated).toBe(false);
    });

    test("squash without --subject/--body sends PR title (#N) and one bullet per commit", async () => {
        const logs: string[] = [];
        const { client, calls } = makeMock({
            pr: basePr({ number: 42, title: "feat: widgets — bigger and `better`" }),
            commits: [
                { sha: "1111111", subject: "feat(widgets): add the frame" },
                { sha: "2222222", subject: 'fix(widgets): "quoted" subject with $HOME and `ticks`' },
                { sha: "3333333", subject: "chore: trailing whitespace   " },
            ],
        });

        const result = await safeMergePull({
            owner: "o",
            repo: "r",
            number: 42,
            method: "squash",
            client,
            log: (m) => logs.push(m),
        });

        const mergeCall = calls.find((c) => c.op === "mergePull");
        expect(mergeCall?.args[1]).toEqual({
            method: "squash",
            commitTitle: "feat: widgets — bigger and `better` (#42)",
            commitMessage:
                "* feat(widgets): add the frame\n" +
                '* fix(widgets): "quoted" subject with $HOME and `ticks`\n' +
                "* chore: trailing whitespace",
            // Bound to the head the commits were read from: a push in between fails the merge.
            expectedHeadSha: HEAD_SHA,
        });
        expect(result.squashMessage).toEqual({
            title: "feat: widgets — bigger and `better` (#42)",
            body:
                "* feat(widgets): add the frame\n" +
                '* fix(widgets): "quoted" subject with $HOME and `ticks`\n' +
                "* chore: trailing whitespace",
            titleGenerated: true,
            bodyGenerated: true,
            commitCount: 3,
        });
        // The commit list is fetched before the merge call, never after.
        const ops = calls.map((c) => c.op);
        expect(ops.indexOf("listPullCommits")).toBeLessThan(ops.indexOf("mergePull"));
        expect(logs.some((l) => l.includes("squash subject (generated from PR title)"))).toBe(true);
        expect(logs.some((l) => l.includes("squash body (generated from 3 commit subject(s))"))).toBe(true);
    });

    test("squash keeps a PR title that already ends with (#N) and honours only one of the overrides", async () => {
        const { client, calls } = makeMock({
            pr: basePr({ number: 7, title: "fix: thing (#7)" }),
            commits: [{ sha: "1111111", subject: "fix: thing" }],
        });

        const result = await safeMergePull({
            owner: "o",
            repo: "r",
            number: 7,
            method: "squash",
            commitMessage: "",
            client,
        });

        const mergeCall = calls.find((c) => c.op === "mergePull");
        expect(mergeCall?.args[1]).toEqual({
            method: "squash",
            commitTitle: "fix: thing (#7)",
            commitMessage: "",
            expectedHeadSha: HEAD_SHA,
        });
        expect(result.squashMessage?.titleGenerated).toBe(true);
        expect(result.squashMessage?.bodyGenerated).toBe(false);
    });

    test("a head pushed after the commit list was read fails the squash instead of inheriting the body", async () => {
        const { client, calls } = makeMock({
            pr: basePr({ number: 9, title: "feat: nine" }),
            commits: [{ sha: "1111111", subject: "one" }],
            dependents: [dep({ number: 10 })],
        });
        const originalMerge = client.mergePull;
        client.mergePull = async (owner, repo, number, options) => {
            // GitHub answers 409 when `sha` no longer matches the head.
            if (
                options.expectedHeadSha !== undefined &&
                options.expectedHeadSha !== "ffffffffffffffffffffffffffffffffffffffff"
            ) {
                calls.push({ op: "mergePull", args: [number, options] });
                throw new Error("Head branch was modified. Review and try the merge again.");
            }

            return originalMerge(owner, repo, number, options);
        };

        await expect(safeMergePull({ owner: "o", repo: "r", number: 9, method: "squash", client })).rejects.toThrow(
            /Head branch was modified/
        );

        const ops = calls.map((c) => c.op);
        expect(ops).toContain("mergePull");
        expect(ops).not.toContain("updatePullBase");
        expect(ops).not.toContain("deleteBranch");
    });

    test("--merge does not list commits and sends no generated message", async () => {
        const { client, calls } = makeMock({
            pr: basePr(),
            commits: [{ sha: "1111111", subject: "would be a bullet under --squash" }],
        });

        const result = await safeMergePull({ owner: "o", repo: "r", number: 1, method: "merge", client });

        expect(calls.map((c) => c.op)).not.toContain("listPullCommits");
        expect(calls.find((c) => c.op === "mergePull")?.args[1]).toEqual({
            method: "merge",
            commitTitle: undefined,
            commitMessage: undefined,
        });
        expect(result.squashMessage).toBeUndefined();
    });

    test.each([
        ["squash", false],
        ["merge", false],
        ["rebase", false],
        ["rebase", true],
        ["ff-only", false],
    ] as Array<[MergeMethod, boolean]>)(
        "dry run with method=%s noRestack=%s reaches no irreversible primitive",
        async (method, noRestack) => {
            const { client, calls } = makeMock({
                pr: basePr(),
                commits: [{ sha: "1111111", subject: "one" }],
                dependents: [dep({ number: 2 })],
            });
            // Every write throws: a dry run that reaches one fails loudly instead of passing quietly.
            const armed = (op: string) => async () => {
                throw new Error(`dry run reached ${op}`);
            };
            client.mergePull = armed("mergePull");
            client.fastForwardBase = armed("fastForwardBase");
            client.updatePullBase = armed("updatePullBase");
            client.unstack = armed("unstack");
            client.deleteBranch = armed("deleteBranch");
            const restack: StackRestackOps = { restackBranch: armed("restackBranch") };

            const result = await safeMergePull({
                owner: "o",
                repo: "r",
                number: 1,
                method,
                noRestack,
                deleteBranch: true,
                dryRun: true,
                client,
                restack,
            });

            expect(result.dryRun).toBe(true);
            expect(result.mergeSha).toBe("");
            expect(result.dependentsFound.map((d) => d.number)).toEqual([2]);
            const reads = new Set(["getPull", "listOpenPullsByBase", "listPullCommits"]);
            expect(calls.every((c) => reads.has(c.op))).toBe(true);
        }
    );

    test("the same armed spies fire on a real rebase, so the dry-run control is not vacuous", async () => {
        const { client } = makeMock({ pr: basePr() });
        const restack: StackRestackOps = {
            restackBranch: async () => {
                throw new Error("dry run reached restackBranch");
            },
        };

        await expect(
            safeMergePull({ owner: "o", repo: "r", number: 1, method: "rebase", client, restack })
        ).rejects.toThrow(/reached restackBranch/);
    });

    test("dry run resolves the squash message and dependents but never writes", async () => {
        const { client, calls } = makeMock({
            pr: basePr({ number: 5, title: "feat: five" }),
            commits: [{ sha: "1111111", subject: "one" }],
            dependents: [dep({ number: 6 })],
        });

        const result = await safeMergePull({
            owner: "o",
            repo: "r",
            number: 5,
            method: "squash",
            deleteBranch: true,
            dryRun: true,
            client,
        });

        const ops = calls.map((c) => c.op);
        expect(ops).toEqual(["getPull", "listOpenPullsByBase", "listPullCommits"]);
        expect(result.dryRun).toBe(true);
        expect(result.mergeSha).toBe("");
        expect(result.squashMessage?.title).toBe("feat: five (#5)");
        expect(result.squashMessage?.body).toBe("* one");
        expect(result.dependentsFound.map((d) => d.number)).toEqual([6]);
        expect(result.retargeted).toEqual([]);
        expect(result.branchDeleted).toBe(false);
    });

    test("detects child closed after retarget (simulates the gh bug path)", async () => {
        const { client } = makeMock({
            pr: basePr(),
            dependents: [dep({ number: 2, title: "PR B", headRef: "branch-b", baseRef: "branch-a" })],
            afterRetarget: (d) => ({ ...d, state: "closed" }),
        });

        const result = await safeMergePull({
            owner: "o",
            repo: "r",
            number: 1,
            method: "merge",
            deleteBranch: true,
            client,
        });

        expect(result.branchDeleted).toBe(false);
        expect(result.retargeted[0].ok).toBe(false);
        expect(result.retargeted[0].error).toMatch(/no longer open/);
        expect(result.remainingWork.some((l) => l.startsWith("MERGED #1"))).toBe(true);
        expect(result.remainingWork.some((l) => /Child #2 is still closed/.test(l))).toBe(true);
    });

    test("--ff-only: uses fastForwardBase (not mergePull), then retargets dependents", async () => {
        const logs: string[] = [];
        const headSha = "cccccccccccccccccccccccccccccccccccccccc";
        const { client, calls } = makeMock({
            pr: basePr({ headSha }),
            dependents: [dep({ number: 2, title: "PR B", headRef: "branch-b", baseRef: "branch-a" })],
        });

        const result = await safeMergePull({
            owner: "o",
            repo: "r",
            number: 1,
            method: "ff-only",
            deleteBranch: false,
            client,
            log: (m) => logs.push(m),
        });

        expect(result.method).toBe("ff-only");
        expect(result.mergeSha).toBe(headSha);
        expect(result.retargeted).toEqual([
            {
                number: 2,
                title: "PR B",
                fromBase: "branch-a",
                toBase: "main",
                ok: true,
                state: "open",
            },
        ]);

        const ops = calls.map((c) => c.op);
        expect(ops).toContain("fastForwardBase");
        expect(ops).not.toContain("mergePull");
        expect(ops).toContain("updatePullBase");
        expect(ops).not.toContain("deleteBranch");

        const ffIdx = ops.indexOf("fastForwardBase");
        const retargetIdx = ops.indexOf("updatePullBase");
        expect(ffIdx).toBeLessThan(retargetIdx);

        const ffCall = calls.find((c) => c.op === "fastForwardBase");
        expect(ffCall?.args).toEqual(["main", headSha]);

        expect(logs.some((l) => l.includes("Fast-forwarding"))).toBe(true);
        expect(logs.some((l) => l.includes("Keeping remote branch"))).toBe(true);
    });

    test("--ff-only + --delete-branch: retarget before delete", async () => {
        const { client, calls } = makeMock({
            pr: basePr(),
            dependents: [dep({ number: 2, title: "PR B", headRef: "branch-b", baseRef: "branch-a" })],
        });

        const result = await safeMergePull({
            owner: "o",
            repo: "r",
            number: 1,
            method: "ff-only",
            deleteBranch: true,
            client,
        });

        expect(result.branchDeleted).toBe(true);
        const ops = calls.map((c) => c.op);
        expect(ops.indexOf("deleteBranch")).toBeGreaterThan(ops.indexOf("updatePullBase"));
        expect(ops).not.toContain("mergePull");
    });

    test("--ff-only fails closed when fastForwardBase rejects (diverged)", async () => {
        const { client, calls } = makeMock({
            pr: basePr(),
            dependents: [dep({ number: 2, title: "PR B", headRef: "branch-b", baseRef: "branch-a" })],
            failFf: "Cannot fast-forward: compare status=diverged",
        });

        await expect(
            safeMergePull({
                owner: "o",
                repo: "r",
                number: 1,
                method: "ff-only",
                deleteBranch: true,
                client,
            })
        ).rejects.toThrow(/diverged/);

        const ops = calls.map((c) => c.op);
        expect(ops).toContain("fastForwardBase");
        expect(ops).not.toContain("updatePullBase");
        expect(ops).not.toContain("deleteBranch");
    });

    test("native-stack 422: unstack then PATCH keeps the child OPEN with the same number", async () => {
        const logs: string[] = [];
        const { client, calls } = makeMock({
            pr: basePr(),
            dependents: [
                dep({
                    number: 2,
                    title: "PR B",
                    headRef: "branch-b",
                    baseRef: "branch-a",
                    stackNumber: 8,
                }),
            ],
            stackBaseErrorUntilUnstack: [2],
            stackByPr: { 2: 8 },
        });
        const { restack } = makeRestackMock();

        const result = await safeMergePull({
            owner: "o",
            repo: "r",
            number: 1,
            method: "rebase",
            restackChildren: true,
            deleteBranch: false,
            client,
            restack,
            log: (m) => logs.push(m),
        });

        expect(result.retargeted).toEqual([
            {
                number: 2,
                title: "PR B",
                fromBase: "branch-a",
                toBase: "main",
                ok: true,
                state: "open",
                stackNumber: 8,
            },
        ]);
        expect(result.remainingWork).toEqual([]);
        expect(result.dependentsRestacked[0]?.ok).toBe(true);

        const ops = calls.map((c) => c.op);
        expect(ops.filter((op) => op === "updatePullBase")).toHaveLength(2);
        expect(ops).toContain("unstack");
        expect(calls.find((c) => c.op === "unstack")?.args).toEqual([8]);
        expect(ops).not.toContain("deleteBranch");
        expect(logs.some((l) => l.includes(NATIVE_STACK_BASE_ERROR))).toBe(true);
        expect(logs.some((l) => l.includes("unstacking native stack #8"))).toBe(true);
        expect(logs.some((l) => l.includes("does not close PRs"))).toBe(true);
    });

    test("--ff-only native-stack 422: same unstack-then-PATCH path, child stays OPEN", async () => {
        const { client, calls } = makeMock({
            pr: basePr(),
            dependents: [dep({ number: 2, title: "PR B", headRef: "branch-b", baseRef: "branch-a", stackNumber: 8 })],
            stackBaseErrorUntilUnstack: [2],
            stackByPr: { 2: 8 },
        });

        const result = await safeMergePull({
            owner: "o",
            repo: "r",
            number: 1,
            method: "ff-only",
            deleteBranch: false,
            client,
        });

        expect(result.method).toBe("ff-only");
        expect(result.retargeted[0]).toMatchObject({ number: 2, ok: true, state: "open", toBase: "main" });
        expect(result.remainingWork).toEqual([]);
        expect(calls.map((c) => c.op)).toContain("unstack");
        expect(calls.map((c) => c.op)).toContain("fastForwardBase");
        expect(calls.map((c) => c.op)).not.toContain("mergePull");
        expect(calls.map((c) => c.op)).not.toContain("deleteBranch");
    });

    test("linear native stack A←B←C: merging A unstacks once and retargets only B", async () => {
        const { client, calls } = makeMock({
            pr: basePr({ number: 1, headRef: "branch-a", baseRef: "main" }),
            dependents: [dep({ number: 2, title: "PR B", headRef: "branch-b", baseRef: "branch-a", stackNumber: 8 })],
            stackBaseErrorUntilUnstack: [2],
            stackByPr: { 2: 8 },
        });
        const { restack } = makeRestackMock();

        const result = await safeMergePull({
            owner: "o",
            repo: "r",
            number: 1,
            method: "rebase",
            deleteBranch: true,
            client,
            restack,
        });

        expect(result.retargeted.map((r) => r.number)).toEqual([2]);
        expect(result.retargeted[0].ok).toBe(true);
        expect(result.branchDeleted).toBe(true);
        expect(calls.filter((c) => c.op === "unstack")).toHaveLength(1);
        expect(calls.filter((c) => c.op === "updatePullBase").map((c) => c.args[0])).toEqual([2, 2]);
    });

    test("native-stack 422 with failed unstack: MERGED remaining work, child still OPEN, no throw", async () => {
        const logs: string[] = [];
        const { client, calls } = makeMock({
            pr: basePr(),
            dependents: [dep({ number: 2, title: "PR B", headRef: "branch-b", baseRef: "branch-a", stackNumber: 8 })],
            stackBaseErrorUntilUnstack: [2],
            stackByPr: { 2: 8 },
            failUnstack: true,
        });

        const result = await safeMergePull({
            owner: "o",
            repo: "r",
            number: 1,
            method: "ff-only",
            deleteBranch: false,
            client,
            log: (m) => logs.push(m),
        });

        expect(result.retargeted[0].ok).toBe(false);
        expect(result.retargeted[0].error).toContain(NATIVE_STACK_BASE_ERROR);
        expect(result.remainingWork.some((l) => l.startsWith("MERGED #1"))).toBe(true);
        expect(result.remainingWork.some((l) => l.includes("still OPEN"))).toBe(true);
        expect(result.remainingWork).toContain("gh api -X POST repos/o/r/stacks/8/unstack");
        expect(result.remainingWork).toContain("gh api -X PATCH repos/o/r/pulls/2 -f base='main'");
        expect(result.remainingWork.join("\n")).toMatch(/Do not close and reopen/);
        expect(calls.map((c) => c.op)).toContain("fastForwardBase");
        expect(calls.map((c) => c.op)).not.toContain("deleteBranch");
        expect(logs.some((l) => l.includes("MERGED #1"))).toBe(true);
        expect(logs.some((l) => l.includes("still OPEN"))).toBe(true);
    });

    test("failed unstack after getPullStackNumber still emits the resolved stack id", async () => {
        const { client } = makeMock({
            pr: basePr(),
            dependents: [dep({ number: 2, title: "PR B", headRef: "branch-b", baseRef: "branch-a" })],
            stackBaseErrorUntilUnstack: [2],
            stackByPr: { 2: 8 },
            failUnstack: true,
        });

        const result = await safeMergePull({
            owner: "o",
            repo: "r",
            number: 1,
            method: "ff-only",
            deleteBranch: false,
            client,
        });

        expect(result.retargeted[0].ok).toBe(false);
        expect(result.retargeted[0].stackNumber).toBe(8);
        expect(result.remainingWork).toContain("gh api -X POST repos/o/r/stacks/8/unstack");
        expect(result.remainingWork.join("\n")).not.toContain("stacks/<stack-number>/unstack");
    });

    test("two dependents in different native stacks: unstack each stack before PATCH succeeds", async () => {
        const { client, calls } = makeMock({
            pr: basePr(),
            dependents: [
                dep({ number: 2, title: "PR B", headRef: "branch-b", baseRef: "branch-a", stackNumber: 8 }),
                dep({ number: 3, title: "PR C", headRef: "branch-c", baseRef: "branch-a", stackNumber: 9 }),
            ],
            stackBaseErrorUntilUnstack: [2, 3],
            stackByPr: { 2: 8, 3: 9 },
        });

        const result = await safeMergePull({
            owner: "o",
            repo: "r",
            number: 1,
            method: "ff-only",
            deleteBranch: false,
            client,
        });

        expect(result.retargeted.every((r) => r.ok && r.state === "open")).toBe(true);
        expect(result.remainingWork).toEqual([]);
        expect(calls.filter((c) => c.op === "unstack").map((c) => c.args[0])).toEqual([8, 9]);
        expect(calls.filter((c) => c.op === "updatePullBase")).toHaveLength(4);
    });
});

describe("safeMergePull: edge paths", () => {
    test("--ff-only says --subject and --body are ignored", async () => {
        const logs: string[] = [];
        const { client } = makeMock({ pr: basePr() });

        await safeMergePull({
            owner: "o",
            repo: "r",
            number: 1,
            method: "ff-only",
            commitTitle: "feat: x",
            client,
            log: (m) => logs.push(m),
        });

        expect(logs).toContain("  note: --subject/--body ignored for --ff-only (no merge commit)");
    });

    test("stack-safe --rebase says --subject and --body are ignored", async () => {
        const logs: string[] = [];
        const { client } = makeMock({ pr: basePr() });
        const { restack } = makeRestackMock();

        await safeMergePull({
            owner: "o",
            repo: "r",
            number: 1,
            method: "rebase",
            commitMessage: "body",
            client,
            restack,
            log: (m) => logs.push(m),
        });

        expect(logs).toContain(
            "  note: --subject/--body ignored for stack-safe --rebase (FF merge, no rewrite commit)"
        );
    });

    test("a PR with no head SHA cannot be fast-forwarded and nothing is written", async () => {
        const { client, calls } = makeMock({ pr: basePr({ headSha: "" }) });

        await expect(safeMergePull({ owner: "o", repo: "r", number: 1, method: "ff-only", client })).rejects.toThrow(
            "PR #1 has no head SHA — cannot fast-forward"
        );
        expect(calls.map((c) => c.op)).not.toContain("fastForwardBase");
    });

    test("a PR with no head SHA cannot be stack-safe rebased and nothing is restacked", async () => {
        const { client, calls } = makeMock({ pr: basePr({ headSha: "" }) });
        const { restack, calls: restackCalls } = makeRestackMock();

        await expect(
            safeMergePull({ owner: "o", repo: "r", number: 1, method: "rebase", client, restack })
        ).rejects.toThrow("PR #1 has no head SHA — cannot stack-safe rebase");
        expect(restackCalls).toEqual([]);
        expect(calls.map((c) => c.op)).not.toContain("fastForwardBase");
    });

    test("a merge call that answers merged=false is an error and no dependent is retargeted", async () => {
        const { client, calls } = makeMock({
            pr: basePr(),
            dependents: [dep({ number: 2 })],
            mergeResult: { sha: "", merged: false, message: "Base branch was modified" },
        });

        await expect(safeMergePull({ owner: "o", repo: "r", number: 1, method: "merge", client })).rejects.toThrow(
            "Merge returned merged=false: Base branch was modified"
        );
        expect(calls.map((c) => c.op)).not.toContain("updatePullBase");
    });

    test("a native-stack error for a child with no findable stack is reported with the generic recovery commands", async () => {
        const { client, calls } = makeMock({
            pr: basePr(),
            dependents: [dep({ number: 2, headRef: "branch-b", baseRef: "branch-a" })],
            stackBaseErrorUntilUnstack: [2],
            stackByPr: { 2: null },
        });

        const result = await safeMergePull({ owner: "o", repo: "r", number: 1, method: "merge", client });

        expect(result.retargeted[0].ok).toBe(false);
        expect(result.retargeted[0].error).toContain(NATIVE_STACK_BASE_ERROR);
        expect(result.remainingWork).toContain("gh api repos/o/r/pulls/2 --jq .stack.number");
        expect(result.remainingWork).toContain("gh api -X POST repos/o/r/stacks/<stack-number>/unstack");
        expect(calls.map((c) => c.op)).toContain("getPullStackNumber");
        expect(calls.map((c) => c.op)).not.toContain("unstack");
    });

    test("a retarget that comes back on another base is a failure with the plain PATCH command to fix it", async () => {
        const logs: string[] = [];
        const { client, calls } = makeMock({
            pr: basePr(),
            dependents: [dep({ number: 2, headRef: "branch-b", baseRef: "branch-a" })],
            afterRetarget: (d) => ({ ...d, baseRef: "develop" }),
        });

        const result = await safeMergePull({
            owner: "o",
            repo: "r",
            number: 1,
            method: "merge",
            deleteBranch: true,
            client,
            log: (m) => logs.push(m),
        });

        expect(result.retargeted[0]).toMatchObject({ ok: false, error: "base is develop, expected main" });
        expect(result.remainingWork).toContain("gh api -X PATCH repos/o/r/pulls/2 -f base='main'");
        expect(result.branchDeleted).toBe(false);
        expect(result.branchDeleteError).toBe("skipped branch delete: 1 retarget(s) failed");
        expect(calls.map((c) => c.op)).not.toContain("deleteBranch");
        expect(logs).toContain("    ✘ base is develop, expected main");
    });

    test("a child whose head SHA the list omitted is looked up with getPull before it is restacked", async () => {
        const { client, calls } = makeMock({
            pr: basePr(),
            dependents: [dep({ number: 2, headRef: "branch-b", baseRef: "branch-a", headSha: undefined })],
        });
        const { restack, calls: restackCalls } = makeRestackMock();

        const result = await safeMergePull({
            owner: "o",
            repo: "r",
            number: 1,
            method: "rebase",
            restackChildren: true,
            client,
            restack,
        });

        const child = restackCalls.find((c) => c.branch === "branch-b");
        expect(child?.expectedHeadSha).toBe("d".repeat(40));
        expect(calls.filter((c) => c.op === "getPull").map((c) => c.args[0])).toEqual([1, 2]);
        expect(result.dependentsRestacked[0]).toMatchObject({ number: 2, ok: true, rebased: false });
    });

    test("a child whose head SHA cannot be looked up is reported as a failed restack, not thrown", async () => {
        const logs: string[] = [];
        const { client, calls } = makeMock({
            pr: basePr(),
            dependents: [dep({ number: 2, headRef: "branch-b", baseRef: "branch-a", headSha: undefined })],
        });
        const getPull = client.getPull;
        client.getPull = async (owner, repo, number) => {
            if (number === 2) {
                throw new Error("lookup failed");
            }

            return getPull(owner, repo, number);
        };
        const { restack, calls: restackCalls } = makeRestackMock();

        const result = await safeMergePull({
            owner: "o",
            repo: "r",
            number: 1,
            method: "rebase",
            restackChildren: true,
            deleteBranch: true,
            client,
            restack,
            log: (m) => logs.push(m),
        });

        expect(result.dependentsRestacked).toEqual([
            {
                number: 2,
                title: "PR 2",
                headRef: "branch-b",
                ok: false,
                rebased: false,
                error: "could not resolve head SHA: lookup failed",
            },
        ]);
        expect(restackCalls.map((c) => c.branch)).toEqual(["branch-a"]);
        expect(result.remainingWork).toContain(
            "Restack #2 (branch-b) failed: could not resolve head SHA: lookup failed"
        );
        expect(result.branchDeleteError).toBe("skipped branch delete: 1 restack(s) failed");
        expect(calls.map((c) => c.op)).not.toContain("deleteBranch");
        expect(logs).toContain("  #2 restack ✘ no head SHA");
    });

    test("a branch delete that fails is reported and the merge result stays", async () => {
        const logs: string[] = [];
        const { client } = makeMock({ pr: basePr(), failDelete: true });

        const result = await safeMergePull({
            owner: "o",
            repo: "r",
            number: 1,
            method: "merge",
            deleteBranch: true,
            client,
            log: (m) => logs.push(m),
        });

        expect(result.branchDeleted).toBe(false);
        expect(result.branchDeleteError).toBe("ref heads/branch-a not found");
        expect(result.mergeSha).toBe("abc123deadbeef");
        expect(result.remainingWork).toEqual([]);
        expect(logs).toContain("  ✘ delete failed: ref heads/branch-a not found");
    });

    test("without an injected client the merge, the retarget and the delete go through the octokit write client", async () => {
        const pull = {
            number: 1,
            title: "PR A",
            state: "open",
            merged: false,
            draft: false,
            mergeable: true,
            head: { ref: "branch-a", sha: HEAD_SHA },
            base: { ref: "main", sha: "b".repeat(40) },
            commits: 1,
            html_url: "https://github.com/o/r/pull/1",
        };
        const child = {
            number: 2,
            title: "PR B",
            state: "open",
            head: { ref: "branch-b", sha: "c".repeat(40) },
            base: { ref: "branch-a" },
            html_url: "https://github.com/o/r/pull/2",
        };
        octokitAnswers.set("pulls.get", () => ({ data: pull }));
        octokitAnswers.set("pulls.list", (params) => ({ data: params.base === "branch-a" ? [child] : [] }));
        octokitAnswers.set("pulls.merge", () => ({ data: { sha: "m".repeat(40), merged: true, message: "merged!" } }));
        octokitAnswers.set("pulls.update", () => ({ data: { ...child, base: { ref: "main" } } }));
        octokitAnswers.set("git.deleteRef", () => ({ data: {} }));

        const result = await safeMergePull({
            owner: "o",
            repo: "r",
            number: 1,
            method: "merge",
            deleteBranch: true,
        });

        expect(result.mergeSha).toBe("m".repeat(40));
        expect(result.retargeted).toEqual([
            { number: 2, title: "PR B", fromBase: "branch-a", toBase: "main", ok: true, state: "open" },
        ]);
        expect(result.branchDeleted).toBe(true);
        expect(octokitCalls.map((c) => c.op)).toEqual([
            "pulls.get",
            "pulls.list",
            "pulls.merge",
            "pulls.list",
            "pulls.update",
            "git.deleteRef",
        ]);
        expect(octokitCalls.find((c) => c.op === "pulls.update")?.params).toMatchObject({
            pull_number: 2,
            base: "main",
        });
    });
});

describe("createOctokitMergeClient", () => {
    const pullRef: PullRef = basePr({ number: 5, baseSha: "base-sha", headSha: "head-sha", commitCount: 2 });

    test("getPull maps the REST payload and reads the native stack number", async () => {
        octokitAnswers.set("pulls.get", () => ({
            data: {
                number: 5,
                title: "Add cache",
                state: "open",
                merged: true,
                head: { ref: "feat/x", sha: "head-sha" },
                base: { ref: "main", sha: "base-sha" },
                commits: 3,
                html_url: "https://github.com/o/r/pull/5",
                stack: { number: 8 },
            },
        }));

        const pull = await createOctokitMergeClient().getPull("o", "r", 5);

        expect(pull).toEqual({
            number: 5,
            title: "Add cache",
            state: "open",
            merged: true,
            draft: false,
            mergeable: null,
            headRef: "feat/x",
            baseRef: "main",
            headSha: "head-sha",
            baseSha: "base-sha",
            commitCount: 3,
            htmlUrl: "https://github.com/o/r/pull/5",
            stackNumber: 8,
        });
        expect(octokitCalls[0]).toEqual({ op: "pulls.get", params: { owner: "o", repo: "r", pull_number: 5 } });
    });

    test("getPullStackNumber is the stack number of the PR, or null when it is not stacked", async () => {
        const body = { number: 5, head: { ref: "h", sha: "s" }, base: { ref: "b", sha: "s" }, commits: 1 };
        const client = createOctokitMergeClient();

        octokitAnswers.set("pulls.get", () => ({ data: { ...body, stack: { number: 8 } } }));
        expect(await client.getPullStackNumber("o", "r", 5)).toBe(8);

        octokitAnswers.set("pulls.get", () => ({ data: body }));
        expect(await client.getPullStackNumber("o", "r", 5)).toBeNull();
    });

    test("listOpenPullsByBase reads every page until one comes back short", async () => {
        const item = (number: number) => ({
            number,
            title: `PR ${number}`,
            head: { ref: `b${number}`, sha: `s${number}` },
            base: { ref: "branch-a" },
            html_url: `https://github.com/o/r/pull/${number}`,
            state: "open",
            ...(number === 1 ? { stack: { number: 4 } } : {}),
        });
        octokitAnswers.set("pulls.list", (params) => ({
            data: params.page === 1 ? Array.from({ length: 100 }, (_, i) => item(i + 1)) : [item(101)],
        }));

        const pulls = await createOctokitMergeClient().listOpenPullsByBase("o", "r", "branch-a");

        expect(pulls).toHaveLength(101);
        expect(pulls[0]).toEqual({
            number: 1,
            title: "PR 1",
            headRef: "b1",
            baseRef: "branch-a",
            htmlUrl: "https://github.com/o/r/pull/1",
            state: "open",
            headSha: "s1",
            stackNumber: 4,
        });
        expect(pulls[100].number).toBe(101);
        expect(octokitCalls.map((c) => c.params)).toEqual([
            { owner: "o", repo: "r", state: "open", base: "branch-a", per_page: 100, page: 1 },
            { owner: "o", repo: "r", state: "open", base: "branch-a", per_page: 100, page: 2 },
        ]);
    });

    test("listPullCommits returns the first line of each commit message from the PR commits endpoint", async () => {
        octokitAnswers.set("pulls.listCommits", () => ({
            data: [
                { sha: "1", commit: { message: "feat: one\n\nlong body" } },
                { sha: "2", commit: { message: "\n" } },
            ],
        }));

        const commits = await createOctokitMergeClient().listPullCommits("o", "r", pullRef);

        expect(commits).toEqual([
            { sha: "1", subject: "feat: one" },
            { sha: "2", subject: "(no subject)" },
        ]);
        expect(octokitCalls).toHaveLength(1);
        expect(octokitCalls[0].params).toEqual({ owner: "o", repo: "r", pull_number: 5, per_page: 100, page: 1 });
    });

    test("listPullCommits walks the compare endpoint when the PR commit list is short of the PR's own count", async () => {
        const logs: string[] = [];
        octokitAnswers.set("pulls.listCommits", () => ({ data: [{ sha: "1", commit: { message: "one" } }] }));
        octokitAnswers.set("repos.compare", () => ({
            data: {
                commits: [
                    { sha: "1", commit: { message: "one" } },
                    { sha: "2", commit: { message: "two" } },
                ],
            },
        }));

        const commits = await createOctokitMergeClient().listPullCommits("o", "r", pullRef, (m) => logs.push(m));

        expect(commits.map((c) => c.subject)).toEqual(["one", "two"]);
        expect(octokitCalls.find((c) => c.op === "repos.compare")?.params).toMatchObject({
            basehead: "base-sha...head-sha",
        });
        expect(logs.some((l) => l.includes("walking the compare endpoint"))).toBe(true);
    });

    test("mergePull sends the method, message and expected head, and maps the answer", async () => {
        octokitAnswers.set("pulls.merge", () => ({ data: { sha: "m1", merged: true, message: "Merged" } }));
        const client = createOctokitMergeClient();

        const result = await client.mergePull("o", "r", 5, {
            method: "squash",
            commitTitle: "feat: x (#5)",
            commitMessage: "* one",
            expectedHeadSha: "head-sha",
        });

        expect(result).toEqual({ sha: "m1", merged: true, message: "Merged" });
        expect(octokitCalls[0].params).toEqual({
            owner: "o",
            repo: "r",
            pull_number: 5,
            merge_method: "squash",
            commit_title: "feat: x (#5)",
            commit_message: "* one",
            sha: "head-sha",
        });

        octokitAnswers.set("pulls.merge", () => ({ data: {} }));
        expect(await client.mergePull("o", "r", 5, { method: "merge" })).toEqual({
            sha: "",
            merged: false,
            message: "merged",
        });
    });

    test("fastForwardBase moves the base ref without force when the head is ahead", async () => {
        octokitAnswers.set("repos.compare", () => ({ data: { status: "ahead", ahead_by: 2, behind_by: 0 } }));
        octokitAnswers.set("git.updateRef", () => ({ data: {} }));

        const result = await createOctokitMergeClient().fastForwardBase("o", "r", "main", "1234567890abcdef");

        expect(result).toEqual({
            sha: "1234567890abcdef",
            merged: true,
            message: "Fast-forwarded origin/main to 1234567",
        });
        expect(octokitCalls.find((c) => c.op === "repos.compare")?.params).toMatchObject({
            basehead: "main...1234567890abcdef",
        });
        expect(octokitCalls.find((c) => c.op === "git.updateRef")?.params).toEqual({
            owner: "o",
            repo: "r",
            ref: "heads/main",
            sha: "1234567890abcdef",
            force: false,
        });
    });

    test("fastForwardBase writes nothing when the base already is at the head", async () => {
        octokitAnswers.set("repos.compare", () => ({ data: { status: "identical", ahead_by: 0, behind_by: 0 } }));

        const result = await createOctokitMergeClient().fastForwardBase("o", "r", "main", "1234567890abcdef");

        expect(result.merged).toBe(true);
        expect(result.message).toBe("origin/main already at 1234567 (identical)");
        expect(octokitCalls.map((c) => c.op)).toEqual(["repos.compare"]);
    });

    test.each(["diverged", "behind"])("fastForwardBase refuses a %s base and writes nothing", async (status) => {
        octokitAnswers.set("repos.compare", () => ({ data: { status, ahead_by: 2, behind_by: 1 } }));

        await expect(createOctokitMergeClient().fastForwardBase("o", "r", "main", "1234567890abcdef")).rejects.toThrow(
            `compare status=${status} (ahead_by=2, behind_by=1)`
        );
        expect(octokitCalls.map((c) => c.op)).toEqual(["repos.compare"]);
    });

    test("updatePullBase patches the base and returns the dependent as GitHub now sees it", async () => {
        octokitAnswers.set("pulls.update", () => ({
            data: {
                number: 6,
                title: "PR 6",
                head: { ref: "b6", sha: "s6" },
                base: { ref: "main" },
                html_url: "https://github.com/o/r/pull/6",
                state: "open",
                stack: { number: 3 },
            },
        }));

        const updated = await createOctokitMergeClient().updatePullBase("o", "r", 6, "main");

        expect(updated).toEqual({
            number: 6,
            title: "PR 6",
            headRef: "b6",
            baseRef: "main",
            htmlUrl: "https://github.com/o/r/pull/6",
            state: "open",
            headSha: "s6",
            stackNumber: 3,
        });
        expect(octokitCalls[0].params).toEqual({ owner: "o", repo: "r", pull_number: 6, base: "main" });
    });

    test("unstack posts to the stack's unstack route, and deleteBranch deletes the head ref", async () => {
        octokitAnswers.set("request", () => ({ data: {} }));
        octokitAnswers.set("git.deleteRef", () => ({ data: {} }));
        const client = createOctokitMergeClient();

        await client.unstack("o", "r", 8);
        await client.deleteBranch("o", "r", "branch-a");

        expect(octokitCalls).toEqual([
            { op: "request", params: { method: "POST", url: "/repos/o/r/stacks/8/unstack" } },
            { op: "git.deleteRef", params: { owner: "o", repo: "r", ref: "heads/branch-a" } },
        ]);
    });

    test("listBaseForcePushTips asks the timeline and returns each replaced tip once, newest first", async () => {
        octokitAnswers.set("graphql", () => ({
            repository: {
                pullRequest: {
                    timelineItems: {
                        nodes: [{ beforeCommit: { oid: "old" } }, { beforeCommit: { oid: "new" } }, null],
                    },
                },
            },
        }));

        const tips = await createOctokitMergeClient().listBaseForcePushTips?.("o", "r", 5);

        expect(tips).toEqual(["new", "old"]);
        expect(octokitCalls[0].params).toMatchObject({ owner: "o", repo: "r", number: 5 });
        expect(String(octokitCalls[0].params.query)).toContain("BASE_REF_FORCE_PUSHED_EVENT");
    });
});

describe("postReviewComment (the review window's GitHub writes)", () => {
    const base = { owner: "acme", repo: "web", number: 7, body: "Rename this." };

    /** Records every call; a call the case does not expect throws, so a wrong path fails loudly. */
    function fakeClient(options: {
        pending?: string;
        allowPublish?: boolean;
        /** The PR the replied-to thread belongs to. */
        threadOn?: { number: number; nameWithOwner: string };
        /** Another send starts this pending review between our query and our start, which then fails. */
        raceWinner?: string;
        /** The REST comment write fails with this message. */
        commentError?: string;
    }) {
        const calls: string[] = [];
        let pending = options.pending;
        const client: ReviewCommentClient = {
            async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
                const op =
                    /(viewer|node|addPullRequestReviewThreadReply|addPullRequestReviewThread|addPullRequestReview)\b/.exec(
                        query
                    )?.[1] ?? "?";
                calls.push(`${op}${variables.reviewId ? `@${variables.reviewId}` : ""}`);

                if (op === "addPullRequestReview" && options.raceWinner) {
                    pending = options.raceWinner;
                    throw new Error("User can only have one pending review per pull request");
                }

                const answers: Record<string, unknown> = {
                    viewer: {
                        viewer: { login: "work" },
                        repository: {
                            pullRequest: {
                                id: "PR_1",
                                headRefOid: "abc123",
                                reviews: {
                                    nodes: pending ? [{ id: pending, author: { login: "work" } }] : [],
                                },
                            },
                        },
                    },
                    node: {
                        node: {
                            pullRequest: {
                                number: options.threadOn?.number ?? 7,
                                repository: { nameWithOwner: options.threadOn?.nameWithOwner ?? "acme/web" },
                            },
                        },
                    },
                    addPullRequestReview: { addPullRequestReview: { pullRequestReview: { id: "REV_new" } } },
                    addPullRequestReviewThread: {
                        addPullRequestReviewThread: {
                            thread: { id: "T_1", comments: { nodes: [{ id: "C_1", url: "u" }] } },
                        },
                    },
                    addPullRequestReviewThreadReply: {
                        addPullRequestReviewThreadReply: { comment: { id: "C_2", url: "u2" } },
                    },
                };
                return answers[op] as T;
            },
            async createReviewComment(input) {
                if (!options.allowPublish) {
                    throw new Error("published a comment the case did not ask to publish");
                }
                calls.push(`createReviewComment ${input.path}:${input.line}@${input.commit_id}`);

                if (options.commentError) {
                    throw new Error(options.commentError);
                }

                return { id: 99, html_url: "https://example.com/c/99" };
            },
        };
        return { client, calls };
    }

    test("a draft on a line starts the pending review when there is none, and never publishes", async () => {
        const { client, calls } = fakeClient({});
        const result = await postReviewComment({ ...base, path: "src/a.ts", line: 12, publish: false }, client);
        expect(calls).toEqual(["viewer", "addPullRequestReview", "addPullRequestReviewThread@REV_new"]);
        expect(result).toMatchObject({ kind: "comment", publish: false, reviewId: "REV_new", commentId: "C_1" });
    });

    test("a draft goes into the viewer's existing pending review", async () => {
        const { client, calls } = fakeClient({ pending: "REV_mine" });
        await postReviewComment({ ...base, path: "src/a.ts", line: 12, publish: false }, client);
        expect(calls).toEqual(["viewer", "addPullRequestReviewThread@REV_mine"]);
    });

    test("publishing a new comment posts on the head commit; a reply draft joins the pending review", async () => {
        const published = fakeClient({ allowPublish: true });
        await postReviewComment({ ...base, path: "src/a.ts", line: 3, publish: true }, published.client);
        expect(published.calls).toEqual(["viewer", "createReviewComment src/a.ts:3@abc123"]);

        const reply = fakeClient({ pending: "REV_mine" });
        const result = await postReviewComment({ ...base, threadId: "PRRT_1", publish: false }, reply.client);
        expect(reply.calls).toEqual(["node", "viewer", "addPullRequestReviewThreadReply@REV_mine"]);
        expect(result.kind).toBe("reply");
    });

    test("a reply to a thread of another pull request is refused before any write", async () => {
        for (const threadOn of [
            { number: 8, nameWithOwner: "acme/web" },
            { number: 7, nameWithOwner: "acme/api" },
        ]) {
            for (const publish of [true, false]) {
                const { client, calls } = fakeClient({ pending: "REV_mine", threadOn });
                await expect(postReviewComment({ ...base, threadId: "PRRT_other", publish }, client)).rejects.toThrow(
                    `belongs to ${threadOn.nameWithOwner}#${threadOn.number}`
                );
                expect(calls).toEqual(["node"]);
            }
        }

        // The owner's case does not matter: GitHub names are case-insensitive.
        const { client } = fakeClient({ threadOn: { number: 7, nameWithOwner: "Acme/Web" } });
        expect((await postReviewComment({ ...base, threadId: "PRRT_1", publish: true }, client)).kind).toBe("reply");
    });

    test("GitHub's 422 for a pending review comes back saying what to do; other errors pass as they are", async () => {
        const conflict = fakeClient({
            pending: "REV_mine",
            allowPublish: true,
            commentError: "Validation Failed: user_id can only have one pending review per pull request",
        });
        await expect(
            postReviewComment({ ...base, path: "src/a.ts", line: 3, publish: true }, conflict.client)
        ).rejects.toThrow("submit or discard it on GitHub first, or add this comment to it as a draft");

        const other = fakeClient({ allowPublish: true, commentError: "Bad credentials" });
        await expect(
            postReviewComment({ ...base, path: "src/a.ts", line: 3, publish: true }, other.client)
        ).rejects.toThrow(/^Bad credentials$/);
    });

    test("a line that is not a positive whole number is refused before any call", async () => {
        const { client, calls } = fakeClient({ allowPublish: true });

        for (const [line, startLine] of [
            [Number.NaN, undefined],
            [3.5, undefined],
            [12, Number.NaN],
            [12, 0],
        ]) {
            await expect(
                postReviewComment({ ...base, path: "src/a.ts", line, startLine, publish: false }, client)
            ).rejects.toThrow("positive whole number");
        }

        expect(calls).toEqual([]);
    });

    test("a draft that loses the race to start the pending review joins the winner's", async () => {
        const { client, calls } = fakeClient({ raceWinner: "REV_theirs" });
        const result = await postReviewComment({ ...base, path: "src/a.ts", line: 12, publish: false }, client);

        expect(calls).toEqual(["viewer", "addPullRequestReview", "viewer", "addPullRequestReviewThread@REV_theirs"]);
        expect(result.reviewId).toBe("REV_theirs");
    });

    test("an empty comment or a new comment without a line is refused before any call", async () => {
        const { client, calls } = fakeClient({});
        await expect(
            postReviewComment({ ...base, body: "  ", path: "a", line: 1, publish: false }, client)
        ).rejects.toThrow("empty");
        await expect(postReviewComment({ ...base, path: "a", publish: false }, client)).rejects.toThrow("--line");
        expect(calls).toEqual([]);
    });
});
