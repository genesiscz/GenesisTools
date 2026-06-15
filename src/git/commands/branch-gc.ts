/**
 * Branch GC Command
 *
 * Clean up stale & merged local branches (squash-aware): classify each local
 * branch (merged / squash-merged / gone / stale / active) and optionally delete
 * the safe ones.
 */

import {
    BaseNotFoundError,
    type BranchInfo,
    type BranchStatus,
    classifyBranches,
    detectBase,
    getCurrentBranch,
} from "@app/git/lib/branch-gc/classify";
import { logger, out } from "@app/logger";
import { isInteractive, suggestCommand } from "@app/utils/cli";
import { createGit } from "@app/utils/git";
import type { Storage } from "@app/utils/storage";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";

const log = logger.scoped("branch-gc").log;

interface Options {
    base?: string;
    staleDays: string;
    dryRun?: boolean;
    yes?: boolean;
    json?: boolean;
    cwd?: string;
}

const STATUS_COLOR: Record<BranchStatus, (s: string) => string> = {
    merged: pc.green,
    "squash-merged": pc.green,
    gone: pc.yellow,
    stale: pc.magenta,
    active: pc.cyan,
    base: pc.dim,
    current: pc.bold,
};

function formatAge(info: BranchInfo): string {
    if (info.lastCommitEpoch === 0) {
        return "—";
    }

    if (info.ageDays >= 1) {
        return `${info.ageDays}d ago`;
    }

    return "today";
}

function renderTable(branches: BranchInfo[]): string {
    const nameWidth = Math.max(6, ...branches.map((b) => b.name.length));
    const statusWidth = Math.max(6, ...branches.map((b) => b.status.length));

    return branches
        .map((b) => {
            const marker = b.status === "current" ? "*" : " ";
            const name = b.name.padEnd(nameWidth);
            const status = STATUS_COLOR[b.status](b.status.padEnd(statusWidth));
            if (b.status === "base" || b.status === "current") {
                return `${marker} ${name}  ${status}`;
            }

            const counts = `ahead ${String(b.ahead).padStart(2)}  behind ${String(b.behind).padStart(3)}`;
            return `${marker} ${name}  ${status}  ${counts}  ${formatAge(b)}`;
        })
        .join("\n");
}

async function deleteBranch(cwd: string, name: string): Promise<boolean> {
    const { executor } = createGit({ cwd });

    const shaRes = await executor.exec(["rev-parse", "--short", name]);
    const sha = shaRes.stdout;

    const res = await executor.exec(["branch", "-D", name]);
    if (res.success) {
        log.out.log.success(`Deleted ${pc.bold(name)} ${pc.dim(`(restore: git branch ${name} ${sha})`)}`);
        return true;
    }

    log.out.error(`Failed to delete ${name}: ${res.stderr || "unknown git error"}`);
    return false;
}

async function deleteMany(cwd: string, names: string[]): Promise<number> {
    let deleted = 0;
    for (const name of names) {
        if (await deleteBranch(cwd, name)) {
            deleted++;
        }
    }

    return deleted;
}

async function runBranchGc(opts: Options): Promise<void> {
    const cwd = opts.cwd ?? process.cwd();

    const staleDays = Number.parseInt(opts.staleDays, 10);
    if (Number.isNaN(staleDays) || staleDays < 0) {
        out.error(`Invalid --stale-days: ${opts.staleDays}`);
        process.exit(1);
    }

    const { executor } = createGit({ cwd });
    const insideWorkTree = await executor.exec(["rev-parse", "--is-inside-work-tree"]);
    if (!insideWorkTree.success) {
        out.error(`Not a git repository: ${cwd}`);
        out.log.info("Run inside a git repo, or pass -C <path>.");
        process.exit(1);
    }

    let base: string;
    try {
        base = await detectBase(cwd, opts.base);
    } catch (err) {
        if (err instanceof BaseNotFoundError) {
            out.error(err.message);
            process.exit(1);
        }

        throw err;
    }

    const current = await getCurrentBranch(cwd);
    const nowEpoch = Math.floor(Date.now() / 1000);

    const branches = await classifyBranches({ cwd, base, current, nowEpoch, staleDays });
    log.info({ count: branches.length, base, current, staleDays }, "classified branches");

    if (opts.json) {
        out.result(branches);
        return;
    }

    if (branches.length === 0) {
        out.log.info("No local branches found.");
        return;
    }

    out.log.message(`base = ${pc.cyan(base)}, ${branches.length} local branch(es)`);
    out.println(renderTable(branches));

    const safe = branches.filter((b) => b.deletable);
    const stale = branches.filter((b) => b.status === "stale");

    out.log.message(`${safe.length} branch(es) safe to delete (merged + squash-merged + gone).`);

    if (opts.yes) {
        if (safe.length === 0) {
            out.log.info("Nothing to delete.");
            return;
        }

        const deleted = await deleteMany(
            cwd,
            safe.map((b) => b.name)
        );
        out.log.success(`Deleted ${deleted}/${safe.length} branch(es).`);
        return;
    }

    if (opts.dryRun || !isInteractive()) {
        if (safe.length > 0) {
            out.log.info(`Run ${pc.bold(suggestCommand("tools git branch-gc", { add: ["--yes"] }))} to delete them.`);
        }

        return;
    }

    if (safe.length === 0 && stale.length === 0) {
        out.log.info("Nothing to clean up.");
        return;
    }

    const selectable = [...safe, ...stale];
    const choice = await p.multiselect({
        message: "Select branches to delete",
        options: selectable.map((b) => ({
            value: b.name,
            label: `${b.name} ${pc.dim(`(${b.status})`)}`,
            hint: b.status === "stale" ? `${b.ageDays}d old — review before deleting` : undefined,
        })),
        initialValues: safe.map((b) => b.name),
        required: false,
    });

    if (p.isCancel(choice)) {
        out.log.info("Cancelled. No branches deleted.");
        return;
    }

    if (choice.length === 0) {
        out.log.info("No branches selected.");
        return;
    }

    const deleted = await deleteMany(cwd, choice);
    out.log.success(`Deleted ${deleted}/${choice.length} branch(es).`);
}

export function registerBranchGcCommand(parent: Command, _storage: Storage): void {
    parent
        .command("branch-gc")
        .description("Clean up stale & merged local branches (squash-aware)")
        .option("-b, --base <branch>", "Branch to measure 'merged into' against (auto-detect master/main)")
        .option("-d, --stale-days <n>", "Branches with no commit newer than this many days are stale", "90")
        .option("--no-dry-run", "Opt into interactive deletion in a TTY (default: list only)")
        .option("--yes", "Non-interactive: delete every merged + squash-merged + gone branch")
        .option("--json", "Emit the classification array as JSON to stdout (implies no deletion)")
        .option("-C, --cwd <path>", "Run against the git repo at this path")
        .action(async (options: Options) => {
            try {
                await runBranchGc(options);
            } catch (err) {
                log.error({ error: err }, "branch-gc failed");
                out.error(err instanceof Error ? err.message : String(err));
                process.exit(1);
            }
        });
}
