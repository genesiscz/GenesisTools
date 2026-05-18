import { Command } from "commander";
import { registerConfigCommand } from "./commands/config";
import { registerLogCommand } from "./commands/log";
import { registerRecordCommand } from "./commands/record";
import { registerTailCommand } from "./commands/tail";

const program = new Command();
program.name("question").description("Capture & review Q→A fired at agents mid-session");
registerRecordCommand(program);
registerLogCommand(program);
registerTailCommand(program);
registerConfigCommand(program);
// Bare `tools question` → help (not a live tail; tail is Phase 1c).
if (process.argv.slice(2).length === 0) {
    program.outputHelp();
    process.exit(0);
}

program.parseAsync(process.argv).catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
});
