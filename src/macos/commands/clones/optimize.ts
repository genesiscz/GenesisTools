import logger from "@app/logger";
import { cachePlan } from "@app/macos/lib/clones/cache";
import { collapseDuplicates } from "@app/macos/lib/clones/collapse";
import { expandNodeModules, resolveRoots } from "@app/macos/lib/clones/orchestrator";
import { resolveFormat, resolveRenderer } from "@app/macos/lib/clones/render/index";
import type { DuplicateSet, ProcessReport } from "@app/macos/lib/clones/render/types";
import { parseVariadic } from "@app/utils/cli";
import { Command, Option } from "commander";

const log = logger.child({ component: "clones:optimize-cmd" });

function collect(value: string, previous: string[]): string[] {
    return [...previous, value];
}

export interface OptimizeOpts {
    format?: string;
    apply?: boolean;
    rollback?: boolean;
    list?: boolean;
    log?: boolean;
    process?: string;
    cache: boolean;
    yes?: boolean;
    nodeModules?: boolean;
    minReal: string;
    include: string[];
    exclude: string[];
    verbose?: boolean;
    silent?: boolean;
}

export function dryRunReport(roots: string[], sets: DuplicateSet[]): ProcessReport {
    const now = new Date().toISOString();
    const projected = sets.reduce((s, x) => s + x.reclaimable, 0);
    return {
        id: `${now.replace(/[:.]/g, "-")}.${process.pid}`,
        state: "dry-run",
        roots,
        startedAt: now,
        endedAt: now,
        planCache: { hit: false },
        ops: [],
        totals: { cloned: 0, skipped: 0, errors: 0, bytesReclaimed: projected },
    };
}

export function createOptimizeCommand(): Command {
    const cmd = new Command("optimize")
        .description("Dry-run by default; --apply to clone duplicates (audited, reversible)")
        .argument("[roots...]", "Roots to optimize (default: configured watchedDirs, else cwd)")
        .addOption(
            new Option("--format <format>", "Output format")
                .choices(["auto", "table", "json", "jsonl"])
                .default("auto"),
        )
        .option("--apply", "Actually convert duplicates into clones (requires confirm)", false)
        .option("--rollback", "Un-share a previous process's clones (requires --process)", false)
        .option("--list", "List recorded optimize runs", false)
        .option("--log", "Replay a process's JSONL audit log (requires --process)", false)
        .option("--process <id>", "Target process id for --log / --rollback")
        .option("--no-cache", "Ignore the 1h plan cache; force a fresh scan")
        .option("--yes", "Non-interactive confirm (required for --apply/--rollback in non-TTY)", false)
        .option("--node-modules", "Expand each root to its node_modules dirs", false)
        .option("--min-real <bytes>", "Minimum real size to consider", "10485760")
        .option("--include <glob>", "Include glob (repeatable)", collect, [])
        .option("--exclude <glob>", "Exclude glob (repeatable, wins over --include)", collect, [])
        .option("-v, --verbose", "Verbose logging", false)
        .option("--silent", "Suppress non-essential output", false)
        .action(async (rootsArg: string[], opts: OptimizeOpts) => {
            if (opts.list || opts.log || opts.rollback || opts.apply) {
                throw new Error("optimize: --apply/--rollback/--list/--log are wired in later tasks (12–16)");
            }

            const roots0 = resolveRoots(rootsArg ?? [], []);
            const roots = opts.nodeModules ? expandNodeModules(roots0) : roots0;
            if (roots.length === 0) {
                log.warn("no roots resolved");
                console.error("No roots to optimize.");
                process.exit(2);
            }

            const sets = collapseDuplicates({ roots }).sets;
            await cachePlan(
                {
                    roots,
                    minSize: Number.parseInt(opts.minReal, 10) || 10485760,
                    include: parseVariadic(opts.include),
                    exclude: parseVariadic(opts.exclude),
                    nodeModules: Boolean(opts.nodeModules),
                },
                sets,
            );

            const report = dryRunReport(roots, sets);
            const fmt = resolveFormat(opts.format);
            console.log(resolveRenderer(fmt).processReport(report));
            process.exitCode = 0;
        });

    return cmd;
}
