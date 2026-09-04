import type { BranchPolicy } from "@genesiscz/utils/git";
import { createGit } from "@genesiscz/utils/git";
import { logger } from "@genesiscz/utils/logger";
import { type CollectContext, collectRefReport, isMainWorktree, type RefReport } from "./collect";

const WORKTREE_REMOVE_TIMEOUT_MS = 120_000;

export interface PrunePlan {
    ref: string;
    report: RefReport;
    branch: string | null;
    /** Full sha of the branch tip before deletion, for the restore command. */
    tipSha: string | null;
    worktreePath: string | null;
    /** `origin/<branch>` deletion, only with `--remote` and only when the upstream is exactly that. */
    remoteBranch: string | null;
    /** The ref names origin/<branch> and has no local branch: the remote IS the deletion. */
    remoteOnly: boolean;
    /** Sha of `origin/<remoteBranch>` before deletion. Not the local tip: an unpushed branch differs. */
    remoteSha: string | null;
    warnings: string[];
}

const REMOTE_PREFIX = "origin/";

/** `origin/<name>` with no local branch behind it, else null. */
function remoteOnlyName(report: RefReport): string | null {
    if (report.branch !== null || report.kind !== "ref" || !report.ref.startsWith(REMOTE_PREFIX)) {
        return null;
    }

    const name = report.ref.slice(REMOTE_PREFIX.length);
    return name.length > 0 ? name : null;
}

export interface PruneRefusal {
    ref: string;
    reason: string;
}

export interface PruneContext extends CollectContext {
    remote: boolean;
    /** Branch checked out in the invoking checkout; a plan never deletes it. */
    currentBranch: string | null;
    policyFor: (branch: string) => BranchPolicy;
}

/**
 * Re-verify every named ref (never trust an earlier list) and decide what
 * may go. Refusals are per ref and final; a remote deletion that must not
 * happen drops only the remote step and says why.
 */
