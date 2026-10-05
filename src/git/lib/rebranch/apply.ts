/**
 * `rebranch apply`: build one branch per group from the base with `git cherry-pick -x`, in source
 * order, resumable after a conflict. The state file lives in the git common dir like
 * `rebase-cascade`'s, so `--continue` and `--abort` find it from any worktree, and every command
 * runs in the checkout that started the operation.
 *
 * Nothing pre-existing moves: the group branches must not exist yet, the source is only read,
 * and the starting branch is switched back to at the end. `--abort` tags every branch it created
 * before deleting it, so no commit is lost.
 */

import { join } from "node:path";
import { readStateFile, removeStateFile, writeStateFile } from "@app/git/lib/state-file";
import { type createGit, isCleanStatus, parseNameStatusZ } from "@genesiscz/utils/git";
import { logger } from "@genesiscz/utils/logger";
import { LockTimeoutError, withFileLock } from "@genesiscz/utils/storage/file-lock";
import { activePicks, type Decision, type ResolvedGroup, type ResolvedPick, type ResolvedPlan } from "./plan";

type Git = ReturnType<typeof createGit>;

export const REBRANCH_STATE_FILENAME = "genesis-rebranch.json";
export const REBRANCH_LOCK_FILENAME = "genesis-rebranch.lock";
export const BACKUP_TAG_PREFIX = "bkp/rebranch";

/** Paths per `git restore` call, well under any argv limit. */
const PATHSPEC_CHUNK = 200;

export interface PickOutcome {
    group: string;
    sha: string;
    decision: Decision;
    result: "picked" | "paths-only" | "skipped-by-hand";
    newSha: string | null;
    stripped: string[];
}

export interface RebranchState {
    version: 1;
    startedAt: string;
    /** The checkout the operation runs in. */
    cwd: string;
    plan: ResolvedPlan;
    sourceSha: string;
    baseSha: string;
    mergeBase: string;
    /** Where the checkout was before the first switch; apply and abort return here. */
    original: { branch: string | null; sha: string };
    /** The next pick: an index into plan.groups and into that group's active picks. */
    position: { group: number; pick: number };
    /**
     * The branch tip before the current pick started, set from the moment that pick needs a second
     * step: `cherry-pick` while a person resolves a conflict, `cleanup` once the pick has landed and
     * only its paths-only restore and amend are left. `--continue` finishes that step and never
     * cherry-picks the commit a second time.
     */
    pending: { prePick: string; stage: "cherry-pick" | "cleanup" } | null;
    /** Group branches this run created, with their last known tip. */
    created: Record<string, string>;
    outcomes: PickOutcome[];
    phase: "running" | "stopped" | "done";
}

export interface ApplyRun {
    git: Git;
    commonDir: string;
    state: RebranchState;
    report: (line: string) => void;
}

export type ApplyStatus = "done" | "conflict" | "failed";

export interface ApplyResult {
    status: ApplyStatus;
    group: string | null;
    message: string;
    conflictFiles: string[];
}

const short = (sha: string): string => sha.slice(0, 9);

export function applyStatePath(commonDir: string): string {
    return join(commonDir, REBRANCH_STATE_FILENAME);
}

export function loadApplyState(commonDir: string): RebranchState | null {
    return readStateFile<RebranchState>(applyStatePath(commonDir), { strict: true });
}

export function saveApplyState(commonDir: string, state: RebranchState): void {
    writeStateFile(applyStatePath(commonDir), state);
}

export function clearApplyState(commonDir: string): void {
    removeStateFile(applyStatePath(commonDir));
}

/**
 * Run `fn` as the only rebranch operation of this repository. The lock sits in the git common dir beside
 * the state file, so every linked worktree meets it. Without it two applies started in different worktrees
 * both read "no operation", and the first to finish clears the record the other still needs. It is held
 * from before the state is read until the command ends, `--continue` and `--abort` included. A second
 * invocation is refused at once, not queued: the holder keeps the lock for its whole operation. A holder
 * that died leaves a lock the next invocation takes over.
 */
export async function withApplyLock<T>(commonDir: string, fn: () => Promise<T>): Promise<T> {
    const lockPath = join(commonDir, REBRANCH_LOCK_FILENAME);

    try {
        return await withFileLock(lockPath, fn, 0);
    } catch (err) {
        if (err instanceof LockTimeoutError) {
            throw new Error(
                `another rebranch operation (apply, --continue or --abort) is running in this repository and holds ${lockPath}; run this again once it ends`,
                { cause: err }
            );
        }

        throw err;
    }
}

