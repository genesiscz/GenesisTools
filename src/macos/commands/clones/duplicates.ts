import logger from "@app/logger";
import { applyLogLevel } from "@app/macos/commands/clones/log-level";
import { collapseDuplicates } from "@app/macos/lib/clones/collapse";
import { expandNodeModules, resolveRoots } from "@app/macos/lib/clones/orchestrator";
import { resolveFormat, resolveRenderer } from "@app/macos/lib/clones/render/index";
import { loadClonesConfig } from "@app/macos/lib/clones/store";
import { parseVariadic } from "@app/utils/cli";
import { Command, Option } from "commander";

const log = logger.child({ component: "clones:duplicates-cmd" });

function collect(value: string, previous: string[]): string[] {
    return [...previous, value];
}

interface DuplicatesOpts {
    format?: string;
    group?: boolean;
    nodeModules?: boolean;
    minReal?: string;
    include: string[];
    exclude: string[];
    top?: string;
    verbose?: boolean;
    silent?: boolean;
}

export function createDuplicatesCommand(): Command {
    const cmd = new Command("duplicates")
        .description("Content-identical files/dirs that are NOT yet clones (folder-collapsed)")
        .argument("[roots...]", "Roots to scan (default: configured watchedDirs, else cwd)")
        .addOption(
            new Option("--format <format>", "Output format").choices(["auto", "table", "json", "jsonl"]).default("auto")
        )
        .option("--group", "List every member path under each set", false)
        .option("--node-modules", "Expand each root to its node_modules dirs", false)
        .option("--min-real <bytes>", "Ignore duplicate sets smaller than this (per-file size)")
        .option("--include <glob>", "Include glob (repeatable; matches relpath or any segment)", collect, [])
        .option("--exclude <glob>", "Exclude glob (repeatable, wins over --include)", collect, [])
        .option("--top <N>", "Show only the top N sets (default: unlimited)")
        .option("-v, --verbose", "Verbose logging", false)
        .option("--silent", "Suppress non-essential output", false)
        .action(async (rootsArg: string[], opts: DuplicatesOpts) => {
            applyLogLevel(opts);
            const cfg = await loadClonesConfig();
            const roots0 = resolveRoots(rootsArg ?? [], cfg.watchedDirs);
            const roots = opts.nodeModules ? expandNodeModules(roots0) : roots0;
            if (roots.length === 0) {
                log.warn("no roots resolved");
                console.error("No roots to scan.");
                process.exit(2);
            }

            const minSize = opts.minReal ? Number.parseInt(opts.minReal, 10) : undefined;
            const report = collapseDuplicates({
                roots,
                ...(minSize !== undefined && !Number.isNaN(minSize) ? { minSize } : {}),
                include: parseVariadic(opts.include),
                exclude: parseVariadic(opts.exclude),
            });
            report.grouped = Boolean(opts.group);

            if (opts.top) {
                const n = Number.parseInt(opts.top, 10);
                if (!Number.isNaN(n) && n > 0) {
                    report.sets = report.sets.slice(0, n);
                    report.totalReclaimable = report.sets.reduce((s, x) => s + x.reclaimable, 0);
                }
            }

            const fmt = resolveFormat(opts.format);
            console.log(resolveRenderer(fmt).duplicates(report));
            process.exitCode = 0;
        });

    return cmd;
}
