// Safe PR merge with stack-aware base retargeting (+ stack-safe rebase).
//
// GitHub only auto-retargets dependents when the parent branch is deleted via
// the web UI "Delete branch" button. CLI/API deletes close child PRs instead
// (cli/cli#1168). This module never relies on that broken path:
//   1. merge without deleting the head branch
//      - merge / squash → GitHub pulls.merge API
//      - rebase → stack-safe path (local restack + FF) unless --no-restack
//      - ff-only → update base ref to head SHA (force=false) so SHAs stay intact
//   2. find open PRs whose base is the merged head
//   3. retarget each dependent onto the merged PR's base
//   4. for stack-safe rebase: restack dependents with git rebase --onto
//      (gh-stack cascade algorithm) so the next PR is FF-able
//   5. only then optionally delete the remote head branch

import {
    createGitStackRestack,
    createNoopStackRestack,
    type RestackBranchResult,
    type StackRestackOps,
} from "@app/github/lib/stack-restack";
import { getOctokitForWrite } from "@genesiscz/utils/github/octokit";
import { withRetry } from "@genesiscz/utils/github/rate-limit";

/** GitHub API merge methods plus local-ref fast-forward. */
export type MergeMethod = "merge" | "rebase" | "squash" | "ff-only";

export interface PullRef {
    number: number;
    title: string;
    state: string;
    merged: boolean;
    draft: boolean;
    mergeable: boolean | null;
    headRef: string;
    baseRef: string;
    /** Tip SHA of the head branch (required for ff-only). */
    headSha: string;
    /** Tip SHA of the base branch at PR resolution time. */
    baseSha: string;
    htmlUrl: string;
}

export interface DependentPull {
    number: number;
    title: string;
    headRef: string;
    baseRef: string;
    htmlUrl: string;
    state: string;
    /** Tip SHA of the dependent head (when available from list/get). */
    headSha?: string;
}

/** Methods accepted by GitHub's pulls.merge API (not ff-only). */
export type GithubApiMergeMethod = Exclude<MergeMethod, "ff-only">;

export interface MergePullOptions {
    method: GithubApiMergeMethod;
    commitTitle?: string;
    commitMessage?: string;
}

export interface MergePullResult {
    sha: string;
    merged: boolean;
    message: string;
}

/** Injectable GitHub surface — real octokit wrapper or test mock. */
export interface MergeGitHubClient {
    getPull(owner: string, repo: string, number: number): Promise<PullRef>;
    listOpenPullsByBase(owner: string, repo: string, base: string): Promise<DependentPull[]>;
    mergePull(owner: string, repo: string, number: number, options: MergePullOptions): Promise<MergePullResult>;
    /**
     * True fast-forward: move `baseRef` to `headSha` only if base is an ancestor
     * of head (Git ref update with force=false). Does not rewrite commits.
     */
    fastForwardBase(owner: string, repo: string, baseRef: string, headSha: string): Promise<MergePullResult>;
    updatePullBase(owner: string, repo: string, number: number, base: string): Promise<DependentPull>;
    deleteBranch(owner: string, repo: string, branch: string): Promise<void>;
}

export interface SafeMergeOptions {
    owner: string;
    repo: string;
    number: number;
    method: MergeMethod;
    /** After retargeting dependents, delete the merged PR's head branch. */
    deleteBranch?: boolean;
    /**
     * For --rebase: skip local restack + FF; call GitHub merge_method=rebase
     * directly (breaks cascading stacks after parent rewrite). Default false.
     */
    noRestack?: boolean;
    commitTitle?: string;
    commitMessage?: string;
    /** Progress / decision logs (caller routes to stdout). */
    log?: (message: string) => void;
    client?: MergeGitHubClient;
    /** Injectable restack (default: temp-clone git restack). */
    restack?: StackRestackOps;
}

export interface RetargetResult {
    number: number;
    title: string;
    fromBase: string;
    toBase: string;
    ok: boolean;
    state: string;
    error?: string;
}

