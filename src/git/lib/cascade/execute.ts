import { existsSync } from "node:fs";
import { type CollectContext, collectRefReport, type RefReport } from "@app/git/lib/merged/collect";
import type { DetectedBase, WorktreeInfo } from "@genesiscz/utils/git";
import { createGit, getCurrentBranch } from "@genesiscz/utils/git";
import { logger } from "@genesiscz/utils/logger";
import { type BranchFacts, detectChildren, orderChildren } from "./plan";
import {
    BACKUP_REF_PREFIX,
    BACKUP_TAG_PREFIX,
    type CascadeChild,
    type CascadePlan,
    clearState,
    type ParentRoute,
    saveState,
} from "./state";

type Git = ReturnType<typeof createGit>;
type Report = (line: string) => void;

/** Everything a running cascade needs: the git handle, where the plan file lives, the plan, and where lines go. */
export interface CascadeRun {
    git: Git;
    commonDir: string;
    plan: CascadePlan;
    report: Report;
}

/** Route the parent through the oracle merge when this share of its touched files already landed. */
export const ORACLE_CONTENT_RATIO = 0.8;

/** Throws instead of answering 0: a failed count would silently shrink the child set or misreport drops. */
export async function countCommits(git: Git, range: string): Promise<number> {
    const res = await git.executor.exec(["rev-list", "--count", range]);

    if (!res.success) {
        throw new Error(`git rev-list --count ${range} failed: ${res.stderr.trim()}`);
    }

    const count = Number.parseInt(res.stdout, 10);

    if (Number.isNaN(count)) {
        throw new Error(`git rev-list --count ${range} returned "${res.stdout}"`);
    }

    return count;
}

async function mergeBaseOrNull({ git, a, b }: { git: Git; a: string; b: string }): Promise<string | null> {
    const res = await git.executor.exec(["merge-base", a, b]);
    return res.success ? res.stdout : null;
}

async function treeOf(git: Git, ref: string): Promise<string> {
    return (await git.executor.exec(["rev-parse", `${ref}^{tree}`])).stdout;
}

export interface GatherChildFactsOptions {
    git: Git;
    parent: string;
    target: string;
    candidates: string[];
}

/** Facts for detectChildren: how much parent-only history each candidate shares with the parent and with each other. */
export async function gatherChildFacts({
    git,
    parent,
    target,
    candidates,
}: GatherChildFactsOptions): Promise<BranchFacts[]> {
    const facts: BranchFacts[] = [];

    for (const name of candidates) {
        const mb = await mergeBaseOrNull({ git, a: name, b: parent });
        facts.push({ name, depthViaParent: mb ? await countCommits(git, `${target}..${mb}`) : 0, depthVia: {} });
    }

    const children = facts.filter((f) => f.depthViaParent > 0);

    for (const child of children) {
        const tip = await git.getSha(child.name);

        for (const other of children) {
            if (other.name === child.name) {
                continue;
            }

            const mb = await mergeBaseOrNull({ git, a: child.name, b: other.name });

            if (!mb || mb === tip) {
                continue;
            }

            child.depthVia[other.name] = await countCommits(git, `${target}..${mb}`);
        }
    }

    return facts;
}

export interface BuildPlanOptions {
    /** The invoking checkout; branches checked out nowhere are rebased here. */
    cwd: string;
    repoRoot: string;
    parent: string;
    target: DetectedBase;
    /** Explicit children instead of detection. */
    childOverride?: string[];
    worktrees: WorktreeInfo[];
    nowEpoch: number;
}

export interface BuiltPlan {
    plan: CascadePlan;
    parentReport: RefReport;
}

