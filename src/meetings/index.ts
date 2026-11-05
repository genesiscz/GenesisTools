import { runTool } from "@genesiscz/utils/cli";
import { Command } from "commander";
import { registerAssignCommands } from "./commands/assign";
import { registerAttendanceCommand } from "./commands/attendance";
import { registerDictionaryCommand } from "./commands/dictionary";
import { registerEvidenceCommand } from "./commands/evidence";
import { registerItemCommands } from "./commands/items";
import { registerListenCommand } from "./commands/listen";
import { registerMeetingCommands } from "./commands/meeting";
import { registerPlayCommand } from "./commands/play";
import { registerProjectsCommand } from "./commands/projects";
import { registerRecordCommands } from "./commands/record";
import { registerScreenNoteCommand } from "./commands/screen-note";
import { registerWatchCommands } from "./commands/watch";

const program = new Command();
program
    .name("meetings")
    .description("Meetings as one record each: projects, the transcript dictionary, recording and review");
registerMeetingCommands(program);
registerItemCommands(program);
registerEvidenceCommand(program);
registerAttendanceCommand(program);
registerRecordCommands(program);
registerScreenNoteCommand(program);
registerPlayCommand(program);
registerListenCommand(program);
registerWatchCommands(program);
registerProjectsCommand(program);
registerAssignCommands(program);
registerDictionaryCommand(program);

await runTool(program, { tool: "meetings" });
