import { basename } from "node:path";
import { logger } from "@app/logger";
import { applyLogLevel } from "@app/macos/commands/clones/log-level";
import { collapseDuplicates } from "@app/macos/lib/clones/collapse";
import { expandNodeModules, resolveRoots } from "@app/macos/lib/clones/orchestrator";
import { resolveFormat, resolveRenderer } from "@app/macos/lib/clones/render/index";
import { loadClonesConfig } from "@app/macos/lib/clones/store";
import { parseVariadic } from "@app/utils/cli";
import { formatBytes } from "@app/utils/format";
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

/** `.git` is the only basename we skip unconditionally — git objects are
 *  content-addressed by SHA-1 (so dedup detection inside `.git` is
 *  structurally pointless), pack files are large unique blobs that don't
 *  share clone families (so the clone-family pre-filter can't skip them),
 *  and the directory is metadata not user content. No opt-out flag — the
 *  cost/benefit is one-sided. `node_modules` is deliberately NOT here: the
 *  clone-family pre-filter makes bun trees free (one syscall per file, no
 *  hashing) AND yarn trees contain real duplicate small files we want to
 *  surface. */
function shouldEnterByDefault(dir: string): boolean {
    return basename(dir) !== ".git";
}

/** Cap on duplicate sets printed in human formats. The clone-family
 *  pre-filter already drops bun-cloned files entirely (zero reclaim), so
 *  the cap mostly bounds many-small-file yarn dupes after folder rollup.
 *  `--top 0` = unlimited; JSON/JSONL always emits the full set. */
const DEFAULT_TOP_HUMAN = 30;

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
        .option(
            "--top <N>",
            `Show only the top N sets in human formats (default: ${DEFAULT_TOP_HUMAN}, 0 = unlimited, JSON always returns all)`
        )
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

            // SIGINT → abort the walk + hash within one 64 KB chunk. Without
            // this, sync readSync on a multi-GB file blocks Ctrl+C until the
            // syscall returns (seconds, sometimes longer).
            const controller = new AbortController();
            const onSigint = (): void => {
                if (!controller.signal.aborted) {
                    log.warn("SIGINT received, aborting scan");
                    controller.abort(new Error("aborted by SIGINT"));
                }
            };
            process.on("SIGINT", onSigint);
            process.on("SIGTERM", onSigint);

            const minSize = opts.minReal ? Number.parseInt(opts.minReal, 10) : undefined;

            try {
                const report = await collapseDuplicates({
                    roots,
                    ...(minSize !== undefined && !Number.isNaN(minSize) && minSize > 0 ? { minSize } : {}),
                    include: parseVariadic(opts.include),
                    exclude: parseVariadic(opts.exclude),
                    signal: controller.signal,
                    shouldEnter: shouldEnterByDefault,
                });
                report.grouped = Boolean(opts.group);

                const fmt = resolveFormat(opts.format);
                const totalSets = report.sets.length;
                const grandTotalReclaimable = report.totalReclaimable;

                // Cap human-format output. JSON/JSONL always returns the full
                // set so machine consumers don't lose data. `--top 0` = unlimited.
                const isHumanFormat = fmt !== "json" && fmt !== "jsonl";
                let capped = false;
                let topN: number | undefined;
                if (opts.top !== undefined) {
                    const n = Number.parseInt(opts.top, 10);
                    if (!Number.isNaN(n) && n > 0) {
                        topN = n;
                    }
                    // n === 0 or NaN → unlimited (no cap).
                } else if (isHumanFormat) {
                    topN = DEFAULT_TOP_HUMAN;
                }

                if (topN !== undefined && totalSets > topN) {
                    report.sets = report.sets.slice(0, topN);
                    report.totalReclaimable = report.sets.reduce((s, x) => s + x.reclaimable, 0);
                    capped = true;
                }

                console.log(resolveRenderer(fmt).duplicates(report));

                if (isHumanFormat && capped) {
                    const hiddenSets = totalSets - report.sets.length;
                    const hiddenBytes = grandTotalReclaimable - report.totalReclaimable;
                    console.log(
                        `\n... ${hiddenSets} more set(s) hidden (≈ ${formatBytes(hiddenBytes)} more reclaimable). Use --top 0 for everything or --format json to dump.`
                    );
                }

                process.exitCode = 0;
            } catch (err) {
                if (controller.signal.aborted) {
                    log.warn({ err }, "scan aborted");
                    console.error("\naborted.");
                    process.exitCode = 130;
                    return;
                }

                throw err;
            } finally {
                process.off("SIGINT", onSigint);
                process.off("SIGTERM", onSigint);
            }
        });

    return cmd;
}