export async function planPrune(
    ctx: PruneContext,
    refs: string[]
): Promise<{ plans: PrunePlan[]; refusals: PruneRefusal[] }> {
    const git = createGit({ cwd: ctx.repoRoot });
    const plans: PrunePlan[] = [];
    const refusals: PruneRefusal[] = [];
    const baseBranch = ctx.base.ref.replace(/^origin\//, "");

    for (const ref of refs) {
        let report: RefReport;

        try {
            report = await collectRefReport(ctx, ref);
        } catch (err) {
            refusals.push({ ref, reason: err instanceof Error ? err.message : String(err) });
            continue;
        }

        // Structural refusals first: these hold whatever the verdict says.
        const worktree = report.worktree ? ctx.worktrees.find((w) => w.path === report.worktree) : undefined;
        const isMain = worktree !== undefined && isMainWorktree(worktree, ctx.repoRoot);

        // A path argument naming the main checkout gets this message before the branch-based
        // ones below, which would otherwise call it "the base branch" or "checked out here".
        if (report.kind === "path" && isMain) {
            refusals.push({ ref, reason: "is the main checkout" });
            continue;
        }

        const remoteOnly = remoteOnlyName(report);

        if (report.branch && (report.branch === ctx.base.ref || report.branch === baseBranch)) {
            refusals.push({ ref, reason: "is the base branch" });
            continue;
        }

        if (remoteOnly !== null && (remoteOnly === baseBranch || report.ref === ctx.base.ref)) {
            refusals.push({ ref, reason: "is the base branch" });
            continue;
        }

        if (report.branch && report.branch === ctx.currentBranch) {
            refusals.push({ ref, reason: "checked out in the current checkout" });
            continue;
        }

        if (isMain) {
            refusals.push({ ref, reason: "is the main checkout" });
            continue;
        }

        if (report.verdict === "UNMERGED") {
            refusals.push({
                ref,
                reason: `UNMERGED: ${report.unmerged.length} file(s) never landed on ${report.base.ref}`,
            });
            continue;
        }

        if (report.dirty > 0) {
            refusals.push({
                ref,
                reason: `worktree has ${report.dirty} uncommitted entr${report.dirty === 1 ? "y" : "ies"}`,
            });
            continue;
        }

        if (!report.branch && !worktree && remoteOnly === null) {
            refusals.push({ ref, reason: "not a branch and not a worktree, nothing to remove" });
            continue;
        }

        const warnings: string[] = [];

        if (report.unpushed && report.unpushed > 0) {
            warnings.push(
                `${report.upstream} holds an older copy (${report.unpushed} unpushed commit(s)); the content is on ${report.base.ref}`
            );
        }

        if (report.upstreamGone) {
            warnings.push(`upstream ${report.upstream} is gone`);
        }

        let remoteBranch: string | null = null;

        if (remoteOnly !== null) {
            // Nothing local to fall back on: every gate that only DROPS the remote step for a
            // local branch has to refuse the whole ref here, or the run would report success
            // having done nothing.
            if (!ctx.remote) {
                refusals.push({
                    ref,
                    reason: `names a remote branch and there is no local one; pass --remote to delete origin/${remoteOnly}`,
                });
                continue;
            }

            const policy = ctx.policyFor(remoteOnly);
            const lookup = ctx.driver ? await ctx.driver.prForHead(remoteOnly) : null;

            if (lookup?.error) {
                refusals.push({
                    ref,
                    reason: `PR lookup failed (${lookup.error}); an open PR would close with its head, so this is not safe to delete unattended`,
                });
                continue;
            }

            if (lookup?.pr?.state === "OPEN") {
                refusals.push({ ref, reason: `OPEN PR #${lookup.pr.number} still targets ${lookup.pr.target}` });
                continue;
            }

            if (policy.push === "never") {
                refusals.push({ ref, reason: `push policy is never for ${remoteOnly} (${policy.matchedBy})` });
                continue;
            }

            plans.push({
                ref,
                report,
                branch: null,
                tipSha: await git.getSha(report.ref),
                worktreePath: null,
                remoteBranch: remoteOnly,
                remoteOnly: true,
                remoteSha: await git.getSha(report.ref),
                warnings,
            });
            continue;
        }

        if (ctx.remote && report.branch && report.upstream === `origin/${report.branch}`) {
            remoteBranch = report.branch;
            const policy = ctx.policyFor(report.branch);
            const lookup = ctx.driver ? await ctx.driver.prForHead(report.branch) : null;

            if (lookup?.error) {
                warnings.push(
                    `remote kept: PR lookup failed (${lookup.error}); an open PR would close with its head, delete origin/${report.branch} by hand once you know`
                );
                remoteBranch = null;
            } else if (lookup?.pr?.state === "OPEN") {
                warnings.push(`remote kept: OPEN PR #${lookup.pr.number} still targets ${lookup.pr.target}`);
                remoteBranch = null;
            } else if (policy.push === "never") {
                warnings.push(`remote kept: push policy is never for ${report.branch} (${policy.matchedBy})`);
                remoteBranch = null;
            }
        } else if (ctx.remote && report.branch) {
            warnings.push(`remote kept: upstream is ${report.upstream ?? "not set"}, not origin/${report.branch}`);
        }

        const tipSha = report.branch ? await git.getSha(report.branch) : null;
        plans.push({
            ref,
            report,
            branch: report.branch,
            tipSha,
            worktreePath: worktree?.path ?? null,
            remoteBranch,
            remoteOnly: false,
            remoteSha: remoteBranch ? await git.getSha(`origin/${remoteBranch}`) : null,
            warnings,
        });
    }

    return { plans, refusals };
}

export interface PruneOutcome {
    ref: string;
    removedWorktree: string | null;
    deletedBranch: { name: string; sha: string } | null;
    /** The deleted `origin/<name>`, with the sha it pointed at so the restore push is printable. */
    deletedRemote: { name: string; sha: string } | null;
    failures: string[];
}

async function removeWorktree(ctx: PruneContext, path: string): Promise<string | null> {
    const git = createGit({ cwd: ctx.repoRoot });
    const first = await git.executor.exec(["worktree", "remove", path], { timeout: WORKTREE_REMOVE_TIMEOUT_MS });

    if (first.success) {
        return null;
    }

    const status = await git.status({ cwd: path, untracked: "normal" });
    const nonDeletions = status.entries.filter((e) => e.index !== "D" && e.worktree !== "D");

    if (nonDeletions.length > 0) {
        return `worktree remove refused and the tree holds ${nonDeletions.length} non-deletion entr${nonDeletions.length === 1 ? "y" : "ies"}: ${first.stderr}`;
    }

    logger.debug({ path }, "merged --prune: only deletion debris left, retrying worktree remove --force");
    const forced = await git.executor.exec(["worktree", "remove", "--force", path], {
        timeout: WORKTREE_REMOVE_TIMEOUT_MS,
    });
    return forced.success ? null : `worktree remove --force failed: ${forced.stderr}`;
}

/** Run the confirmed plans in order: worktree, then branch, then remote. Each failure is recorded, never fatal. */
export async function executePrune(ctx: PruneContext, plans: PrunePlan[]): Promise<PruneOutcome[]> {
    const git = createGit({ cwd: ctx.repoRoot });
    const outcomes: PruneOutcome[] = [];

    for (const plan of plans) {
        const outcome: PruneOutcome = {
            ref: plan.ref,
            removedWorktree: null,
            deletedBranch: null,
            deletedRemote: null,
            failures: [],
        };

        if (plan.worktreePath) {
            const failure = await removeWorktree(ctx, plan.worktreePath);

            if (failure) {
                outcome.failures.push(failure);
            } else {
                outcome.removedWorktree = plan.worktreePath;
            }
        }

        if (plan.branch && plan.tipSha && outcome.failures.length === 0) {
            const res = await git.executor.exec(["branch", "-D", plan.branch]);

            if (res.success) {
                outcome.deletedBranch = { name: plan.branch, sha: plan.tipSha };
            } else {
                outcome.failures.push(`branch -D ${plan.branch}: ${res.stderr}`);
            }
        }

        if (plan.remoteBranch && outcome.failures.length === 0) {
            const res = await git.executor.exec(["push", "origin", "--delete", plan.remoteBranch], { timeout: 60_000 });

            if (res.success) {
                outcome.deletedRemote = { name: plan.remoteBranch, sha: plan.remoteSha ?? "" };
            } else {
                outcome.failures.push(`push origin --delete ${plan.remoteBranch}: ${res.stderr}`);
            }
        }

        logger.debug({ ...outcome }, "merged --prune: outcome");
        outcomes.push(outcome);
    }

    return outcomes;
}
