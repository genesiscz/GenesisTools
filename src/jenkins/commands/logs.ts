import type { Command } from "commander";
import { parseLineCount, runBuildLog } from "../lib/rest/buildLog";

export function registerLogs(jenkins: Command): void {
    jenkins
        .command("logs")
        .description("Fetch a build log (or one pipeline node's) and print its end; saves the whole log")
        .argument("<job-or-url>", "Jenkins job path or build URL (a selected-node URL fetches that node)")
        .argument("[build]", "Build number or alias such as lastBuild (default: the build in the URL)")
        .option("--node <id>", "Only this pipeline node's log")
        .option("--tail <n>", "Print the last N lines", parseLineCount, 100)
        .option("--head <n>", "Print the first N lines instead", parseLineCount)
        .action(
            async (target: string, build: string | undefined, opts: { node?: string; tail: number; head?: number }) => {
                await runBuildLog({
                    target,
                    build,
                    node: opts.node,
                    head: opts.head,
                    tail: opts.head === undefined ? opts.tail : undefined,
                });
            }
        );
}