/** Why this checkout cannot run an apply right now; empty when it can. */
export async function checkoutProblems(git: Git): Promise<string[]> {
    const problems: string[] = [];

    if (await git.isGitLocked()) {
        problems.push("the index is locked (index.lock exists); another git process may be running");
    }

    if (await git.isRebaseInProgress()) {
        problems.push("a rebase is in progress; finish or abort it first");
    }

    if (await git.isCherryPickInProgress()) {
        problems.push("a cherry-pick is in progress; finish or abort it first");
    }

    if (!isCleanStatus(await git.status())) {
        problems.push("the checkout has uncommitted or untracked changes; commit or stash them first");
    }

    return problems;
}

/** Group branch names that are invalid or already taken; apply never overwrites a branch. */
export async function branchProblems(git: Git, branches: string[]): Promise<string[]> {
    const problems: string[] = [];

    for (const branch of branches) {
        const format = await git.executor.exec(["check-ref-format", "--branch", branch]);

        if (!format.success) {
            problems.push(`${branch} is not a valid branch name`);
        } else if (await git.branchExists(branch)) {
            problems.push(`branch ${branch} already exists; rebranch never overwrites a branch, pick another name`);
        }
    }

    return problems;
}

/** Every git command a run would issue, for `--dry-run`. Pure. */
export function applyCommands(plan: ResolvedPlan, opts: { base: string; returnTo: string }): string[] {
    const lines: string[] = [];

    for (const group of plan.groups) {
        const picks = activePicks(group);
        lines.push(`# ${group.name} → ${group.branch} (${picks.length} commit${picks.length === 1 ? "" : "s"})`);
        lines.push(`git switch -c ${group.branch} --no-track ${opts.base}`);

        for (const pick of picks) {
            lines.push(`git cherry-pick -x ${short(pick.sha)}   # ${pick.subject}`);

            if (pick.decision === "paths-only" && pick.outsidePaths.length > 0) {
                lines.push(`#   paths-only: put back ${pick.outsidePaths.length} path(s) outside ${group.name}`);
                lines.push(`git restore --source=HEAD~1 --staged --worktree -- ${pick.outsidePaths.join(" ")}`);
                lines.push("git commit --amend --no-edit --no-verify");
            }
        }

        for (const skipped of group.picks.filter((p) => p.decision === "skip")) {
            lines.push(`#   skip ${short(skipped.sha)}   # ${skipped.subject}`);
        }
    }

    lines.push(`git switch ${opts.returnTo}`);
    return lines;
}

async function exec(run: ApplyRun, args: string[]) {
    run.report(`$ git ${args.join(" ")}`);
    const res = await run.git.executor.exec(args);
    logger.debug({ args, exitCode: res.exitCode, stderr: res.stderr }, "rebranch: git");
    return res;
}

