import { resolve } from "node:path";
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

program
    .command("ui")
    .alias("dashboard")
    .description("Launch the Clarity dashboard web UI")
    .action(async () => {
        const uiDir = resolve(import.meta.dirname, "ui");
        const proc = Bun.spawn(["bun", "run", "dev"], {
            cwd: uiDir,
            stdio: ["inherit", "inherit", "inherit"],
            env: { ...process.env, CLARITY_PROJECT_CWD: process.cwd() },
        });

        // Open browser after a short delay
        setTimeout(() => {
            Bun.spawn(["open", "http://localhost:3071"]);
        }, 2000);

        await proc.exited;
    });

program.parse();
