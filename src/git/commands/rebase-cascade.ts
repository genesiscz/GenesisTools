/**
 * `tools git rebase-cascade <parent>` — rebase a parent branch onto its
 * target and transplant every child stacked on it, with a backup per branch,
 * one confirmation, and `--continue` after a conflict.
 *
 * Children are detected by merge-base (a child carries parent-only commits
 * the target lacks), fork points are saved before the parent moves, a child
 * checked out in another worktree is rebased there, and nothing is pushed.
 */

import {
    abortCascade,
    buildPlan,
    cleanupBackups,
    continueCascade,
    createBackups,
    planLines,
    pushLines,
    restoreBranch,
    runCascade,
    type StepResult,
} from "@app/git/lib/cascade/execute";
import { loadState, saveState } from "@app/git/lib/cascade/state";
import * as p from "@clack/prompts";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import {
    BaseNotFoundError,
    createGit,
    describeBase,
    detectBase,
    isCleanStatus,
    listWorktrees,
    loadRepoConfig,
    originDriver,
} from "@genesiscz/utils/git";
import { logger, out } from "@genesiscz/utils/logger";
import type { Storage } from "@genesiscz/utils/storage";
import type { Command } from "commander";
import pc from "picocolors";

const log = logger.scoped("rebase-cascade").log;

interface Options {
    onto?: string;
    child: string[];
    dryRun?: boolean;
    yes?: boolean;
    offline?: boolean;
    continue?: boolean;
    status?: boolean;
    abort?: boolean;
    restore?: string;
    cleanup?: boolean;
    cwd?: string;
}

function collectRepeatable(value: string, previous: string[]): string[] {
    return [...previous, value];
}

const say = (line: string): void => out.println(line);

function printResult(result: StepResult): number {
    if (result.status === "done") {
        out.log.success(result.message);
        return 0;
    }

    if (result.status === "conflict") {
        out.log.warn(`conflict on ${result.branch}: ${result.message}`);

        for (const f of result.conflictFiles) {
            out.println(`  ${f}`);
        }

        out.println("resolve by hand, git add, git rebase --continue, then:");
        out.println(`  ${suggestCommand("tools git rebase-cascade", { replaceCommand: ["--continue"] })}`);
        return 1;
    }

    if (result.status === "stopped") {
        out.log.warn(result.message);

        for (const f of result.conflictFiles) {
            out.println(`  ${f}`);
        }

        return 1;
    }

    out.log.error(`${result.branch ?? "cascade"}: ${result.message}`);
    out.println(`  ${suggestCommand("tools git rebase-cascade", { replaceCommand: ["--abort"] })}`);
    return 1;
}

