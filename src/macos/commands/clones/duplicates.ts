import logger from "@app/logger";
import { collapseDuplicates } from "@app/macos/lib/clones/collapse";
import { expandNodeModules, resolveRoots } from "@app/macos/lib/clones/orchestrator";
import { resolveFormat, resolveRenderer } from "@app/macos/lib/clones/render/index";
import { loadClonesConfig } from "@app/macos/lib/clones/store";
import { Command, Option } from "commander";

const log = logger.child({ component: "clones:duplicates-cmd" });

function collect(value: string, previous: string[]): string[] {
    return [...previous, value];
}

interface DuplicatesOpts {
    format?: string;
    group?: boolean;
    nodeModules?: boolean;
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
        .option("--include <glob>", "Include glob (repeatable)", collect, [])
        .option("--exclude <glob>", "Exclude glob (repeatable, wins over --include)", collect, [])
        .option("--top <N>", "Show only the top N sets (default: unlimited)")
        .option("-v, --verbose", "Verbose logging", false)
        .option("--silent", "Suppress non-essential output", false)
        .action(async (rootsArg: string[], opts: DuplicatesOpts) => {
            const cfg = await loadClonesConfig();
            const roots0 = resolveRoots(rootsArg ?? [], cfg.watchedDirs);
            const roots = opts.nodeModules ? expandNodeModules(roots0) : roots0;
            if (roots.length === 0) {
                log.warn("no roots resolved");
                console.error("No roots to scan.");
                process.exit(2);
            }

            const report = collapseDuplicates({ roots });
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
