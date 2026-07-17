import { describe, expect, test } from "bun:test";
import {
    type DependentPull,
    type MergeGitHubClient,
    type MergePullOptions,
    type MergePullResult,
    type PullRef,
    resolveMergeMethod,
    safeMergePull,
} from "./merge";
import type { RestackBranchInput, RestackBranchResult, StackRestackOps } from "./stack-restack";

type CallLog = Array<{ op: string; args: unknown[] }>;

function makeMock(opts: {
    pr: PullRef;
    dependents?: DependentPull[];
    /** Dependents returned after merge (defaults to pre-merge list). */
    postMergeDependents?: DependentPull[];
    mergeResult?: MergePullResult;
    /** Fail updatePullBase for these PR numbers. */
    failRetarget?: number[];
    /** Fail deleteBranch. */
    failDelete?: boolean;
    /** Fail fastForwardBase. */
    failFf?: boolean | string;
    /** Mutate dependent state after base update. */
    afterRetarget?: (dep: DependentPull, newBase: string) => DependentPull;
}): { client: MergeGitHubClient; calls: CallLog } {
    const calls: CallLog = [];
    const dependents = opts.dependents ?? [];
    const postMerge = opts.postMergeDependents ?? dependents;
    let merged = opts.pr.merged;

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
                    htmlUrl: dep.htmlUrl,
                };
            }
            return { ...opts.pr, number, merged };
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
        async deleteBranch(_owner, _repo, branch) {
            calls.push({ op: "deleteBranch", args: [branch] });

            if (opts.failDelete) {
                throw new Error(`ref heads/${branch} not found`);
            }
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
        headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        baseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
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
        const { client, calls } = makeMock({
            pr: basePr(),
            dependents: [
                dep({ number: 2, title: "PR B", headRef: "branch-b", baseRef: "branch-a" }),
                dep({ number: 3, title: "PR C", headRef: "branch-c", baseRef: "branch-a" }),
            ],
            failRetarget: [3],
        });

        await expect(
            safeMergePull({
                owner: "o",
                repo: "r",
                number: 1,
                method: "squash",
                deleteBranch: true,
                client,
            })
        ).rejects.toThrow(/retarget\(s\) failed/);

        expect(calls.map((c) => c.op)).not.toContain("deleteBranch");
        // Merge still happened — failure is post-merge safety.
        expect(calls.map((c) => c.op)).toContain("mergePull");
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

    test("stack-safe rebase: failed dependent restack blocks branch delete and throws", async () => {
        const { client, calls } = makeMock({
            pr: basePr(),
            dependents: [dep({ number: 2, title: "PR B", headRef: "branch-b", baseRef: "branch-a" })],
        });
        const { restack } = makeRestackMock({ failBranches: ["branch-b"] });

        await expect(
            safeMergePull({
                owner: "o",
                repo: "r",
                number: 1,
                method: "rebase",
                deleteBranch: true,
                client,
                restack,
            })
        ).rejects.toThrow(/restack\(s\) failed/);

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

    test("passes squash subject/body through to merge API", async () => {
        const { client, calls } = makeMock({ pr: basePr() });

        await safeMergePull({
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
        });
    });

    test("detects child closed after retarget (simulates the gh bug path)", async () => {
        const { client } = makeMock({
            pr: basePr(),
            dependents: [dep({ number: 2, title: "PR B", headRef: "branch-b", baseRef: "branch-a" })],
            afterRetarget: (d) => ({ ...d, state: "closed" }),
        });

        await expect(
            safeMergePull({
                owner: "o",
                repo: "r",
                number: 1,
                method: "merge",
                deleteBranch: true,
                client,
            })
        ).rejects.toThrow(/no longer open/);
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
});
