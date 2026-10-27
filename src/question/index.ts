import { runTool } from "@genesiscz/utils/cli";
import { registerRequestedTrees, requestedCommandFromArgv } from "@genesiscz/utils/cli/lazy-registrars";
import { Command } from "commander";
import { QUESTION_REGISTRARS } from "./registrars";

const program = new Command();
program.name("question").description("Ask the user a blocking question, and capture & review Q→A mid-session");
await registerRequestedTrees({
    program,
    registrars: QUESTION_REGISTRARS,
    requested: requestedCommandFromArgv(process.argv),
});
// Bare `tools question` → help (not a live tail; tail is Phase 1c).
if (process.argv.slice(2).length === 0) {
    program.outputHelp();
    process.exit(0);
}

await runTool(program, { tool: "question" }).catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
});
