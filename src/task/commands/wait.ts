import { out } from "@app/logger";
import type { Command } from "commander";
import { sessionFilePaths } from "@app/task/lib/paths";
import { waitForSession } from "@app/task/lib/wait-for-session";
import { withResolvedSession } from "@app/task/lib/with-resolved-session";
import { filterLineRecords, lastNLines, readJsonlFile } from "@app/utils/log-session/jsonl-reader";

export function registerWaitCommand(program: Command): void {
    program
        .command("wait")
        .description("Block until session exits or PATTERN appears in stream")
        .option("--session <name>", "Session name (fuzzy-matched)")
        .option("--exit-on-match <pat>", "Exit when PATTERN matches (regex); else wait for session exit")
        .option("--timeout <seconds>", "Deadline before non-zero exit")
        .option("--print-tail <n>", "Print last N lines before exiting", "0")
        .option("--print-exit", "Print 'Session exited (code N)' on exit-path")
        .option("--propagate-exit", "Use child's exit code instead of 0 (only with no --exit-on-match)")
        .action(
            async (opts: {
                session?: string;
                exitOnMatch?: string;
                timeout?: string;
                printTail?: string;
                printExit?: boolean;
                propagateExit?: boolean;
            }) => {
                const globalOpts = program.opts<{ session?: string }>();
                const sessionFlag = opts.session ?? globalOpts.session;

                await withResolvedSession(sessionFlag, async (resolved) => {
                    const result = await waitForSession({
                        session: resolved,
                        exitOnMatch: opts.exitOnMatch ? new RegExp(opts.exitOnMatch) : undefined,
                        timeoutMs: opts.timeout ? Number.parseInt(opts.timeout, 10) * 1000 : undefined,
                        waitForExit: !opts.exitOnMatch,
                    });

                    const printN = Number.parseInt(opts.printTail ?? "0", 10);
                    if (printN > 0) {
                        const records = await readJsonlFile(sessionFilePaths(resolved).jsonl);
                        const tail = lastNLines(filterLineRecords(records), printN);
                        for (const line of tail) {
                            process.stdout.write(`${line.text}\n`);
                        }
                    }

                    if (result.reason === "match") {
                        if (opts.printExit) {
                            out.printlnErr(`Matched: ${result.matchedLine}`);
                        }

                        process.exit(0);
                    }

                    if (result.reason === "session-exit") {
                        if (opts.printExit) {
                            out.printlnErr(`Session exited (code ${result.sessionExitCode ?? "?"}).`);
                        }

                        process.exit(opts.propagateExit ? (result.sessionExitCode ?? 0) : 0);
                    }

                    out.printlnErr(`Timeout after ${opts.timeout}s.`);
                    process.exit(124);
                });
            }
        );
}
