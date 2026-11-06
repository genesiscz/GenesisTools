import { runTool } from "@genesiscz/utils/cli";
import { registerRequestedTrees, requestedCommandFromArgv } from "@genesiscz/utils/cli/lazy-registrars";
import { Command } from "commander";
import { MEETINGS_REGISTRARS } from "./registrars";

const program = new Command();
program
    .name("meetings")
    .description("Meetings as one record each: projects, the transcript dictionary, recording and review");
await registerRequestedTrees({
    program,
    registrars: MEETINGS_REGISTRARS,
    requested: requestedCommandFromArgv(process.argv),
});

await runTool(program, { tool: "meetings" });