async function currentBranch(git: Git): Promise<string | null> {
    const res = await git.executor.exec(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    return res.success ? res.stdout : null;
}

async function conflictedFiles(git: Git): Promise<string[]> {
    const status = await git.status();
    return status.entries.filter((e) => e.kind === "unmerged").map((e) => e.path);
}

function failed(group: ResolvedGroup | null, message: string): ApplyResult {
    return { status: "failed", group: group?.name ?? null, message, conflictFiles: [] };
}

/** Why the checkout could not go back to where the run started; null once it is there. */
async function returnToOriginal(run: ApplyRun): Promise<string | null> {
    const { original } = run.state;

    if (original.branch) {
        if ((await currentBranch(run.git)) === original.branch) {
            return null;
        }

        const switched = await exec(run, ["switch", original.branch]);
        return switched.success ? null : `could not switch back to ${original.branch}: ${switched.stderr}`;
    }

    const detached = await exec(run, ["switch", "--detach", original.sha]);
    return detached.success ? null : `could not return to ${short(original.sha)} (detached): ${detached.stderr}`;
}

/**
 * The paths of `paths` whose index differs from `rev`, asked per chunk; `error` is git's stderr when it
 * failed. The diff lists a path that was added or deleted and skips one that exists on neither side.
 * `--name-status` leads each path with its status letter, so the executor's trim of the output cannot eat
 * a path that starts with a space.
 */
async function indexDiffers({
    run,
    rev,
    paths,
}: {
    run: ApplyRun;
    rev: string;
    paths: string[];
}): Promise<{ differing: string[]; error: string | null }> {
    const differing: string[] = [];

    for (let i = 0; i < paths.length; i += PATHSPEC_CHUNK) {
        const diff = await exec(run, [
            "--literal-pathspecs",
            "diff",
            "--cached",
            "--name-status",
            "-z",
            "--no-renames",
            rev,
            "--",
            ...paths.slice(i, i + PATHSPEC_CHUNK),
        ]);

        if (!diff.success) {
            return { differing, error: diff.stderr };
        }

        differing.push(...parseNameStatusZ(diff.stdout).map((entry) => entry.path));
    }

    return { differing, error: null };
}

/**
 * Put a paths-only pick's outside paths back at their state in `prePick`. Only the paths whose index
 * differs from `prePick` are handed to `git restore`: an interrupted attempt may have restored some of
 * them, and `git restore` refuses a path that exists in neither the index nor `prePick`.
 */
async function restoreOutsidePaths({
    run,
    pick,
    prePick,
}: {
    run: ApplyRun;
    pick: ResolvedPick;
    prePick: string;
}): Promise<string | null> {
    const { differing, error } = await indexDiffers({ run, rev: prePick, paths: pick.outsidePaths });

    if (error !== null) {
        return `git diff failed for ${short(pick.sha)}: ${error}`;
    }

    for (let i = 0; i < differing.length; i += PATHSPEC_CHUNK) {
        const restored = await exec(run, [
            "--literal-pathspecs",
            "restore",
            `--source=${prePick}`,
            "--staged",
            "--worktree",
            "--",
            ...differing.slice(i, i + PATHSPEC_CHUNK),
        ]);

        if (!restored.success) {
            return `git restore failed for ${short(pick.sha)}: ${restored.stderr}`;
        }
    }

    return null;
}

const named = (paths: string[]): string =>
    paths.length > 5 ? `${paths.slice(0, 5).join(", ")} and ${paths.length - 5} more` : paths.join(", ");

/**
 * Why a paths-only cleanup must not run yet; null when the checkout holds only what the cleanup itself
 * staged. `--continue` resumes the cleanup after a person fixed whatever stopped it. `git restore
 * --staged --worktree` then overwrites an outside path with its `prePick` state and `git commit --amend`
 * commits the whole index, so an edit made in between would be lost or swept into the commit, and nothing
 * backs it up. A restore that already ran leaves outside paths staged at their `prePick` state, which is
 * expected.
 */
async function cleanupProblem({
    run,
    pick,
    prePick,
}: {
    run: ApplyRun;
    pick: ResolvedPick;
    prePick: string;
}): Promise<string | null> {
    const refuse = (what: string): string =>
        `refusing the paths-only cleanup of ${short(pick.sha)}: ${what}; revert or stash that, then run --continue`;
    const status = await run.git.status();
    const unstaged = status.entries
        .filter((entry) => entry.kind !== "ignored" && (entry.kind === "unmerged" || entry.worktree !== "."))
        .map((entry) => entry.path);

    if (unstaged.length > 0) {
        return refuse(`uncommitted changes to ${named(unstaged)}`);
    }

    const staged = await exec(run, ["diff", "--cached", "--name-status", "-z", "--no-renames", "HEAD"]);

    if (!staged.success) {
        return `git diff failed for ${short(pick.sha)}: ${staged.stderr}`;
    }

    const stagedPaths = parseNameStatusZ(staged.stdout).map((entry) => entry.path);
    const outside = new Set(pick.outsidePaths);
    const elsewhere = stagedPaths.filter((path) => !outside.has(path));

    if (elsewhere.length > 0) {
        return refuse(`${named(elsewhere)} staged, which the cleanup never stages`);
    }

    const { differing, error } = await indexDiffers({ run, rev: prePick, paths: stagedPaths });

    if (error !== null) {
        return `git diff failed for ${short(pick.sha)}: ${error}`;
    }

    if (differing.length > 0) {
        return refuse(`${named(differing)} staged with content that is not its state before the pick`);
    }

    return null;
}

/** After a pick landed (or a person skipped it): strip a paths-only pick, record it, advance. */
async function finishPick({
    run,
    group,
    pick,
    prePick,
}: {
    run: ApplyRun;
    group: ResolvedGroup;
    pick: ResolvedPick;
    prePick: string;
}): Promise<ApplyResult | null> {
    const { git, state, report } = run;
    state.pending = { prePick, stage: "cleanup" };
    saveApplyState(run.commonDir, state);
    const head = await git.getSha("HEAD");
    const outcome: PickOutcome = {
        group: group.name,
        sha: pick.sha,
        decision: pick.decision,
        result: "picked",
        newSha: head,
        stripped: [],
    };

    if (head === prePick) {
        outcome.result = "skipped-by-hand";
        outcome.newSha = null;
        report(`⚠ ${short(pick.sha)} "${pick.subject}" left ${group.branch} unchanged (skipped by hand)`);
    } else if (pick.decision === "paths-only" && pick.outsidePaths.length > 0) {
        report(
            `paths-only ${short(pick.sha)}: putting back ${pick.outsidePaths.length} path(s) outside ${group.name} from ${short(prePick)}: ${pick.outsidePaths.join(", ")}`
        );

        const restoreProblem =
            (await cleanupProblem({ run, pick, prePick })) ?? (await restoreOutsidePaths({ run, pick, prePick }));

        if (restoreProblem) {
            state.phase = "stopped";
            saveApplyState(run.commonDir, state);
            return failed(group, restoreProblem);
        }

        const amended = await exec(run, ["commit", "--amend", "--no-edit", "--no-verify", "-q"]);

        if (!amended.success) {
            state.phase = "stopped";
            saveApplyState(run.commonDir, state);
            return failed(group, `git commit --amend failed for ${short(pick.sha)}: ${amended.stderr}`);
        }

        outcome.result = "paths-only";
        outcome.newSha = await git.getSha("HEAD");
        outcome.stripped = pick.outsidePaths;
    }

    state.outcomes.push(outcome);
    state.created[group.branch] = outcome.newSha ?? head;
    state.position.pick += 1;
    state.pending = null;
    saveApplyState(run.commonDir, state);
    return null;
}

/** Drive the plan from the saved position; stops at the first conflict or failure. */
export async function runApply(run: ApplyRun): Promise<ApplyResult> {
    const { git, state, report } = run;
    const save = (): void => saveApplyState(run.commonDir, state);
    state.phase = "running";
    save();

    while (state.position.group < state.plan.groups.length) {
        const group = state.plan.groups[state.position.group];
        const picks = activePicks(group);

        if (!(group.branch in state.created)) {
            const created = await exec(run, ["switch", "-c", group.branch, "--no-track", state.baseSha]);

            if (!created.success) {
                state.phase = "stopped";
                save();
                return failed(group, `could not create ${group.branch}: ${created.stderr}`);
            }

            state.created[group.branch] = state.baseSha;
            save();
        } else if ((await currentBranch(git)) !== group.branch) {
            const switched = await exec(run, ["switch", group.branch]);

            if (!switched.success) {
                state.phase = "stopped";
                save();
                return failed(group, `could not switch to ${group.branch}: ${switched.stderr}`);
            }
        }

        while (state.position.pick < picks.length) {
            const pick = picks[state.position.pick];
            const prePick = await git.getSha("HEAD");
            const picked = await exec(run, ["cherry-pick", "-x", pick.sha]);

            if (!picked.success) {
                state.phase = "stopped";

                if (await git.isCherryPickInProgress()) {
                    state.pending = { prePick, stage: "cherry-pick" };
                    save();
                    return {
                        status: "conflict",
                        group: group.name,
                        message: `${short(pick.sha)} "${pick.subject}" stopped on ${group.branch}`,
                        conflictFiles: await conflictedFiles(git),
                    };
                }

                save();
                return failed(group, `git cherry-pick ${short(pick.sha)} failed: ${picked.stderr}`);
            }

            const stop = await finishPick({ run, group, pick, prePick });

            if (stop) {
                return stop;
            }
        }

        report(`${group.branch}: ${picks.length} commit(s) on ${short(state.baseSha)}`);
        state.position = { group: state.position.group + 1, pick: 0 };
        save();
    }

    const stuck = await returnToOriginal(run);

    if (stuck) {
        state.phase = "stopped";
        save();
        return failed(null, stuck);
    }

    state.phase = "done";
    save();
    return { status: "done", group: null, message: "every group branch is built", conflictFiles: [] };
}

/**
 * `--continue`: a stopped cherry-pick must be finished (or skipped) by hand, and a landed pick whose
 * cleanup was interrupted resumes at that cleanup; then carry on.
 */
export async function continueApply(run: ApplyRun): Promise<ApplyResult> {
    const { git, state } = run;

    if (state.phase === "done") {
        return { status: "done", group: null, message: "the apply already finished", conflictFiles: [] };
    }

    const group = state.plan.groups[state.position.group] ?? null;
    const { pending } = state;

    if (!pending || !group) {
        return runApply(run);
    }

    if (await git.isCherryPickInProgress()) {
        return {
            status: "conflict",
            group: group.name,
            message: `the cherry-pick on ${group.branch} is still in progress in ${state.cwd}; resolve, git add, git cherry-pick --continue (or --skip), then run --continue again`,
            conflictFiles: await conflictedFiles(git),
        };
    }

    if (pending.stage === "cherry-pick") {
        const problems = await checkoutProblems(git);

        if (problems.length > 0) {
            return failed(group, problems.join("; "));
        }
    }

    const branch = await currentBranch(git);

    if (branch !== group.branch) {
        return failed(group, `expected ${state.cwd} to be on ${group.branch}, found ${branch ?? "a detached HEAD"}`);
    }

    const pick = activePicks(group)[state.position.pick];
    const stop = await finishPick({ run, group, pick, prePick: pending.prePick });

    if (stop) {
        return stop;
    }

    return runApply(run);
}

/**
 * Tag `tip` as `bkp/rebranch/<branch>-<stamp>`, each `/` of the branch written as `-`. Two branches can
 * flatten to one name (`feat/api` and `feat-api`) and an earlier attempt may already have tagged this
 * tip: a tag that names `tip` is reused, and a tag that names anything else makes the next `-N` suffix.
 */
async function backupTag({
    git,
    branch,
    tip,
    stamp,
}: {
    git: Git;
    branch: string;
    tip: string;
    stamp: string;
}): Promise<string> {
    const base = `${BACKUP_TAG_PREFIX}/${branch.replace(/\//g, "-")}-${stamp}`;

    for (let n = 1; ; n++) {
        const tag = n === 1 ? base : `${base}-${n}`;
        const existing = await git.executor.exec(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]);

        if (!existing.success) {
            await git.createTag(tag, tip);
            return tag;
        }

        if (existing.stdout === tip) {
            return tag;
        }
    }
}

