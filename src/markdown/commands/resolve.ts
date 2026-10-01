import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { backupAndWrite, runDirectory } from "@app/markdown/lib/backup";
import { logger, out } from "@genesiscz/utils/logger";
import {
    codeLinksToTokens,
    collapseIncludes,
    type IncludeOutcome,
    resolveIncludes,
} from "@genesiscz/utils/markdown/includes";
import type { Command } from "commander";
import pc from "picocolors";

interface ResolveFlags {
    newOnly?: boolean;
    convertLinks?: boolean;
    context?: string;
    dryRun?: boolean;
    cwd?: string;
}

const ACTION_COLOR: Record<IncludeOutcome["action"], (text: string) => string> = {
    added: pc.green,
    refreshed: pc.cyan,
    unchanged: pc.dim,
    kept: pc.dim,
    failed: pc.red,
    skipped: pc.yellow,
};

function count(outcomes: IncludeOutcome[], action: IncludeOutcome["action"]): number {
    return outcomes.filter((outcome) => outcome.action === action).length;
}

async function resolveFile(
    file: string,
    flags: ResolveFlags,
    runDir: () => string
): Promise<"written" | "unchanged" | "refused"> {
    const before = readFileSync(file, "utf8");
    const context = flags.context === undefined ? 12 : Number(flags.context);
    const converted = flags.convertLinks ? codeLinksToTokens(before, { context }) : null;
    const start = converted?.text ?? before;
    const resolved = await resolveIncludes(start, {
        cwd: flags.cwd ? resolve(flags.cwd) : dirname(file),
        refresh: !flags.newOnly,
    });
    const after = resolved.text;

    out.println(pc.bold(file));

    for (const link of converted?.inserted ?? []) {
        out.println(`  ${pc.green("link→token")} line ${link.line} ${link.label} → ${link.range}`);
    }

    for (const skip of converted?.skipped ?? []) {
        out.println(`  ${pc.yellow("link kept")}  line ${skip.line} ${skip.label}: ${skip.reason}`);
    }

    for (const outcome of resolved.outcomes) {
        const reason = outcome.error ? `: ${outcome.error}` : "";
        out.println(
            `  ${ACTION_COLOR[outcome.action](outcome.action.padEnd(10))} line ${outcome.line} ${outcome.raw}${reason}`
        );
    }

    // The only change a run may make is tokens to blocks (and, with --convert-links, token lines added
    // under paragraphs). Collapsing every block back to its token must give the text the run started from.
    if (collapseIncludes(after) !== collapseIncludes(start)) {
        logger.error(
            { file },
            "markdown: the result differs from the input outside the include blocks; nothing written"
        );
        out.log.error(`${file}: the result differs outside the include blocks. Nothing was written.`);
        return "refused";
    }

    if (after === before) {
        out.println(pc.dim("  no change"));
        return "unchanged";
    }

    const record = await backupAndWrite({
        file,
        before,
        after,
        runDir: runDir(),
        dryRun: Boolean(flags.dryRun),
        detail: {
            linksConverted: converted?.inserted.length ?? 0,
            added: count(resolved.outcomes, "added"),
            refreshed: count(resolved.outcomes, "refreshed"),
            unchanged: count(resolved.outcomes, "unchanged"),
            failed: count(resolved.outcomes, "failed"),
            skipped: count(resolved.outcomes, "skipped"),
        },
    });

    out.println(
        `  ${flags.dryRun ? "proposal" : "backup"}  ${flags.dryRun ? record.backup.replace(/$/, ".proposed") : record.backup}`
    );
    out.println(`  patch     ${record.patch}`);

    if (!flags.dryRun) {
        out.println(`  restore   ${record.restore}`);
    }

    return "written";
}

export function registerResolveCommand(program: Command): void {
    program
        .command("resolve")
        .description("Resolve {{kind …}} tokens in markdown files into re-resolvable include blocks")
        .argument("<files...>", "markdown files")
        .option("--new-only", "only resolve bare tokens; leave existing include blocks as they are")
        .option("--convert-links", "first add a {{lines}} token under every link to lines of a source file")
        .option("--context <n>", "lines an excerpt shows from a single-line link (default 12)")
        .option("--cwd <dir>", "resolve relative token paths from here (default: each file's folder)")
        .option("--dry-run", "write the proposal and its patch beside the backup; leave the files alone")
        .action(async (files: string[], flags: ResolveFlags) => {
            let dir: string | null = null;
            const runDir = () => {
                dir ??= runDirectory();
                return dir;
            };
            let refused = 0;

            for (const given of files) {
                const file = resolve(given);

                try {
                    if (!statSync(file).isFile()) {
                        out.log.error(`${given} is not a file.`);
                        refused++;
                        continue;
                    }
                } catch (error) {
                    logger.debug({ err: error, file }, "markdown: stat failed");
                    out.log.error(`${given} does not exist.`);
                    refused++;
                    continue;
                }

                const outcome = await resolveFile(file, flags, runDir);
                refused += outcome === "refused" ? 1 : 0;
            }

            if (dir) {
                out.println("");
                out.println(`${flags.dryRun ? "Proposals" : "Backups"}, patches and manifest.jsonl: ${dir}`);
                out.println(pc.dim("The day log (~/.genesis-tools/logs/) has one line per file with the same paths."));
            }

            if (refused > 0) {
                process.exitCode = 1;
            }
        });
}
