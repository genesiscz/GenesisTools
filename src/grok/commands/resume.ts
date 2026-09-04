import type { Command } from "commander";
import { parseResumeLimit, runGrokTuiResume } from "../lib/tui-resume";

export function registerGrokResumeCommand(program: Command): void {
    program
        .command("resume")
        .description("Resume a grok TUI session by id, title, or content search")
        .argument("[query]", "Session ID prefix, title, or search term")
        .option("-l, --list", "List recent sessions")
        .option("-a, --all", "Search all projects (default: current cwd)")
        .option("-n, --limit <n>", "Number of sessions to show", "20")
        .action(async (query: string | undefined, opts: { list?: boolean; all?: boolean; limit?: string }) => {
            await runGrokTuiResume({
                query,
                list: Boolean(opts.list),
                all: Boolean(opts.all),
                limit: parseResumeLimit(opts.limit),
            });
        });
}
