import { runTool } from "@genesiscz/utils/cli";
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

await runTool(program, { tool: "fsevents" });