/** Everything the confirmation prints, computed read-only: nothing moves here. */
export async function buildPlan(opts: BuildPlanOptions): Promise<BuiltPlan> {
    const git = createGit({ cwd: opts.repoRoot });
    const { parent } = opts;
    const target = opts.target.ref;
    const targetLocal = target.replace(/^origin\//, "");
    const local = await git.listLocalBranchNames();

    if (!local.includes(parent)) {
        throw new Error(`parent branch ${parent} does not exist locally`);
    }

    const candidates = opts.childOverride ?? local.filter((b) => b !== parent && b !== targetLocal);

    for (const c of candidates) {
        if (!local.includes(c)) {
            throw new Error(`child branch ${c} does not exist locally`);
        }
    }

    const facts = await gatherChildFacts({ git, parent, target, candidates });
    let detected = detectChildren(parent, facts);

    if (opts.childOverride) {
        const known = new Set(detected.map((d) => d.name));
        const forced = opts.childOverride.filter((c) => !known.has(c)).map((c) => ({ name: c, directParent: parent }));
        detected = [...detected, ...forced];
    }

    const ordered = orderChildren(parent, detected);
    const oldTips: Record<string, string> = { [parent]: await git.getSha(parent) };
    const upstreams: Record<string, string | null> = {};
    const children: CascadeChild[] = [];
    const skipped: CascadePlan["skipped"] = [];
    const forced = new Set(opts.childOverride ?? []);

    for (const c of ordered) {
        oldTips[c.name] = await git.getSha(c.name);
    }

    for (const c of ordered) {
        const forkPoint =
            (await mergeBaseOrNull({ git, a: oldTips[c.directParent], b: c.name })) ?? oldTips[c.directParent];
        const commits = await countCommits(git, `${forkPoint}..${c.name}`);

        // A branch that merely points at an older parent commit (a snapshot, a marker) has
        // parent-only history but nothing of its own; a transplant would reset it to the new
        // parent tip and silently destroy the marker. Only an explicit --child moves one.
        if (commits === 0 && !forced.has(c.name)) {
            skipped.push({ name: c.name, reason: "0 commits of its own" });
            continue;
        }

        children.push({
            name: c.name,
            directParent: c.directParent,
            forkPoint,
            commits,
            worktree: opts.worktrees.find((w) => w.branch === c.name)?.path ?? null,
        });
    }

    // Only once every child has read its parent's tip: a skipped branch can still be the
    // recorded directParent of a later one, and dropping its sha mid-loop would leave that
    // child without a fork point. Nothing below moves a skipped branch, so it leaves here.
    for (const { name } of skipped) {
        delete oldTips[name];
    }

    for (const b of Object.keys(oldTips)) {
        const up = await git.executor.exec(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${b}`]);
        upstreams[b] = up.success ? up.stdout : null;
    }

    const ctx: CollectContext = {
        repoRoot: opts.repoRoot,
        worktrees: opts.worktrees,
        base: opts.target,
        driver: null,
        wantPr: false,
        staleDays: 90,
        nowEpoch: opts.nowEpoch,
    };
    const parentReport = await collectRefReport(ctx, parent);
    let parentRoute: ParentRoute = "rebase";
    let parentEvidence: CascadePlan["parentEvidence"] = null;

    if (parentReport.verdict !== "UNMERGED") {
        parentRoute = "merged";
    } else if (
        parentReport.touched !== null &&
        parentReport.touched > 0 &&
        parentReport.cherryPlus > 0 &&
        (parentReport.touched - parentReport.unmerged.length) / parentReport.touched >= ORACLE_CONTENT_RATIO
    ) {
        parentRoute = "oracle";
        const merge = await git.mergeTree(target, parent);
        parentEvidence = {
            touched: parentReport.touched,
            unmerged: parentReport.unmerged.length,
            cherryPlus: parentReport.cherryPlus,
            conflicts: merge.conflictedFiles,
        };
    }

    const plan: CascadePlan = {
        version: 1,
        startedAt: new Date().toISOString(),
        cwd: opts.cwd,
        parent,
        parentWorktree: opts.worktrees.find((w) => w.branch === parent)?.path ?? null,
        target,
        targetSha: await git.getSha(target),
        oldParent: oldTips[parent],
        parentRoute,
        parentEvidence,
        children,
        skipped,
        oldTips,
        backups: {},
        upstreams,
        phase: "planned",
        current: null,
        completed: [],
        originalBranch: await getCurrentBranch(opts.cwd),
    };

    logger.debug({ parent, target, parentRoute, children: children.map((c) => c.name) }, "cascade: plan built");
    return { plan, parentReport };
}

/** The human-readable plan, one line per step. */
export function planLines(plan: CascadePlan): string[] {
    const lines: string[] = [];
    const short = (sha: string): string => sha.slice(0, 9);
    lines.push(`target: ${plan.target} (${short(plan.targetSha)})`);

    if (plan.parentRoute === "rebase") {
        lines.push(`parent: ${plan.parent} (${short(plan.oldParent)}) → git rebase ${plan.target} ${plan.parent}`);
    } else if (plan.parentRoute === "merged") {
        lines.push(
            `parent: ${plan.parent} is already on ${plan.target}; it is not rebased, children go straight onto ${plan.target}`
        );
        lines.push(`        (removable later: tools git merged --prune ${plan.parent})`);
    } else {
        const e = plan.parentEvidence;
        const numbers = e
            ? `${e.touched - e.unmerged}/${e.touched} touched files already landed, ${e.cherryPlus} unmatched patch-ids`
            : "content mostly landed";
        lines.push(`parent: ${plan.parent} was recomposed upstream (${numbers})`);
        lines.push(
            "        → route it through the oracle merge by hand (gt:git references/oracle-merge.md), then run --continue"
        );

        if (e && e.conflicts.length > 0) {
            lines.push(`        net conflicts (merge-tree): ${e.conflicts.join(", ")}`);
        }
    }

    for (const c of plan.children) {
        const where = c.worktree ? ` [worktree ${c.worktree}]` : "";
        const onto = c.directParent === plan.parent && plan.parentRoute === "merged" ? plan.target : c.directParent;
        const count = `${c.commits} commit${c.commits === 1 ? "" : "s"}`;
        lines.push(
            `child:  ${c.name} (${count}) → git rebase --onto <new ${onto}> ${short(c.forkPoint)} ${c.name}${where}`
        );
    }

    if (plan.children.length === 0) {
        lines.push("children: none detected");
    }

    for (const sk of plan.skipped ?? []) {
        lines.push(`skip:   ${sk.name} (${sk.reason}; pass --child ${sk.name} to move it anyway)`);
    }

    return lines;
}

export interface CreateBackupsOptions {
    git: Git;
    plan: CascadePlan;
    /** Timestamp suffix for the human-readable tag. */
    stamp: string;
}

/** Backups before the first move: a ref that survives gc and stays out of listings, plus a tag a human can read. */
export async function createBackups({ git, plan, stamp }: CreateBackupsOptions): Promise<void> {
    for (const [branch, sha] of Object.entries(plan.oldTips)) {
        const ref = `${BACKUP_REF_PREFIX}/${branch}`;
        const tag = `${BACKUP_TAG_PREFIX}/${branch.replace(/\//g, "-")}-${stamp}`;
        await git.updateRef(ref, sha);
        await git.deleteTag(tag);
        await git.createTag(tag, sha);
        plan.backups[branch] = { ref, tag, sha };
    }
}

/** Where a branch's rebase runs: its own worktree, or the invoking checkout. */
export function cwdFor(plan: CascadePlan, branch: string): string {
    if (branch === plan.parent) {
        return plan.parentWorktree ?? plan.cwd;
    }

    return plan.children.find((c) => c.name === branch)?.worktree ?? plan.cwd;
}

export async function rebaseInProgress(git: Git, cwd: string): Promise<boolean> {
    const res = await git.executor.exec(
        ["rev-parse", "--path-format=absolute", "--git-path", "rebase-merge", "--git-path", "rebase-apply"],
        { cwd }
    );
    return res.success && res.stdout.split("\n").some((p) => p.trim().length > 0 && existsSync(p.trim()));
}

async function conflictedFiles(git: Git, cwd: string): Promise<string[]> {
    const res = await git.executor.exec(["diff", "--name-only", "--diff-filter=U"], { cwd });
    return res.stdout.split("\n").filter((l) => l.length > 0);
}

export type StepStatus = "done" | "conflict" | "stopped" | "failed";

export interface StepResult {
    status: StepStatus;
    branch: string | null;
    message: string;
    conflictFiles: string[];
}

async function runRebase({
    run,
    branch,
    args,
}: {
    run: CascadeRun;
    branch: string;
    args: string[];
}): Promise<StepResult | null> {
    const cwd = cwdFor(run.plan, branch);
    run.report(`$ git -C ${cwd} ${args.join(" ")}`);
    const res = await run.git.executor.exec(args, { cwd });

    if (res.success) {
        return null;
    }

    if (await rebaseInProgress(run.git, cwd)) {
        return { status: "conflict", branch, message: res.stderr, conflictFiles: await conflictedFiles(run.git, cwd) };
    }

    return { status: "failed", branch, message: res.stderr, conflictFiles: [] };
}

/** The base a child lands on right now: its direct parent's current tip, or the target when the parent was already upstream. */
export async function currentBaseFor({
    git,
    plan,
    child,
}: {
    git: Git;
    plan: CascadePlan;
    child: CascadeChild;
}): Promise<string> {
    if (child.directParent === plan.parent && plan.parentRoute === "merged") {
        return git.getSha(plan.target);
    }

    return git.getSha(child.directParent);
}

export interface VerifyChildOptions {
    git: Git;
    plan: CascadePlan;
    child: CascadeChild;
    /** The tip the child was just transplanted onto. */
    newBase: string;
}

/**
 * After a transplant: when the new base has the same tree as the old direct
 * parent tip (a recompose, or a parent already upstream in identical form)
 * the child's tree must be byte-identical to its backup. Otherwise the
 * child's own commits must all have been replayed; fewer means some were
 * dropped as already upstream, which is reported, not refused.
 */
export async function verifyChild({ git, plan, child, newBase }: VerifyChildOptions): Promise<StepResult | null> {
    const backupRef = plan.backups[child.name]?.tag ?? plan.oldTips[child.name];
    const identityRequired = (await treeOf(git, plan.oldTips[child.directParent])) === (await treeOf(git, newBase));

    if (identityRequired) {
        const diff = await git.executor.exec([
            "diff",
            "--quiet",
            plan.backups[child.name]?.sha ?? backupRef,
            child.name,
        ]);

        if (!diff.success) {
            return {
                status: "failed",
                branch: child.name,
                message: `tree of ${child.name} changed although its base tree did not; run --abort and inspect git diff ${backupRef} ${child.name}`,
                conflictFiles: [],
            };
        }

        return null;
    }

    const replayed = await countCommits(git, `${newBase}..${child.name}`);

    if (replayed < child.commits) {
        return {
            status: "done",
            branch: child.name,
            message: `${child.commits - replayed} of ${child.commits} commits dropped as already upstream; check git range-diff ${backupRef}~${child.commits}..${backupRef} ${newBase}..${child.name}`,
            conflictFiles: [],
        };
    }

    return null;
}

async function returnToOriginalBranch({ git, plan, report }: CascadeRun): Promise<void> {
    const original = plan.originalBranch;

    if (!original) {
        return;
    }

    const current = await getCurrentBranch(plan.cwd);

    if (current === original) {
        return;
    }

    const res = await git.executor.exec(["checkout", "-q", original], { cwd: plan.cwd });
    report(res.success ? `back on ${original}` : `could not return to ${original}: ${res.stderr}`);
}

/**
 * Drive the plan from its current phase. Returns at the first conflict (that
 * branch's rebase stays in progress for the human), at an oracle stop, at a
 * failed verification, or when everything is done.
 */
export async function runCascade(run: CascadeRun): Promise<StepResult> {
    const { git, commonDir, plan, report } = run;
    const save = (): void => saveState(commonDir, plan);

    if (plan.phase === "planned" || plan.phase === "parent") {
        plan.phase = "parent";
        save();

        if (!plan.completed.includes(plan.parent)) {
            if (plan.parentRoute === "rebase") {
                const failure = await runRebase({
                    run,
                    branch: plan.parent,
                    args: ["rebase", plan.target, plan.parent],
                });

                if (failure) {
                    plan.current = plan.parent;
                    save();
                    return failure;
                }

                report(`${plan.parent} rebased onto ${plan.target}`);
            } else if (plan.parentRoute === "oracle") {
                const landed = await git.isAncestor(plan.targetSha, plan.parent);

                if (!landed) {
                    plan.current = plan.parent;
                    save();
                    return {
                        status: "stopped",
                        branch: plan.parent,
                        message: `${plan.parent} needs the oracle merge by hand; when it sits on ${plan.target}, run --continue`,
                        conflictFiles: plan.parentEvidence?.conflicts ?? [],
                    };
                }

                report(`${plan.parent} already sits on ${plan.target}`);
            } else {
                report(`${plan.parent} is already upstream; not rebased`);
            }

            plan.completed.push(plan.parent);
        }

        plan.current = null;
        plan.phase = "children";
        save();
    }

    if (plan.phase === "children") {
        const notes: string[] = [];

        for (const child of plan.children) {
            if (plan.completed.includes(child.name)) {
                continue;
            }

            const newBase = await currentBaseFor({ git, plan, child });
            const failure = await runRebase({
                run,
                branch: child.name,
                args: ["rebase", "--onto", newBase, child.forkPoint, child.name],
            });

            if (failure) {
                plan.current = child.name;
                save();
                return failure;
            }

            const verdict = await verifyChild({ git, plan, child, newBase });

            if (verdict?.status === "failed") {
                plan.current = child.name;
                save();
                return verdict;
            }

            if (verdict) {
                notes.push(verdict.message);
                report(`⚠ ${child.name}: ${verdict.message}`);
            }

            const onto =
                child.directParent === plan.parent && plan.parentRoute === "merged" ? plan.target : child.directParent;
            report(`${child.name} transplanted onto ${onto}`);
            plan.completed.push(child.name);
            plan.current = null;
            save();
        }

        plan.phase = "done";
        save();
        await returnToOriginalBranch(run);
        return { status: "done", branch: null, message: notes.join("; ") || "cascade complete", conflictFiles: [] };
    }

    return { status: "done", branch: null, message: "cascade already complete", conflictFiles: [] };
}

/** `--continue`: the branch that stopped must have finished its rebase; verify it, then carry on. */
export async function continueCascade(run: CascadeRun): Promise<StepResult> {
    const { git, commonDir, plan, report } = run;
    const current = plan.current;

    if (current) {
        const cwd = cwdFor(plan, current);

        if (await rebaseInProgress(git, cwd)) {
            return {
                status: "conflict",
                branch: current,
                message: `${current} still has a rebase in progress in ${cwd}; resolve, git add, git rebase --continue, then run --continue again`,
                conflictFiles: await conflictedFiles(git, cwd),
            };
        }

        if (current !== plan.parent) {
            const child = plan.children.find((c) => c.name === current);

            if (child) {
                const newBase = await currentBaseFor({ git, plan, child });
                const verdict = await verifyChild({ git, plan, child, newBase });

                if (verdict?.status === "failed") {
                    return verdict;
                }

                if (verdict) {
                    report(`⚠ ${child.name}: ${verdict.message}`);
                }
            }

            plan.completed.push(current);
        } else if (plan.parentRoute !== "oracle") {
            plan.completed.push(current);
        }

        plan.current = null;
        saveState(commonDir, plan);
    }

    return runCascade(run);
}

/** Put one branch back at its backup: abort any rebase in its checkout, then reset or update-ref. */
export async function restoreBranch({ run, branch }: { run: CascadeRun; branch: string }): Promise<void> {
    const { git, plan, report } = run;
    const backup = plan.backups[branch];

    if (!backup) {
        report(`no backup for ${branch}`);
        return;
    }

    const worktrees = await git.worktrees();
    const checkedOut = worktrees.find((w) => w.branch === branch);
    const cwd = cwdFor(plan, branch);

    if (await rebaseInProgress(git, cwd)) {
        await git.executor.exec(["rebase", "--abort"], { cwd });
    }

    if (checkedOut) {
        const dirt = (await git.status({ cwd: checkedOut.path })).entries.length;

        if (dirt > 0) {
            const current = (await git.getSha(branch)).slice(0, 9);
            report(
                `${branch}: worktree ${checkedOut.path} is dirty (${dirt} entr${dirt === 1 ? "y" : "ies"}), left at ${current}; restore by hand: git -C ${checkedOut.path} reset --hard ${backup.sha}`
            );
            return;
        }

        await git.executor.exec(["reset", "-q", "--hard", backup.sha], { cwd: checkedOut.path });
    } else {
        await git.updateRef(`refs/heads/${branch}`, backup.sha);
    }

    report(`${branch} restored to ${backup.sha.slice(0, 9)}`);
}

export async function abortCascade(run: CascadeRun): Promise<void> {
    for (const branch of Object.keys(run.plan.backups)) {
        await restoreBranch({ run, branch });
    }

    await returnToOriginalBranch(run);
    clearState(run.commonDir);
    run.report("plan cleared; backup tags kept (tools git rebase-cascade --cleanup removes them)");
}

export async function cleanupBackups({
    git,
    commonDir,
    report,
}: {
    git: Git;
    commonDir: string;
    report: Report;
}): Promise<void> {
    for (const ref of await git.listRefs(`${BACKUP_REF_PREFIX}/*`)) {
        await git.deleteRef(ref);
        report(`deleted ${ref}`);
    }

    for (const tag of await git.listRefs(`refs/tags/${BACKUP_TAG_PREFIX}/*`)) {
        await git.deleteTag(tag.replace(/^refs\/tags\//, ""));
        report(`deleted ${tag}`);
    }

    clearState(commonDir);
}

/** The exact push lines, never run: the lease anchor is the remote sha captured before anything moved. */
export function pushLines(plan: CascadePlan): string[] {
    const children = plan.children.map((c) => c.name);
    const branches = plan.parentRoute === "merged" ? children : [plan.parent, ...children];
    return branches.map((b) => {
        const anchor = plan.upstreams[b];
        return anchor ? `git push --force-with-lease=${b}:${anchor} origin ${b}` : `git push -u origin ${b}`;
    });
}