export interface DependentRestackResult {
    number: number;
    title: string;
    headRef: string;
    ok: boolean;
    rebased: boolean;
    headSha?: string;
    error?: string;
}

export interface SafeMergeResult {
    owner: string;
    repo: string;
    number: number;
    title: string;
    method: MergeMethod;
    headRef: string;
    baseRef: string;
    mergeSha: string;
    /** How the merge was applied when method=rebase (stack-safe path). */
    rebaseMode?: "stack-safe-ff" | "api-rewrite";
    headRestack?: RestackBranchResult;
    dependentsFound: DependentPull[];
    retargeted: RetargetResult[];
    dependentsRestacked: DependentRestackResult[];
    branchDeleted: boolean;
    branchDeleteError?: string;
}

function logLine(log: ((message: string) => void) | undefined, message: string): void {
    if (log) {
        log(message);
    }
}

/**
 * Create the default Octokit-backed client.
 */
export function createOctokitMergeClient(): MergeGitHubClient {
    // Write path: prefer gh OAuth over limited env PATs (merge needs contents:write).
    const octokit = getOctokitForWrite();

    return {
        async getPull(owner, repo, number) {
            const { data } = await withRetry(
                () =>
                    octokit.rest.pulls.get({
                        owner,
                        repo,
                        pull_number: number,
                    }),
                { label: `GET /repos/${owner}/${repo}/pulls/${number}` }
            );

            return {
                number: data.number,
                title: data.title,
                state: data.state,
                merged: Boolean(data.merged),
                draft: Boolean(data.draft),
                mergeable: data.mergeable ?? null,
                headRef: data.head.ref,
                baseRef: data.base.ref,
                headSha: data.head.sha,
                baseSha: data.base.sha,
                htmlUrl: data.html_url,
            };
        },

        async listOpenPullsByBase(owner, repo, base) {
            const results: DependentPull[] = [];
            let page = 1;
            const perPage = 100;

            while (true) {
                const { data } = await withRetry(
                    () =>
                        octokit.rest.pulls.list({
                            owner,
                            repo,
                            state: "open",
                            base,
                            per_page: perPage,
                            page,
                        }),
                    { label: `GET /repos/${owner}/${repo}/pulls?state=open&base=${base} (page ${page})` }
                );

                for (const pr of data) {
                    results.push({
                        number: pr.number,
                        title: pr.title,
                        headRef: pr.head.ref,
                        baseRef: pr.base.ref,
                        htmlUrl: pr.html_url,
                        state: pr.state,
                        headSha: pr.head.sha,
                    });
                }

                if (data.length < perPage) {
                    break;
                }

                page++;
            }

            return results;
        },

        async mergePull(owner, repo, number, options) {
            const { data } = await withRetry(
                () =>
                    octokit.rest.pulls.merge({
                        owner,
                        repo,
                        pull_number: number,
                        merge_method: options.method,
                        commit_title: options.commitTitle,
                        commit_message: options.commitMessage,
                    }),
                { label: `PUT /repos/${owner}/${repo}/pulls/${number}/merge (${options.method})` }
            );

            return {
                sha: data.sha ?? "",
                merged: Boolean(data.merged),
                message: data.message ?? "merged",
            };
        },

        async fastForwardBase(owner, repo, baseRef, headSha) {
            // Preflight: base must be an ancestor of head (or already identical).
            const { data: cmp } = await withRetry(
                () =>
                    octokit.rest.repos.compareCommitsWithBasehead({
                        owner,
                        repo,
                        basehead: `${baseRef}...${headSha}`,
                    }),
                { label: `GET /repos/${owner}/${repo}/compare/${baseRef}...${headSha.slice(0, 7)}` }
            );

            // ahead  = head is strictly ahead of base → FF ok
            // identical = already same tip → no-op ok
            // behind / diverged = cannot FF
            if (cmp.status === "diverged" || cmp.status === "behind") {
                throw new Error(
                    `Cannot fast-forward origin/${baseRef} to ${headSha.slice(0, 7)}: ` +
                        `compare status=${cmp.status} (ahead_by=${cmp.ahead_by}, behind_by=${cmp.behind_by}). ` +
                        `Rebase the PR onto ${baseRef} first, or use --rebase / --merge.`
                );
            }

            if (cmp.status === "identical") {
                return {
                    sha: headSha,
                    merged: true,
                    message: `origin/${baseRef} already at ${headSha.slice(0, 7)} (identical)`,
                };
            }

            // force: false → GitHub rejects non-FF updates (extra safety net).
            await withRetry(
                () =>
                    octokit.rest.git.updateRef({
                        owner,
                        repo,
                        ref: `heads/${baseRef}`,
                        sha: headSha,
                        force: false,
                    }),
                { label: `PATCH /repos/${owner}/${repo}/git/refs/heads/${baseRef} → ${headSha.slice(0, 7)} (ff)` }
            );

            return {
                sha: headSha,
                merged: true,
                message: `Fast-forwarded origin/${baseRef} to ${headSha.slice(0, 7)}`,
            };
        },

        async updatePullBase(owner, repo, number, base) {
            const { data } = await withRetry(
                () =>
                    octokit.rest.pulls.update({
                        owner,
                        repo,
                        pull_number: number,
                        base,
                    }),
                { label: `PATCH /repos/${owner}/${repo}/pulls/${number} base=${base}` }
            );

            return {
                number: data.number,
                title: data.title,
                headRef: data.head.ref,
                baseRef: data.base.ref,
                htmlUrl: data.html_url,
                state: data.state,
                headSha: data.head.sha,
            };
        },

        async deleteBranch(owner, repo, branch) {
            await withRetry(
                () =>
                    octokit.rest.git.deleteRef({
                        owner,
                        repo,
                        ref: `heads/${branch}`,
                    }),
                { label: `DELETE /repos/${owner}/${repo}/git/refs/heads/${branch}` }
            );
        },
    };
}

