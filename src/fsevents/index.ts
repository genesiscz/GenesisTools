import { runTool } from "@genesiscz/utils/cli";
import { logger, out } from "@genesiscz/utils/logger";
import { Command } from "commander";
import { registerProfileCommand } from "./commands/profile";

const program = new Command();
program.name("fsevents").description("Inspect macOS file system events");
registerProfileCommand(program);

// Bare `tools fsevents` shows the help instead of sampling.
if (process.argv.slice(2).length === 0) {
    program.outputHelp();
    process.exit(0);
}

await runTool(program, { tool: "fsevents" }).catch((error) => {
    logger.debug({ error }, "fsevents: the command failed");
    out.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
