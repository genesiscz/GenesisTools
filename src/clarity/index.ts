import { Command } from "commander";
import { registerConfigureCommand } from "./commands/configure.js";
import { registerFillCommand } from "./commands/fill.js";
import { registerLinkCommand } from "./commands/link-workitems.js";
import { registerTimesheetCommand } from "./commands/timesheet.js";

const program = new Command()
    .name("clarity")
    .description("CA PPM Clarity timesheet management & ADO integration")
    .version("1.0.0");

registerConfigureCommand(program);
registerTimesheetCommand(program);
registerFillCommand(program);
registerLinkCommand(program);

program.parse();
