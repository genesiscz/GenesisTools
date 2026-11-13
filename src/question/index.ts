import { runTool } from "@genesiscz/utils/cli";
import { Command } from "commander";
import { QUESTION_REGISTRARS } from "./registrars";

const program = new Command();
program.name("question").description("Ask the user a blocking question, and capture & review Q→A mid-session");

// Bare `tools question` → help (not a live tail; tail is Phase 1c).
await runTool(program, {
    tool: "question",
    registrars: QUESTION_REGISTRARS,
    rewriteArgs: (args) => (args.length === 0 ? ["--help"] : args),
});