async function run(parentArg: string | undefined, opts: Options): Promise<number> {
    const cwd = opts.cwd ?? process.cwd();
    const git = createGit({ cwd });
    const { repoRoot, commonDir } = await git.layout();
    const existing = loadState(commonDir);

    if (opts.status) {
        if (!existing) {
            out.println("no cascade in progress");
            return 0;
        }

        out.println(`phase: ${existing.phase}${existing.current ? `, waiting on ${existing.current}` : ""}`);
        out.println(`completed: ${existing.completed.join(", ") || "(none)"}`);
        out.println(planLines(existing).join("\n"));
        const targetNow = await git.getSha(existing.target);

        if (targetNow !== existing.targetSha) {
            out.log.warn(
                `${existing.target} moved since the plan (${existing.targetSha.slice(0, 9)} → ${targetNow.slice(0, 9)})`
            );
        }

        for (const [b, backup] of Object.entries(existing.backups)) {
            out.println(`backup: ${b} → ${backup.tag} (${backup.sha.slice(0, 9)})`);
        }

        return 0;
    }

    if (opts.cleanup) {
        if (existing && existing.phase !== "done" && !opts.yes) {
            out.log.error(
                `a cascade is in progress (phase ${existing.phase}); --continue or --abort first, or pass --yes to discard its backups`
            );
            return 1;
        }

        await cleanupBackups({ git, commonDir, report: say });
        out.log.success("backups and plan removed");
        return 0;
    }

    if (opts.abort) {
        if (!existing) {
            out.log.error("no cascade in progress");
            return 1;
        }

        await abortCascade({ git, commonDir, plan: existing, report: say });
        return 0;
    }

    if (opts.restore) {
        if (!existing) {
            out.log.error("no cascade in progress; restore by hand from the bkp/cascade/* tags");
            return 1;
        }

        await restoreBranch({ run: { git, commonDir, plan: existing, report: say }, branch: opts.restore });
        return 0;
    }

    if (opts.continue) {
        if (!existing) {
            out.log.error("no cascade in progress");
            return 1;
        }

        const result = await continueCascade({ git, commonDir, plan: existing, report: say });
        const code = printResult(result);

        if (result.status === "done") {
            out.println("\npush when the user says push:");
            out.println(
                pushLines(existing)
                    .map((l) => `  ${l}`)
                    .join("\n")
            );
        }

        return code;
    }

    if (!parentArg) {
        out.log.error("Which parent? tools git rebase-cascade <parent> [--onto <target>]");
        return 2;
    }

    if (existing) {
        out.log.error(
            `a cascade is already in progress (phase ${existing.phase}); --continue, --status or --abort first`
        );
        return 1;
    }

    if (!opts.dryRun && !isCleanStatus(await git.status({ cwd }))) {
        out.log.error(`the checkout at ${cwd} has uncommitted changes; commit or stash them first`);
        return 1;
    }

    const loaded = await loadRepoConfig(cwd);

    for (const problem of loaded.problems) {
        out.log.warn(`config ${loaded.path}: ${problem}`);
    }

    const driver = opts.offline ? null : await originDriver(repoRoot);
    const target = await detectBase({
        cwd: repoRoot,
        branch: parentArg,
        flag: opts.onto,
        config: loaded.config,
        driver,
    });
    const worktrees = await listWorktrees(repoRoot);
    const { plan, parentReport } = await buildPlan({
        cwd,
        repoRoot,
        parent: parentArg,
        target,
        childOverride: opts.child.length > 0 ? opts.child : undefined,
        worktrees,
        nowEpoch: Math.floor(Date.now() / 1000),
    });

    out.println(`target: ${describeBase(target)}`);
    out.println(`parent verdict vs target: ${parentReport.verdict} (${parentReport.how})`);
    out.println(planLines(plan).join("\n"));

    const dirtyChildren: string[] = [];

    for (const c of plan.children) {
        if (c.worktree && !isCleanStatus(await git.status({ cwd: c.worktree }))) {
            dirtyChildren.push(`${c.name} in ${c.worktree}`);
        }
    }

    if (plan.parentWorktree && !isCleanStatus(await git.status({ cwd: plan.parentWorktree }))) {
        dirtyChildren.push(`${plan.parent} in ${plan.parentWorktree}`);
    }

    if (opts.dryRun) {
        for (const d of dirtyChildren) {
            out.log.warn(`dirty worktree, a real run would refuse: ${d}`);
        }

        out.log.info(
            "dry run: no branch moved, no backups, no plan file (an oracle preview may have written one unreachable tree object)"
        );
        return 0;
    }

    if (dirtyChildren.length > 0) {
        out.log.error(`dirty worktrees, nothing moved: ${dirtyChildren.join("; ")}`);
        return 1;
    }

    if (target.source === "inferred") {
        out.log.warn(`the target was inferred (${target.detail}); pass --onto to pin it`);
    }

    if (!opts.yes) {
        if (!isInteractive()) {
            out.log.error("Non-interactive: pass --yes to run the plan as printed.");
            out.log.info(
                suggestCommand("tools git rebase-cascade", { subcommand: ["rebase-cascade"], add: ["--yes"] })
            );
            return 2;
        }

        const ok = await p.confirm({ message: "Run this plan? (backups first, no push)", initialValue: false });

        if (p.isCancel(ok) || !ok) {
            out.log.info("Cancelled. Nothing moved.");
            return 1;
        }
    }

    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/T/, "-").slice(0, 13);
    await createBackups({ git, plan, stamp });
    saveState(commonDir, plan);

    for (const [b, backup] of Object.entries(plan.backups)) {
        out.println(`backup: ${b} → ${backup.tag}`);
    }

    const result = await runCascade({ git, commonDir, plan, report: say });
    const code = printResult(result);

    if (result.status === "done") {
        out.println("\npush when the user says push:");
        out.println(
            pushLines(plan)
                .map((l) => `  ${l}`)
                .join("\n")
        );
        out.println(pc.dim("backups stay until: tools git rebase-cascade --cleanup"));
    }

    return code;
}

export function registerRebaseCascadeCommand(parent: Command, _storage: Storage): void {
    parent
        .command("rebase-cascade [parent]")
        .description("Rebase a parent branch onto its target and transplant the children stacked on it")
        .option("--onto <target>", "Target ref (default: the parent's PR target, else config mainPrBranch)")
        .option("--child <branch>", "Explicit child (repeatable) instead of detection", collectRepeatable, [])
        .option("--dry-run", "Print the plan and move nothing")
        .option("--yes", "Skip the single confirmation")
        .option("--offline", "Skip the PR/MR lookup for the target")
        .option("--continue", "Carry on after resolving a conflict")
        .option("--status", "Show the plan in progress and the backups")
        .option("--abort", "Reset every touched branch to its backup and clear the plan")
        .option("--restore <branch>", "Reset one branch to its backup")
        .option("--cleanup", "Delete the backup refs and tags and the plan file")
        .option("-C, --cwd <path>", "Run from this checkout")
        .action(async (parentArg: string | undefined, options: Options) => {
            try {
                process.exitCode = await run(parentArg, options);
            } catch (err) {
                if (err instanceof BaseNotFoundError) {
                    out.log.error(err.message);
                    process.exitCode = 2;
                    return;
                }

                log.error({ error: err }, "rebase-cascade failed");
                out.log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });
}
