/**
 * `rebranch apply` as one operation, for every caller. It refuses contradicting options, takes the repository
 * lock, then either recovers (`--continue`, `--abort`) or reads the plan, checks the branches and the checkout,
 * builds the branches and proves the split. The Commander action and the tests both call `runApplyFlow`, so a
 * caller never reaches `runApply` without the preconditions before it and the proof after it. Output and the
 * single confirmation go through `ApplyFlowIo`, which is what keeps this module free of any terminal.
 */

import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { createGit, getCurrentBranch } from "@genesiscz/utils/git";
import pc from "picocolors";
import {
    type ApplyResult,
    type ApplyRun,
    abortApply,
    applyCommands,
    applyStatePath,
    branchProblems,
    checkoutProblems,
    clearApplyState,
    continueApply,
    loadApplyState,
    type RebranchState,
    runApply,
    saveApplyState,
    withApplyLock,
} from "./apply";
import { mergeRefusal, proveSplit, readSourceHistory, resolveCommit } from "./history";
import { readPlanFile, resolvePlan } from "./plan";
import { planGroupLines, pushLines, reportLines } from "./render";

export interface ApplyOptions {
    plan?: string;
    yes?: boolean;
    dryRun?: boolean;
    continue?: boolean;
    abort?: boolean;
    cwd?: string;
}

export interface ApplyFlowIo {
    say: (line: string) => void;
    error: (message: string) => void;
    warn: (message: string) => void;
    info: (message: string) => void;
    success: (message: string) => void;
    /** Asks once and resolves true on yes. Null when nobody can be asked, which makes `--yes` required. */
    confirm: ((message: string) => Promise<boolean>) | null;
}

const short = (sha: string): string => sha.slice(0, 9);

