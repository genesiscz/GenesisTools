import { resolve } from "node:path";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { type BlameDeps, blameFiles, realBlameDeps } from "../lib/changes/blame";

const { log } = logger.scoped("agents-blame");

interface BlameOptions {
    repo: string;
    files: string[];
    since?: string;
    json?: boolean;
}

export function registerBlameCommand(program: Command, deps: BlameDeps = realBlameDeps): void {
    program
        .command("blame")
        .description(
            "Which agent session and turn last wrote each line of these files, from the agents change logs; read-only"
        )
        .requiredOption("--files <paths...>", "paths relative to --repo, one argument each (a path may hold a comma)")
        .option("--repo <path>", "the checkout the paths are in (its other worktrees count too)", ".")
        .option("--since <iso>", "only change-log rows from this time on (default: 30 days ago)")
        .option("--json", "machine-readable output")
        .action(async (options: BlameOptions) => {
            const since = options.since ? new Date(options.since) : undefined;

            if (since && Number.isNaN(since.getTime())) {
                out.log.error(`--since is not a date: ${options.since}`);
                process.exitCode = 1;
                return;
            }

            const files = options.files.filter((file) => file.length > 0);
            const result = await blameFiles({ repo: resolve(options.repo), files, since }, deps);
            log.debug({ files: files.length, elapsedMs: result.elapsedMs }, "blame done");

            if (options.json) {
                out.result(result);
                return;
            }

            for (const file of result.files) {
                out.println(file.path);

                for (const [start, end, index] of file.ranges) {
                    const source = result.sources[index];
                    out.println(
                        `  ${start === end ? `${start}` : `${start}-${end}`}  ${source.provider} ${source.session.slice(0, 8)} ${source.ts}  ${source.prompt ?? ""}`
                    );
                }
            }

            out.println(
                `${result.files.length} of ${files.length} files have agent lines; ${result.scanned.logs} logs, ${result.scanned.events} rows, ${result.elapsedMs} ms`
            );
        });
}