/**
 * `--abort`: stop any cherry-pick, return to the starting branch, and remove every branch this
 * run created, each tagged first (`bkp/rebranch/<branch>-<stamp>`) so its commits stay reachable.
 * Refuses while the checkout holds uncommitted work.
 */
export async function abortApply(run: ApplyRun, stamp: string): Promise<boolean> {
    const { git, state, report } = run;

    if (await git.isCherryPickInProgress()) {
        await exec(run, ["cherry-pick", "--abort"]);
    }

    const problems = await checkoutProblems(git);

    if (problems.length > 0) {
        report(`nothing removed: ${problems.join("; ")}`);
        return false;
    }

    const stuck = await returnToOriginal(run);

    if (stuck) {
        report(`nothing removed: ${stuck}`);
        return false;
    }

    const kept: Record<string, string> = {};

    for (const branch of Object.keys(state.created)) {
        if (!(await git.branchExists(branch))) {
            report(`${branch} is already gone`);
            continue;
        }

        const tip = await git.getSha(`refs/heads/${branch}`);
        const tag = await backupTag({ git, branch, tip, stamp });
        const deleted = await exec(run, ["branch", "-D", branch]);

        if (deleted.success) {
            report(`removed ${branch} (was ${short(tip)}); restore with: git branch ${branch} ${tag}`);
        } else {
            kept[branch] = tip;
            report(`kept ${branch}: ${deleted.stderr} (its tip is also on ${tag})`);
        }
    }

    const sourceNow = await git.executor.exec(["rev-parse", "--verify", "--quiet", `${state.plan.source}^{commit}`]);

    if (sourceNow.stdout !== state.sourceSha) {
        report(
            `⚠ ${state.plan.source} is at ${short(sourceNow.stdout)}, not ${short(state.sourceSha)}; rebranch never moves it, so something else did`
        );
    }

    if (Object.keys(kept).length > 0) {
        state.created = kept;
        saveApplyState(run.commonDir, state);
        report(`${Object.keys(kept).length} branch(es) could not be removed; fix that, then run --abort again`);
        return false;
    }

    clearApplyState(run.commonDir);
    return true;
}