/**
 * Merge a PR, retarget every open PR that based on its head, then optionally
 * delete the head branch. Never deletes before retargeting.
 *
 * For method=rebase (default stack-safe):
 *   restack head onto base if needed → force-with-lease → FF base →
 *   retarget dependents → restack each dependent with rebase --onto.
 */
export async function safeMergePull(options: SafeMergeOptions): Promise<SafeMergeResult> {
    const {
        owner,
        repo,
        number,
        method,
        deleteBranch = false,
        noRestack = false,
        commitTitle,
        commitMessage,
        log,
    } = options;
    const client = options.client ?? createOctokitMergeClient();
    const stackSafeRebase = method === "rebase" && !noRestack;
    // Prefer injected restack; otherwise real git restack only for stack-safe rebase.
    // When tests pass a mock client without restack, use no-op so unit tests stay offline.
    const restack: StackRestackOps =
        options.restack ??
        (stackSafeRebase && !options.client ? createGitStackRestack({ log }) : createNoopStackRestack());

    logLine(log, `Resolving ${owner}/${repo}#${number}...`);
    const pr = await client.getPull(owner, repo, number);

    logLine(log, `PR #${pr.number}: ${pr.title}`);
    logLine(log, `  head=${pr.headRef}  base=${pr.baseRef}  state=${pr.state}  merged=${pr.merged}`);

    if (pr.merged) {
        throw new Error(`PR #${number} is already merged`);
    }

    if (pr.state !== "open") {
        throw new Error(`PR #${number} is not open (state=${pr.state})`);
    }

    if (pr.draft) {
        throw new Error(`PR #${number} is a draft — mark ready before merging`);
    }

    // Discover dependents BEFORE merge so we log intent and fail fast if listing fails.
    logLine(log, `Looking for open PRs with base="${pr.headRef}"...`);
    const dependents = await client.listOpenPullsByBase(owner, repo, pr.headRef);

    if (dependents.length === 0) {
        logLine(log, "  no dependent PRs");
    } else {
        for (const dep of dependents) {
            logLine(log, `  dependent #${dep.number} "${dep.title}" (${dep.headRef} → ${dep.baseRef})`);
        }
    }

    // Tip of the PR head before any rewrite — used as --onto oldBase for children.
    const preMergeHeadSha = pr.headSha;
    let effectiveHeadSha = pr.headSha;
    let headRestack: RestackBranchResult | undefined;
    let rebaseMode: SafeMergeResult["rebaseMode"];
    let mergeResult: MergePullResult;

    if (method === "ff-only") {
        if (commitTitle || commitMessage) {
            logLine(log, "  note: --subject/--body ignored for --ff-only (no merge commit)");
        }
        if (!pr.headSha) {
            throw new Error(`PR #${number} has no head SHA — cannot fast-forward`);
        }
        logLine(
            log,
            `Fast-forwarding origin/${pr.baseRef} → ${pr.headSha.slice(0, 7)} ` +
                `(head=${pr.headRef}; branch will NOT be deleted by the FF)...`
        );
        mergeResult = await client.fastForwardBase(owner, repo, pr.baseRef, pr.headSha);
    } else if (stackSafeRebase) {
        rebaseMode = "stack-safe-ff";
        if (commitTitle || commitMessage) {
            logLine(log, "  note: --subject/--body ignored for stack-safe --rebase (FF merge, no rewrite commit)");
        }
        if (!pr.headSha) {
            throw new Error(`PR #${number} has no head SHA — cannot stack-safe rebase`);
        }

        logLine(
            log,
            `Stack-safe rebase for #${number}: restack ${pr.headRef} onto ${pr.baseRef} if needed, then FF...`
        );
        headRestack = await restack.restackBranch({
            owner,
            repo,
            branch: pr.headRef,
            expectedHeadSha: pr.headSha,
            newBase: pr.baseRef,
        });
        effectiveHeadSha = headRestack.headSha;

        if (headRestack.rebased) {
            logLine(log, `  head restacked: ${pr.headSha.slice(0, 7)} → ${effectiveHeadSha.slice(0, 7)}`);
        } else {
            logLine(log, `  head already linear on ${pr.baseRef}`);
        }

        logLine(
            log,
            `Fast-forwarding origin/${pr.baseRef} → ${effectiveHeadSha.slice(0, 7)} ` +
                `(preserves SHAs; dependents stay stackable)...`
        );
        mergeResult = await client.fastForwardBase(owner, repo, pr.baseRef, effectiveHeadSha);
    } else {
        if (method === "rebase") {
            rebaseMode = "api-rewrite";
            logLine(
                log,
                `Merging #${number} via GitHub rebase API (--no-restack; rewrites SHAs, may break stack children)...`
            );
        } else {
            logLine(log, `Merging #${number} via ${method} (branch will NOT be deleted by the merge call)...`);
        }
        mergeResult = await client.mergePull(owner, repo, number, {
            method: method as GithubApiMergeMethod,
            commitTitle,
            commitMessage,
        });
    }

    if (!mergeResult.merged) {
        throw new Error(`Merge returned merged=false: ${mergeResult.message}`);
    }

    logLine(log, `  merged sha=${mergeResult.sha || "(none)"} — ${mergeResult.message}`);

    // Re-list after merge in case anything opened mid-flight; prefer pre-merge set.
    const postDependents = await client.listOpenPullsByBase(owner, repo, pr.headRef);
    const byNumber = new Map<number, DependentPull>();

    for (const dep of dependents) {
        byNumber.set(dep.number, dep);
    }

    for (const dep of postDependents) {
        byNumber.set(dep.number, dep);
    }

    const toRetarget = [...byNumber.values()].sort((a, b) => a.number - b.number);
    const retargeted: RetargetResult[] = [];

    if (toRetarget.length === 0) {
        logLine(log, "No dependents to retarget");
    } else {
        logLine(log, `Retargeting ${toRetarget.length} dependent PR(s) onto base="${pr.baseRef}"...`);
    }

    for (const dep of toRetarget) {
        try {
            logLine(log, `  #${dep.number}: base ${dep.baseRef} → ${pr.baseRef}`);
            const updated = await client.updatePullBase(owner, repo, dep.number, pr.baseRef);

            if (updated.state !== "open") {
                retargeted.push({
                    number: dep.number,
                    title: dep.title,
                    fromBase: dep.baseRef,
                    toBase: pr.baseRef,
                    ok: false,
                    state: updated.state,
                    error: `PR is no longer open after retarget (state=${updated.state})`,
                });
                logLine(log, `    ✘ still not open (state=${updated.state})`);
                continue;
            }

            if (updated.baseRef !== pr.baseRef) {
                retargeted.push({
                    number: dep.number,
                    title: dep.title,
                    fromBase: dep.baseRef,
                    toBase: pr.baseRef,
                    ok: false,
                    state: updated.state,
                    error: `base is ${updated.baseRef}, expected ${pr.baseRef}`,
                });
                logLine(log, `    ✘ base is ${updated.baseRef}, expected ${pr.baseRef}`);
                continue;
            }

            retargeted.push({
                number: dep.number,
                title: dep.title,
                fromBase: dep.baseRef,
                toBase: updated.baseRef,
                ok: true,
                state: updated.state,
            });
            logLine(log, `    ✔ open, base=${updated.baseRef}`);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            retargeted.push({
                number: dep.number,
                title: dep.title,
                fromBase: dep.baseRef,
                toBase: pr.baseRef,
                ok: false,
                state: dep.state,
                error: message,
            });
            logLine(log, `    ✘ ${message}`);
        }
    }

    // Stack-safe rebase: restack each successfully retargeted child onto the
    // new base, dropping commits through the pre-merge parent tip (gh-stack --onto).
    const dependentsRestacked: DependentRestackResult[] = [];
    const parentWasRewritten = Boolean(headRestack?.rebased);

    if (stackSafeRebase && toRetarget.length > 0) {
        const okRetargets = retargeted.filter((r) => r.ok);
        if (okRetargets.length > 0) {
            logLine(
                log,
                `Restacking ${okRetargets.length} dependent(s) onto ${pr.baseRef}` +
                    (parentWasRewritten
                        ? ` (--onto drop ≤ ${preMergeHeadSha.slice(0, 7)})...`
                        : " (only if not already linear)...")
            );
        }

        for (const r of okRetargets) {
            const dep = toRetarget.find((d) => d.number === r.number);
            if (!dep) {
                continue;
            }

            const expectedSha = dep.headSha;
            if (!expectedSha) {
                // Refresh tip from getPull when list didn't include sha.
                try {
                    const fresh = await client.getPull(owner, repo, dep.number);
                    dep.headSha = fresh.headSha;
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    dependentsRestacked.push({
                        number: dep.number,
                        title: dep.title,
                        headRef: dep.headRef,
                        ok: false,
                        rebased: false,
                        error: `could not resolve head SHA: ${message}`,
                    });
                    logLine(log, `  #${dep.number} restack ✘ no head SHA`);
                    continue;
                }
            }

            const headSha = dep.headSha!;
            try {
                // Always pass preMergeHeadSha as oldBase when parent rewrote, so
                // unique child commits replay onto trunk. When parent was pure FF,
                // oldBase is still correct (already on base) and restack short-circuits.
                const result = await restack.restackBranch({
                    owner,
                    repo,
                    branch: dep.headRef,
                    expectedHeadSha: headSha,
                    newBase: pr.baseRef,
                    oldBaseSha: preMergeHeadSha,
                });
                dependentsRestacked.push({
                    number: dep.number,
                    title: dep.title,
                    headRef: dep.headRef,
                    ok: true,
                    rebased: result.rebased,
                    headSha: result.headSha,
                });
                logLine(
                    log,
                    result.rebased
                        ? `  #${dep.number} restack ✔ ${headSha.slice(0, 7)} → ${result.headSha.slice(0, 7)}`
                        : `  #${dep.number} restack ✔ already linear`
                );
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                dependentsRestacked.push({
                    number: dep.number,
                    title: dep.title,
                    headRef: dep.headRef,
                    ok: false,
                    rebased: false,
                    error: message,
                });
                logLine(log, `  #${dep.number} restack ✘ ${message.split("\n")[0]}`);
            }
        }
    }

    const failedRetargets = retargeted.filter((r) => !r.ok);
    const failedRestacks = dependentsRestacked.filter((r) => !r.ok);
    let branchDeleted = false;
    let branchDeleteError: string | undefined;

    if (deleteBranch) {
        if (failedRetargets.length > 0 || failedRestacks.length > 0) {
            const parts: string[] = [];
            if (failedRetargets.length > 0) {
                parts.push(`${failedRetargets.length} retarget(s) failed`);
            }
            if (failedRestacks.length > 0) {
                parts.push(`${failedRestacks.length} restack(s) failed`);
            }
            branchDeleteError = `skipped branch delete: ${parts.join(", ")}`;
            logLine(log, `NOT deleting branch "${pr.headRef}" — ${branchDeleteError}`);
        } else {
            logLine(log, `Deleting remote branch "${pr.headRef}"...`);

            try {
                await client.deleteBranch(owner, repo, pr.headRef);
                branchDeleted = true;
                logLine(log, `  ✔ deleted origin/${pr.headRef}`);
            } catch (err) {
                branchDeleteError = err instanceof Error ? err.message : String(err);
                logLine(log, `  ✘ delete failed: ${branchDeleteError}`);
            }
        }
    } else {
        logLine(log, `Keeping remote branch "${pr.headRef}" (pass --delete-branch to remove after retarget)`);
    }

    if (failedRetargets.length > 0 || failedRestacks.length > 0) {
        const bits: string[] = [];
        if (failedRetargets.length > 0) {
            bits.push(
                `${failedRetargets.length} dependent retarget(s) failed: ` +
                    failedRetargets.map((r) => `#${r.number}${r.error ? ` (${r.error})` : ""}`).join(", ")
            );
        }
        if (failedRestacks.length > 0) {
            bits.push(
                `${failedRestacks.length} dependent restack(s) failed: ` +
                    failedRestacks.map((r) => `#${r.number}${r.error ? ` (${r.error.split("\n")[0]})` : ""}`).join(", ")
            );
        }
        throw new Error(`Merged #${number} but ${bits.join("; ")}`);
    }

    return {
        owner,
        repo,
        number: pr.number,
        title: pr.title,
        method,
        headRef: pr.headRef,
        baseRef: pr.baseRef,
        mergeSha: mergeResult.sha || effectiveHeadSha,
        rebaseMode,
        headRestack,
        dependentsFound: toRetarget,
        retargeted,
        dependentsRestacked,
        branchDeleted,
        branchDeleteError,
    };
}

/**
 * Resolve exactly one merge method from CLI flags.
 */
export function resolveMergeMethod(flags: {
    merge?: boolean;
    rebase?: boolean;
    squash?: boolean;
    ffOnly?: boolean;
    /** Alias for ffOnly (--ff). */
    ff?: boolean;
}): MergeMethod {
    const selected: MergeMethod[] = [];

    if (flags.merge) {
        selected.push("merge");
    }

    if (flags.rebase) {
        selected.push("rebase");
    }

    if (flags.squash) {
        selected.push("squash");
    }

    if (flags.ffOnly || flags.ff) {
        selected.push("ff-only");
    }

    if (selected.length === 0) {
        throw new Error("Specify exactly one of --merge, --rebase, --squash, or --ff-only");
    }

    if (selected.length > 1) {
        throw new Error(
            `Conflicting merge methods: ${selected.map((m) => (m === "ff-only" ? "--ff-only" : `--${m}`)).join(", ")}`
        );
    }

    return selected[0];
}
