import { runTool } from "@genesiscz/utils/cli";
import { Command } from "commander";
import { registerAskCommand } from "./commands/ask";
import { registerConfigCommand } from "./commands/config";
import { registerDecisionCommands } from "./commands/decisions";
import { registerInboxCommand } from "./commands/inbox";
import { registerLogCommand } from "./commands/log";
import { registerRecordCommand } from "./commands/record";
import { registerTailCommand } from "./commands/tail";

const program = new Command();
program.name("question").description("Ask the user a blocking question, and capture & review Q→A mid-session");
registerAskCommand(program);
registerDecisionCommands(program);
registerInboxCommand(program);
registerRecordCommand(program);
registerLogCommand(program);
registerTailCommand(program);
registerConfigCommand(program);
// Bare `tools question` → help (not a live tail; tail is Phase 1c).
if (process.argv.slice(2).length === 0) {
    program.outputHelp();
    process.exit(0);
}

await runTool(program, { tool: "question" }).catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
});
