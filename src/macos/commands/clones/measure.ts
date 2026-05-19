import { resolve } from "node:path";
import logger from "@app/logger";
import { buildMeasureReport, expandNodeModules, resolveRoots } from "@app/macos/lib/clones/orchestrator";
import { resolveFormat, resolveRenderer } from "@app/macos/lib/clones/render/index";
import { loadClonesConfig } from "@app/macos/lib/clones/store";
import { parseVariadic } from "@app/utils/cli";
import { Command, Option } from "commander";

const log = logger.child({ component: "clones:measure-cmd" });

function collect(value: string, previous: string[]): string[] {
    return [...previous, value];
}

interface MeasureOpts {
    format?: string;
    nodeModules?: boolean;
    minReal: string;
    top?: string;
    breakdown: boolean;
    include: string[];
    exclude: string[];
    sort?: string;
    verbose?: boolean;
    silent?: boolean;
}

export function applySharedMeasureFlags(cmd: Command): Command {
    return cmd
        .addOption(
            new Option("--format <format>", "Output format").choices(["auto", "table", "json", "jsonl"]).default("auto")
        )
        .option("--node-modules", "Expand each root to its node_modules dirs", false)
        .option("--min-real <bytes>", "Hide subtrees whose real size is below this", "10485760")
        .option("--top <N>", "Show only the top N rows (default: unlimited)")
        .option("--no-breakdown", "Totals + clone analysis only (no per-dir tree)")
        .option("--include <glob>", "Include glob (repeatable)", collect, [])
        .option("--exclude <glob>", "Exclude glob (repeatable, wins over --include)", collect, [])
        .option("-v, --verbose", "Verbose logging", false)
        .option("--silent", "Suppress non-essential output", false);
}

export function createMeasureCommand(): Command {
    const cmd = new Command("measure")
        .description("Clone-aware sizes for one or more roots (breakdown by default)")
        .argument("[roots...]", "Roots to measure (default: configured watchedDirs, else cwd)");
    applySharedMeasureFlags(cmd).addOption(
        new Option("--sort <by>", "Sort rows").choices(["overcount", "real", "du"]).default("overcount")
    );
    cmd.action(async (rootsArg: string[], opts: MeasureOpts) => {
        const minReal = Number.parseInt(opts.minReal, 10);
        const cfg = await loadClonesConfig();
        const roots0 = resolveRoots(rootsArg ?? [], cfg.watchedDirs);
        const roots = opts.nodeModules ? expandNodeModules(roots0) : roots0;
        if (roots.length === 0) {
            log.warn("no roots resolved");
            console.error("No roots to measure.");
            process.exit(2);
        }

        const report = buildMeasureReport({
            roots,
            minReal: Number.isNaN(minReal) ? 10485760 : minReal,
            breakdown: opts.breakdown,
            include: parseVariadic(opts.include),
            exclude: parseVariadic(opts.exclude),
            sort: (opts.sort as "overcount" | "real" | "du") ?? "overcount",
        });
        report.nodeModulesMode = Boolean(opts.nodeModules);

        if (opts.top) {
            const n = Number.parseInt(opts.top, 10);
            if (!Number.isNaN(n) && n > 0) {
                report.tree = report.tree.slice(0, n);
            }
        }

        const fmt = resolveFormat(opts.format);
        console.log(resolveRenderer(fmt).measure(report));

        const wholeRootUnreadable = report.errors.length > 0 && report.totals.logical === 0;
        process.exitCode = wholeRootUnreadable ? 2 : 0;
    });

    return cmd;
}

interface DuOpts extends MeasureOpts {
    depth?: string;
}

export function createDuCommand(): Command {
    const cmd = new Command("du")
        .description("Clone-aware du: measure one folder deeply, depth-limited")
        .argument("[folder]", "Folder to measure (default: cwd)");
    applySharedMeasureFlags(cmd)
        .addOption(new Option("--sort <by>", "Sort rows").choices(["overcount", "real", "du"]).default("overcount"))
        .option("--depth <N>", "Max tree depth below the folder (default: unlimited)");
    cmd.action(async (folderArg: string | undefined, opts: DuOpts) => {
        const folder = resolve(folderArg ?? process.cwd());
        const minReal = Number.parseInt(opts.minReal, 10);
        const depth = opts.depth ? Number.parseInt(opts.depth, 10) : undefined;

        const report = buildMeasureReport({
            roots: [folder],
            minReal: Number.isNaN(minReal) ? 10485760 : minReal,
            breakdown: opts.breakdown,
            include: parseVariadic(opts.include),
            exclude: parseVariadic(opts.exclude),
            sort: (opts.sort as "overcount" | "real" | "du") ?? "overcount",
            maxDepth: depth !== undefined && !Number.isNaN(depth) ? depth : undefined,
        });

        if (opts.top) {
            const n = Number.parseInt(opts.top, 10);
            if (!Number.isNaN(n) && n > 0) {
                report.tree = report.tree.slice(0, n);
            }
        }

        const fmt = resolveFormat(opts.format);
        console.log(resolveRenderer(fmt).measure(report));
        process.exitCode = report.errors.length > 0 && report.totals.logical === 0 ? 2 : 0;
    });

    return cmd;
}
