import type { Command } from "commander";
import { runEntry } from "../lib/mcp/entry";

/** `mcp` hands everything after it to the Jenkins MCP entry: no arguments serve MCP, any other word is its CLI. */
export function registerMcp(jenkins: Command): void {
    jenkins
        .command("mcp")
        .description("The Jenkins MCP server (no arguments) or its CLI: stages, log, monitor, ...")
        .argument("[args...]")
        .allowUnknownOption()
        .helpOption(false)
        .action(async () => {
            await runEntry(process.argv.slice(process.argv.indexOf("mcp") + 1));
        });
}
