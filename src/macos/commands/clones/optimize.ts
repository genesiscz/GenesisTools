import { applyLogLevel } from "@app/macos/commands/clones/log-level";
import {
    closestProcessIds,
    IntegrityError,
    listProcesses,
    RollbackSpaceError,
    readProcess,
    rollbackProcess,
    runOptimize,
} from "@app/macos/lib/clones/audit";
import { cachePlan, getCachedPlan, stampRoots, stampsMatch } from "@app/macos/lib/clones/cache";
import { collapseDuplicates } from "@app/macos/lib/clones/collapse";
import { discoverRoots, RepoNotFoundError } from "@app/macos/lib/clones/discover";
import { FileMetaCache } from "@app/macos/lib/clones/file-meta-cache";
import { parseMinReal } from "@app/macos/lib/clones/min-real";
import { expandNodeModules, resolveRoots } from "@app/macos/lib/clones/orchestrator";
import { JsonRenderer, resolveFormat, resolveRenderer } from "@app/macos/lib/clones/render/index";
import type { DuplicateSet, ProcessReport } from "@app/macos/lib/clones/render/types";
import { loadClonesConfig } from "@app/macos/lib/clones/store";
import { TARGET_KIND_VALUES } from "@app/macos/lib/clones/targets";
import * as p from "@clack/prompts";
import { isInteractive, parseVariadic, suggestCommand, suggestEnumFlag } from "@genesiscz/utils/cli";
import { printLn } from "@genesiscz/utils/cli/stdout";
import { formatBytes } from "@genesiscz/utils/format";
import { logger } from "@genesiscz/utils/logger";
import { CloneUnsupportedError } from "@genesiscz/utils/macos/apfs";
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
    dir: string[];
    worktreesOf?: string;
    targets?: string | boolean;
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
        .option("--dir <path>", "Search this directory for install trees (repeatable)", collect, [])
        .option("--worktrees-of <repo>", "Resolve this repo's git worktrees, siblings included")
        .option("--targets [kinds]", `What to scan under --dir: ${TARGET_KIND_VALUES.join(", ")}`)
        .option("--min-real <bytes>", "Minimum real size to consider", "10485760")
        .option("--include <glob>", "Include glob (repeatable)", collect, [])
        .option("--exclude <glob>", "Exclude glob (repeatable, wins over --include)", collect, [])
        .option("-v, --verbose", "Verbose logging", false)
        .option("--silent", "Suppress non-essential output", false)
        .action(async (rootsArg: string[], opts: OptimizeOpts) => {
            applyLogLevel(opts);
            if (opts.list) {
                await printLn(resolveRenderer(resolveFormat(opts.format)).processList(listProcesses()));
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
                    await printLn(new JsonRenderer().processReportJsonl(rep));
                } else {
                    await printLn(resolveRenderer(fmt).processReport(rep));
                }

                process.exitCode = 0;
                return;
            }

            if (opts.rollback) {
                if (!opts.process) {
                    console.error("optimize --rollback requires --process <id>.");
                    process.exit(1);
                }

                const existing = readProcess(opts.process);
                if (!existing) {
                    console.error(`Unknown process "${opts.process}".`);
                    const near = closestProcessIds(opts.process);
                    if (near.length > 0) {
                        console.error(`Closest: ${near.join(", ")}`);
                    }

                    process.exit(1);
                }

                if (isInteractive()) {
                    p.intro(pc.bgCyan(pc.black(" clones optimize --rollback ")));
                    p.log.warn(
                        `Will re-allocate shared bytes for ${existing.totals.cloned} clone(s) in ${opts.process}.`
                    );
                    const token = await p.text({
                        message: 'Type "rollback" to proceed',
                        validate: (v) => (v === "rollback" ? undefined : 'Type exactly "rollback" or Ctrl-C'),
                    });

                    if (p.isCancel(token) || token !== "rollback") {
                        p.cancel("Aborted — nothing was changed.");
                        process.exit(0);
                    }
                } else if (!opts.yes) {
                    console.error("optimize --rollback requires confirmation. In non-interactive mode pass --yes.");
                    console.error(
                        suggestCommand("tools macos clones optimize", {
                            add: ["--rollback", "--process", opts.process, "--yes"],
                            subcommand: ["macos", "clones", "optimize"],
                        })
                    );
                    process.exit(1);
                }

                try {
                    const rolled = rollbackProcess(opts.process);
                    await printLn(resolveRenderer(resolveFormat(opts.format)).processReport(rolled));
                    process.exitCode = rolled.totals.errors > 0 ? 1 : 0;
                } catch (err) {
                    if (err instanceof RollbackSpaceError) {
                        console.error(
                            `Cannot rollback: needs ~${err.required} bytes (×1.1), only ${err.available} available.`
                        );
                        process.exit(1);
                    }

                    throw err;
                }

                return;
            }

            const cfg = await loadClonesConfig();
            const include = parseVariadic(opts.include);
            let roots: string[];
            let targets: string[] = [];
            if (opts.dir.length > 0) {
                // `--include node_modules` filters FILE relpaths inside a root
                // that IS node_modules, so it would drop nearly everything.
                const kindInInclude = include.find((g) => (TARGET_KIND_VALUES as readonly string[]).includes(g));
                if (kindInInclude !== undefined) {
                    console.error(
                        `--include ${kindInInclude} filters FILE paths; to pick which trees to scan under --dir use --targets.`
                    );
                    console.error(
                        suggestCommand("tools macos clones", {
                            remove: ["--include"],
                            add: ["--targets", kindInInclude],
                            subcommand: ["macos", "clones", "optimize"],
                        })
                    );
                    process.exit(1);
                }

                if (opts.targets === true) {
                    console.error(
                        suggestEnumFlag("tools macos clones", "--targets", TARGET_KIND_VALUES, {
                            subcommand: ["macos", "clones", "optimize"],
                        })
                    );
                    process.exit(1);
                }

                targets = typeof opts.targets === "string" ? parseVariadic(opts.targets) : ["gitignored"];
                try {
                    const discovered = await discoverRoots({
                        dirs: opts.dir,
                        targets,
                        ...(opts.worktreesOf !== undefined ? { worktreesOf: opts.worktreesOf } : {}),
                    });
                    roots = discovered.roots;
                    for (const s of discovered.skipped) {
                        log.info({ path: s.path, reason: s.reason }, "root skipped");
                    }
                } catch (err) {
                    if (err instanceof RepoNotFoundError) {
                        console.error(err.message);
                        if (err.candidates.length > 0) {
                            console.error(`Repositories found: ${err.candidates.join(", ")}`);
                        }

                        process.exit(1);
                    }

                    throw err;
                }
            } else {
                const roots0 = resolveRoots(rootsArg ?? [], cfg.watchedDirs);
                roots = opts.nodeModules ? expandNodeModules(roots0) : roots0;
            }

            if (roots.length === 0) {
                log.warn("no roots resolved");
                console.error("No roots to optimize.");
                process.exit(2);
            }

            const minReal = parseMinReal(opts.minReal);
            if (minReal === null) {
                console.error(`--min-real must be a positive whole number of bytes, got "${opts.minReal}".`);
                process.exitCode = 1;
                return;
            }

            const cacheParams = {
                roots,
                minSize: minReal,
                include,
                exclude: parseVariadic(opts.exclude),
                nodeModules: Boolean(opts.nodeModules),
                targets,
                worktreesOf: opts.worktreesOf ?? "",
                keepPartners: [],
            };

            // SIGINT/SIGTERM → abort scan within ~one 64 KB chunk. Mirrors
            // duplicates.ts so optimize's dry-run + --apply scan phases are
            // also interruptible. Without this the user can wait many seconds
            // for sync readSync to return on a large file.
            const controller = new AbortController();
            const onSigint = (): void => {
                if (!controller.signal.aborted) {
                    log.warn("SIGINT received, aborting optimize");
                    controller.abort(new Error("aborted by SIGINT"));
                }
            };
            process.on("SIGINT", onSigint);
            process.on("SIGTERM", onSigint);

            // Share the per-file metadata cache singleton with the duplicates
            // command. The cache only speeds up detection; runOptimize's
            // dedupeFile still byte-verifies before each clonefile (Safety
            // Contract invariant 1) so a stale cache row can't cause an
            // incorrect dedupe — at worst one extra streaming byte-compare.
            const fileCache = FileMetaCache.getInstance();
            const scanStartedAt = Date.now();
            // Taken before the scan so a root that changes mid-scan can never
            // match the stamp stored with the plan.
            const rootStamps = stampRoots(roots);

            try {
                for (const root of roots) {
                    await fileCache.loadScope(root);
                    await fileCache.loadDirScope(root);
                }
                log.info(
                    { scanStartedAt, roots, fileCacheSize: fileCache.size(), dirCacheSize: fileCache.dirSize() },
                    "optimize starting with FileMetaCache attached"
                );

                if (opts.apply) {
                    const stored = opts.cache === false ? null : await getCachedPlan(cacheParams);
                    const cached = stored !== null && stampsMatch(stored.rootStamps, rootStamps) ? stored : null;
                    if (stored !== null && cached === null) {
                        log.info({ roots: roots.length, ageMs: stored.ageMs }, "plan cache stale — rescanning");
                    }

                    const sets =
                        cached?.plan ??
                        (
                            await collapseDuplicates({
                                roots,
                                minSize: cacheParams.minSize,
                                include: cacheParams.include,
                                exclude: cacheParams.exclude,
                                cache: fileCache,
                                signal: controller.signal,
                            })
                        ).sets;
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
                        await printLn(resolveRenderer(resolveFormat(opts.format)).processReport(rep));
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

                const sets = (
                    await collapseDuplicates({
                        roots,
                        minSize: cacheParams.minSize,
                        include: cacheParams.include,
                        exclude: cacheParams.exclude,
                        cache: fileCache,
                        signal: controller.signal,
                    })
                ).sets;
                await cachePlan(cacheParams, sets, rootStamps);
                await printLn(resolveRenderer(resolveFormat(opts.format)).processReport(dryRunReport(roots, sets)));
                process.exitCode = 0;
            } catch (err) {
                if (controller.signal.aborted) {
                    log.warn({ err }, "optimize aborted");
                    process.exitCode = 130;
                    return;
                }

                throw err;
            } finally {
                // Flush + prune-per-root + close the cache regardless of
                // success path so subsequent scans see this run's writes
                // and the WAL is released.
                try {
                    await fileCache.flush(scanStartedAt);
                    await fileCache.flushDir(scanStartedAt);
                    for (const root of roots) {
                        await fileCache.pruneScope(root, scanStartedAt);
                        await fileCache.pruneDirScope(root, scanStartedAt);
                    }
                } finally {
                    fileCache.close();
                }
                process.off("SIGINT", onSigint);
                process.off("SIGTERM", onSigint);
            }
        });

    return cmd;
}
