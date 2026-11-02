import { runTool } from "@genesiscz/utils/cli";
import { Command } from "commander";
import { registerAttendanceCommand } from "./commands/attendance";
import { registerDictionaryCommand } from "./commands/dictionary";
import { registerEvidenceCommand } from "./commands/evidence";
import { registerItemCommands } from "./commands/items";
import { registerListenCommand } from "./commands/listen";
import { registerMeetingCommands } from "./commands/meeting";
import { registerPlayCommand } from "./commands/play";
import { registerProjectsCommand } from "./commands/projects";
import { registerRecordCommands } from "./commands/record";
import { registerWatchCommands } from "./commands/watch";

const program = new Command();
program
    .name("meetings")
    .description(
        "Meetings as one record each: projects, the transcript dictionary, and (to come) recording and review"
    );
registerMeetingCommands(program);
registerItemCommands(program);
registerEvidenceCommand(program);
registerAttendanceCommand(program);
registerRecordCommands(program);
registerPlayCommand(program);
registerListenCommand(program);
registerWatchCommands(program);
registerProjectsCommand(program);
registerDictionaryCommand(program);

await runTool(program, { tool: "meetings" });
