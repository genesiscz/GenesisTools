// Safe PR merge with stack-aware base retargeting.
//
// GitHub only auto-retargets dependents when the parent branch is deleted via
// the web UI "Delete branch" button. CLI/API deletes close child PRs instead
// (cli/cli#1168). This module never relies on that broken path:
//   1. merge without deleting the head branch
//   2. find open PRs whose base is the merged head
//   3. retarget each dependent onto the merged PR's base
//   4. only then optionally delete the remote head branch

import { getOctokitForWrite } from "@app/utils/github/octokit";
import { withRetry } from "@app/utils/github/rate-limit";

export type MergeMethod = "merge" | "rebase" | "squash";

export interface PullRef {
    number: number;
    title: string;
    state: string;
    merged: boolean;
    draft: boolean;
    mergeable: boolean | null;
    headRef: string;
    baseRef: string;
    htmlUrl: string;
}

export interface DependentPull {
    number: number;
    title: string;
    headRef: string;
    baseRef: string;
    htmlUrl: string;
    state: string;
}

export interface MergePullOptions {
    method: MergeMethod;
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
    commitTitle?: string;
    commitMessage?: string;
    /** Progress / decision logs (caller routes to stdout). */
    log?: (message: string) => void;
    client?: MergeGitHubClient;
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

export interface SafeMergeResult {
    owner: string;
    repo: string;
    number: number;
    title: string;
    method: MergeMethod;
    headRef: string;
    baseRef: string;
    mergeSha: string;
    dependentsFound: DependentPull[];
    retargeted: RetargetResult[];
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
 */
export async function safeMergePull(options: SafeMergeOptions): Promise<SafeMergeResult> {
    const { owner, repo, number, method, deleteBranch = false, commitTitle, commitMessage, log } = options;
    const client = options.client ?? createOctokitMergeClient();

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

    logLine(log, `Merging #${number} via ${method} (branch will NOT be deleted by the merge call)...`);
    const mergeResult = await client.mergePull(owner, repo, number, {
        method,
        commitTitle,
        commitMessage,
    });

    if (!mergeResult.merged) {
        throw new Error(`Merge API returned merged=false: ${mergeResult.message}`);
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

    const failedRetargets = retargeted.filter((r) => !r.ok);
    let branchDeleted = false;
    let branchDeleteError: string | undefined;

    if (deleteBranch) {
        if (failedRetargets.length > 0) {
            branchDeleteError = `skipped branch delete: ${failedRetargets.length} dependent retarget(s) failed`;
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

    if (failedRetargets.length > 0) {
        throw new Error(
            `Merged #${number} but ${failedRetargets.length} dependent retarget(s) failed: ` +
                failedRetargets.map((r) => `#${r.number}${r.error ? ` (${r.error})` : ""}`).join(", ")
        );
    }

    return {
        owner,
        repo,
        number: pr.number,
        title: pr.title,
        method,
        headRef: pr.headRef,
        baseRef: pr.baseRef,
        mergeSha: mergeResult.sha,
        dependentsFound: toRetarget,
        retargeted,
        branchDeleted,
        branchDeleteError,
    };
}

/**
 * Resolve exactly one merge method from CLI flags.
 */
export function resolveMergeMethod(flags: { merge?: boolean; rebase?: boolean; squash?: boolean }): MergeMethod {
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

    if (selected.length === 0) {
        throw new Error("Specify exactly one of --merge, --rebase, or --squash");
    }

    if (selected.length > 1) {
        throw new Error(`Conflicting merge methods: ${selected.map((m) => `--${m}`).join(", ")}`);
    }

    return selected[0];
}
