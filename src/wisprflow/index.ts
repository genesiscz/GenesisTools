import { runTool } from "@genesiscz/utils/cli";
import { Command } from "commander";
import { registerCalendarCommand } from "./commands/calendar";
import { registerDoctorCommand } from "./commands/doctor";
import { registerMeetingsCommand } from "./commands/meetings";
import { registerNotesCommand } from "./commands/notes";

const program = new Command();
program.name("wisprflow").description("Wispr Flow meetings, notes and calendar, from the app's local data or its MCP");
registerMeetingsCommand(program);
registerNotesCommand(program);
registerCalendarCommand(program);
registerDoctorCommand(program);

await runTool(program, { tool: "wisprflow" });
