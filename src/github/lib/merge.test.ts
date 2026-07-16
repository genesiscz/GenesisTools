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
    test("merge without --delete-branch never deletes and retargets dependents first", async () => {
        const logs: string[] = [];
        const { client, calls } = makeMock({
            pr: basePr(),
            dependents: [dep({ number: 2, title: "PR B", headRef: "branch-b", baseRef: "branch-a" })],
        });

        const result = await safeMergePull({
            owner: "o",
            repo: "r",
            number: 1,
            method: "rebase",
            deleteBranch: false,
            client,
            log: (m) => logs.push(m),
        });

        expect(result.branchDeleted).toBe(false);
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

        // Order: discover → merge → retarget. No delete.
        const ops = calls.map((c) => c.op);
        expect(ops).toContain("mergePull");
        expect(ops).toContain("updatePullBase");
        expect(ops).not.toContain("deleteBranch");

        const mergeIdx = ops.indexOf("mergePull");
        const retargetIdx = ops.indexOf("updatePullBase");
        expect(mergeIdx).toBeLessThan(retargetIdx);

        // Merge API never gets a delete flag — only method/title/message.
        const mergeCall = calls.find((c) => c.op === "mergePull");
        expect(mergeCall?.args[1]).toEqual({ method: "rebase", commitTitle: undefined, commitMessage: undefined });

        expect(logs.some((l) => l.includes('base="branch-a"'))).toBe(true);
        expect(logs.some((l) => l.includes("Keeping remote branch"))).toBe(true);
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

    test("independent PR (no dependents) merges and can delete branch", async () => {
        const { client, calls } = makeMock({
            pr: basePr({ number: 6, title: "Independent", headRef: "branch-f", baseRef: "main" }),
            dependents: [],
        });

        const result = await safeMergePull({
            owner: "o",
            repo: "r",
            number: 6,
            method: "rebase",
            deleteBranch: true,
            client,
        });

        expect(result.dependentsFound).toEqual([]);
        expect(result.retargeted).toEqual([]);
        expect(result.branchDeleted).toBe(true);
        expect(calls.map((c) => c.op)).toContain("deleteBranch");
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

        const result = await safeMergePull({
            owner: "o",
            repo: "r",
            number: 1,
            method: "rebase",
            deleteBranch: true,
            client,
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
