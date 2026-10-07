import type { Command } from "commander";
import { runBuildLog } from "../lib/rest/buildLog";

export function registerSearchLogs(jenkins: Command): void {
    jenkins
        .command("search-logs")
        .description("Search a build log (or one pipeline node's) for a regex; prints 'L<n>: <line>' matches")
        .argument("<job-or-url>", "Jenkins job path or build URL (a selected-node URL searches that node)")
        .argument("[build]", "Build number or alias such as lastBuild (default: the build in the URL)")
        .option("-p, --pattern <pattern>", "Search pattern (regex)", "ERROR|FAILURE|Exception")
        .option("--node <id>", "Only this pipeline node's log")
        .action(async (target: string, build: string | undefined, opts: { pattern: string; node?: string }) => {
            await runBuildLog({ target, build, node: opts.node, grep: opts.pattern });
        });
}
