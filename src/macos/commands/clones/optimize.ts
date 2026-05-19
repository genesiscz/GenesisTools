import logger from "@app/logger";
import {
    closestProcessIds,
    IntegrityError,
    listProcesses,
    readProcess,
    runOptimize,
} from "@app/macos/lib/clones/audit";
import { cachePlan, getCachedPlan } from "@app/macos/lib/clones/cache";
import { collapseDuplicates } from "@app/macos/lib/clones/collapse";
import { expandNodeModules, resolveRoots } from "@app/macos/lib/clones/orchestrator";
import { JsonRenderer, resolveFormat, resolveRenderer } from "@app/macos/lib/clones/render/index";
import type { DuplicateSet, ProcessReport } from "@app/macos/lib/clones/render/types";
import { isInteractive, parseVariadic, suggestCommand } from "@app/utils/cli";
import { formatBytes } from "@app/utils/format";
import { CloneUnsupportedError } from "@app/utils/macos/apfs";
import * as p from "@clack/prompts";
import { Command, Option } from "commander";
import pc from "picocolors";

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
            new Option("--format <format>", "Output format").choices(["auto", "table", "json", "jsonl"]).default("auto")
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
            if (opts.rollback) {
                throw new Error("optimize: --rollback is wired in Task 16");
            }

            if (opts.list) {
                console.log(resolveRenderer(resolveFormat(opts.format)).processList(listProcesses()));
                process.exitCode = 0;
                return;
            }

            if (opts.log) {
                if (!opts.process) {
                    console.error("optimize --log requires --process <id>.");
                    process.exit(1);
                }

                const rep = readProcess(opts.process);
                if (!rep) {
                    console.error(`Unknown process "${opts.process}".`);
                    const near = closestProcessIds(opts.process);
                    if (near.length > 0) {
                        console.error(`Closest: ${near.join(", ")}`);
                    }

                    process.exit(1);
                }

                const fmt = resolveFormat(opts.format);
                if (fmt === "jsonl") {
                    console.log(new JsonRenderer().processReportJsonl(rep));
                } else {
                    console.log(resolveRenderer(fmt).processReport(rep));
                }

                process.exitCode = 0;
                return;
            }

            const roots0 = resolveRoots(rootsArg ?? [], []);
            const roots = opts.nodeModules ? expandNodeModules(roots0) : roots0;
            if (roots.length === 0) {
                log.warn("no roots resolved");
                console.error("No roots to optimize.");
                process.exit(2);
            }

            const cacheParams = {
                roots,
                minSize: Number.parseInt(opts.minReal, 10) || 10485760,
                include: parseVariadic(opts.include),
                exclude: parseVariadic(opts.exclude),
                nodeModules: Boolean(opts.nodeModules),
            };

            if (opts.apply) {
                const cached = opts.cache === false ? null : await getCachedPlan(cacheParams);
                const sets = cached?.plan ?? collapseDuplicates({ roots }).sets;
                const projected = sets.reduce((s, x) => s + x.reclaimable, 0);

                if (isInteractive()) {
                    p.intro(pc.bgCyan(pc.black(" clones optimize --apply ")));
                    p.log.info(
                        `${sets.length} set(s) → clones · reclaim ${formatBytes(projected)} · ` +
                            "rewrites in place, content-verified"
                    );
                    const token = await p.text({
                        message: 'Type "apply" to proceed',
                        validate: (v) => (v === "apply" ? undefined : 'Type exactly "apply" or Ctrl-C'),
                    });

                    if (p.isCancel(token) || token !== "apply") {
                        p.cancel("Aborted — nothing was changed.");
                        process.exit(0);
                    }
                } else if (!opts.yes) {
                    console.error("optimize --apply requires confirmation. In non-interactive mode pass --yes.");
                    console.error(
                        suggestCommand("tools macos clones optimize", {
                            add: ["--apply", "--yes"],
                            subcommand: ["macos", "clones", "optimize"],
                        })
                    );
                    process.exit(1);
                }

                try {
                    const rep = runOptimize({
                        roots,
                        sets,
                        planCacheHit: Boolean(cached),
                        ...(cached ? { planCacheAgeMs: cached.ageMs } : {}),
                    });
                    rep.planCache = { hit: Boolean(cached), ...(cached ? { ageMs: cached.ageMs } : {}) };
                    console.log(resolveRenderer(resolveFormat(opts.format)).processReport(rep));
                    process.exitCode = rep.totals.errors > 0 ? 1 : 0;
                } catch (err) {
                    if (err instanceof IntegrityError) {
                        console.error(`INTEGRITY ABORT: ${err.message}`);
                        process.exit(1);
                    }

                    if (err instanceof CloneUnsupportedError) {
                        console.error(`Cannot --apply: ${err.message}`);
                        process.exit(1);
                    }

                    throw err;
                }

                return;
            }

            const sets = collapseDuplicates({ roots }).sets;
            await cachePlan(cacheParams, sets);
            console.log(resolveRenderer(resolveFormat(opts.format)).processReport(dryRunReport(roots, sets)));
            process.exitCode = 0;
        });

    return cmd;
}
