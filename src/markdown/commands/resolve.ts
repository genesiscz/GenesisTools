import { statSync } from "node:fs";
import { resolve } from "node:path";
import { runDirectory } from "@app/markdown/lib/backup";
import { type ResolveFileResult, resolveMarkdownFile } from "@app/markdown/lib/resolve";
import { logger, out } from "@genesiscz/utils/logger";
import type { IncludeOutcome } from "@genesiscz/utils/markdown/includes";
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

async function resolveFile(
    file: string,
    flags: ResolveFlags,
    context: number,
    runDir: () => string
): Promise<ResolveFileResult["status"]> {
    const result = await resolveMarkdownFile({
        file,
        cwd: flags.cwd,
        newOnly: flags.newOnly,
        convertLinks: flags.convertLinks,
        context,
        dryRun: Boolean(flags.dryRun),
        runDir,
    });
    const { converted, record } = result;

    out.println(pc.bold(file));

    for (const link of converted?.inserted ?? []) {
        out.println(`  ${pc.green("link→token")} line ${link.line} ${link.label} → ${link.range}`);
    }

    for (const skip of converted?.skipped ?? []) {
        out.println(`  ${pc.yellow("link kept")}  line ${skip.line} ${skip.label}: ${skip.reason}`);
    }

    for (const outcome of result.outcomes) {
        const reason = outcome.error ? `: ${outcome.error}` : "";
        out.println(
            `  ${ACTION_COLOR[outcome.action](outcome.action.padEnd(10))} line ${outcome.line} ${outcome.raw}${reason}`
        );
    }

    if (result.status === "refused") {
        out.log.error(`${file}: ${result.reason ?? "refused"}. Nothing was written.`);
        return "refused";
    }

    if (!record) {
        out.println(pc.dim("  no change"));
        return "unchanged";
    }

    out.println(`  ${record.proposal ? `proposal  ${record.proposal}` : `backup    ${record.backup}`}`);
    out.println(`  patch     ${record.patch}`);

    if (!record.dryRun) {
        out.println(`  restore   ${record.restore}`);
    }

    return "written";
}

/** `--context`: a positive whole number of lines, 12 when not given; null when the value is not one. */
function contextLines(value: string | undefined): number | null {
    if (value === undefined) {
        return 12;
    }

    const lines = Number(value);
    return Number.isInteger(lines) && lines > 0 ? lines : null;
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
            const context = contextLines(flags.context);
            if (context === null) {
                out.log.error(`--context takes a positive whole number of lines, got '${flags.context}'.`);
                process.exitCode = 1;
                return;
            }

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

                const outcome = await resolveFile(file, flags, context, runDir);
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
