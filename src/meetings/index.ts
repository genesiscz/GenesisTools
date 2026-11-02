import { runTool } from "@genesiscz/utils/cli";
import { Command } from "commander";
import { registerDictionaryCommand } from "./commands/dictionary";
import { registerProjectsCommand } from "./commands/projects";

const program = new Command();
program
    .name("meetings")
    .description(
        "Meetings as one record each: projects, the transcript dictionary, and (to come) recording and review"
    );
registerProjectsCommand(program);
registerDictionaryCommand(program);

await runTool(program, { tool: "meetings" });