function stamp(): string {
    return new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

/** Why these options contradict each other; null when they do not. `--continue` and `--abort` always act. */
function modeConflict(opts: ApplyOptions): string | null {
    if (opts.continue && opts.abort) {
        return "--continue and --abort cannot be combined; run one of them";
    }

    if (opts.dryRun && (opts.continue || opts.abort)) {
        return `--dry-run previews a new apply, and ${opts.continue ? "--continue" : "--abort"} always acts; drop --dry-run`;
    }

    return null;
}

async function finishApply({
    run,
    result,
    io,
}: {
    run: ApplyRun;
    result: ApplyResult;
    io: ApplyFlowIo;
}): Promise<number> {
    const { state } = run;
    const { say } = io;

    if (result.status === "conflict") {
        io.warn(`conflict in ${result.group}: ${result.message}`);

        for (const file of result.conflictFiles) {
            say(`  ${file}`);
        }

        say(`resolve in ${state.cwd}, git add, then git cherry-pick --continue (or git cherry-pick --skip), then:`);
        say(`  ${toolCommand("git rebranch apply", "--continue")}`);
        say(`or undo everything this run created: ${toolCommand("git rebranch apply", "--abort")}`);
        return 1;
    }

    if (result.status === "failed") {
        io.error(`${result.group ?? "rebranch"}: ${result.message}`);
        say(`  ${toolCommand("git rebranch apply", "--continue")} after fixing it, or`);
        say(`  ${toolCommand("git rebranch apply", "--abort")}`);
        return 1;
    }

    const sourceNow = await resolveCommit(run.git, state.plan.source);

    if (sourceNow !== state.sourceSha) {
        io.warn(`${state.plan.source} moved during the apply; the proof below uses ${short(state.sourceSha)}`);
    }

    const history = await readSourceHistory(run.git, { source: state.sourceSha, base: state.baseSha });
    const proof = await proveSplit({ git: run.git, plan: state.plan, history, baseSha: state.baseSha });

    if (proof.report.ok) {
        clearApplyState(run.commonDir);
    }

    say("");

    for (const g of state.plan.groups) {
        const outcomes = state.outcomes.filter((o) => o.group === g.name);
        say(`${pc.bold(g.branch)}: ${outcomes.filter((o) => o.newSha).length} commit(s)`);

        for (const o of outcomes) {
            const pick = g.picks.find((pk) => pk.sha === o.sha);
            const note = o.result === "picked" ? "" : ` [${o.result}]`;
            say(`  ${o.newSha ? short(o.newSha) : "---------"} ${pick?.subject ?? short(o.sha)}${note}`);
        }
    }

    say("");

    for (const line of reportLines(proof.report, proof.expectedFrom)) {
        say(line);
    }

    say("");

    if (!proof.report.ok) {
        say(`the apply state is kept in ${applyStatePath(run.commonDir)}; the branches are built but not proven:`);
        say(`  fix them, then ${toolCommand("git rebranch apply", "--continue")} proves the split again`);
        say(`  ${toolCommand("git rebranch apply", "--abort")} removes them (each is tagged first)`);
        say("  or start another apply, which replaces this record and leaves these branches in place");
        say("");
    }

    say("held until the user says push (rebranch never pushes):");

    for (const line of pushLines(state.plan)) {
        say(`  ${line}`);
    }

    return proof.report.ok ? 0 : 1;
}

/** Exit codes: 0 done and proven, 1 a refusal, conflict, failure or failed proof, 2 wrong arguments. */
export async function runApplyFlow(opts: ApplyOptions, io: ApplyFlowIo): Promise<number> {
    const conflict = modeConflict(opts);

    if (conflict) {
        io.error(conflict);
        return 2;
    }

    const { repoRoot, commonDir } = await createGit({ cwd: opts.cwd ?? process.cwd() }).layout();

    return withApplyLock(commonDir, () => applyLocked({ opts, io, repoRoot, commonDir }));
}

async function applyLocked({
    opts,
    io,
    repoRoot,
    commonDir,
}: {
    opts: ApplyOptions;
    io: ApplyFlowIo;
    repoRoot: string;
    commonDir: string;
}): Promise<number> {
    const { say } = io;
    const git = createGit({ cwd: repoRoot });
    const existing = loadApplyState(commonDir);

    if (opts.continue || opts.abort) {
        if (!existing) {
            io.error("no rebranch apply in progress");
            return 1;
        }

        const run: ApplyRun = { git: createGit({ cwd: existing.cwd }), commonDir, state: existing, report: say };

        if (opts.abort) {
            const done = await abortApply(run, stamp());

            if (done) {
                io.success("aborted: every branch this run created is removed (and tagged), the checkout is back");
            }

            return done ? 0 : 1;
        }

        return finishApply({ run, result: await continueApply(run), io });
    }

    if (!opts.plan) {
        io.error("Pass --plan <file> (or - for stdin), --continue or --abort.");
        return 2;
    }

    if (existing && existing.phase !== "done") {
        io.error(
            `a rebranch apply is already in progress (started ${existing.startedAt} in ${existing.cwd}); run --continue or --abort first`
        );
        return 1;
    }

    if (existing) {
        io.warn(
            `the apply started ${existing.startedAt} ended unproven; this run replaces its record and leaves its branches in place`
        );
    }

    const plan = await readPlanFile(opts.plan);
    const history = await readSourceHistory(git, { source: plan.source, base: plan.base });

    if (history.merges.length > 0) {
        io.error(mergeRefusal(history));
        return 1;
    }

    const { resolved, problems } = resolvePlan(plan, history.commits);
    problems.push(
        ...(await branchProblems(
            git,
            resolved.groups.map((g) => g.branch)
        ))
    );

    if (problems.length > 0) {
        io.error(`the plan cannot run (${problems.length} problem(s)):`);

        for (const problem of problems) {
            say(`  ${problem}`);
        }

        return 1;
    }

    if (plan.baseSha && !history.baseSha.startsWith(plan.baseSha)) {
        io.warn(`${plan.base} moved since the plan; the branches start at ${short(history.baseSha)}`);
    }

    if (plan.sourceSha && !history.sourceSha.startsWith(plan.sourceSha)) {
        io.warn(`${plan.source} moved since the plan (${short(plan.sourceSha)} → ${short(history.sourceSha)})`);
    }

    if (resolved.reordered.length > 0) {
        io.info(`picked in source order, not as listed: ${resolved.reordered.join(", ")}`);
    }

    if (resolved.unassigned.length > 0) {
        io.warn(
            `${resolved.unassigned.length} commit(s) are in no group and not under skip; verify reports what they change as lost: ${resolved.unassigned.map((c) => short(c.sha)).join(", ")}`
        );
    }

    for (const line of planGroupLines(resolved)) {
        say(line);
    }

    const original = { branch: await getCurrentBranch(repoRoot), sha: await git.getSha("HEAD") };
    const checkout = await checkoutProblems(git);

    if (opts.dryRun) {
        for (const problem of checkout) {
            io.warn(`a real run would refuse: ${problem}`);
        }

        say("");
        say(applyCommands(resolved, { base: plan.base, returnTo: original.branch ?? original.sha }).join("\n"));
        io.info("dry run: nothing written, no branch created");
        return 0;
    }

    if (checkout.length > 0) {
        io.error(`nothing created: ${checkout.join("; ")}`);
        return 1;
    }

    if (!opts.yes) {
        if (!io.confirm) {
            io.error("Non-interactive: pass --yes to run the plan as printed.");
            io.info(toolCommand("git rebranch apply", "--plan", opts.plan, "--yes"));
            return 2;
        }

        if (!(await io.confirm("Create these branches? (nothing is pushed)"))) {
            io.info("Cancelled. Nothing created.");
            return 1;
        }
    }

    const state: RebranchState = {
        version: 1,
        startedAt: new Date().toISOString(),
        cwd: repoRoot,
        plan: resolved,
        sourceSha: history.sourceSha,
        baseSha: history.baseSha,
        mergeBase: history.mergeBase,
        original,
        position: { group: 0, pick: 0 },
        pending: null,
        created: {},
        outcomes: [],
        phase: "running",
    };
    saveApplyState(commonDir, state);
    const run: ApplyRun = { git, commonDir, state, report: say };

    return finishApply({ run, result: await runApply(run), io });
}
